import { convertToCoreMessages, streamText as _streamText, type Message } from 'ai';
import {
  MAX_TOKENS,
  isReasoningModel,
  getThinkingProviderOptions,
  getCompletionTokenLimit,
  type FileMap,
} from './constants';
import { getFineTunedPrompt } from '~/lib/common/prompts/new-prompt';
import { AGENT_MODE_FULL_SYSTEM_PROMPT } from '~/lib/agent/prompts';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, MODIFICATIONS_TAG_NAME, PROVIDER_LIST, WORK_DIR } from '~/utils/constants';
import type { IProviderSetting } from '~/types/model';
import { PromptLibrary } from '~/lib/common/prompt-library';
import { buildKnowledgeBaseSection } from '~/lib/common/knowledge';
import { allowedHTMLElements } from '~/utils/markdown';
import { createScopedLogger } from '~/utils/logger';
import { createFilesContext, extractPropertiesFromMessage } from './utils';
import { discussPrompt } from '~/lib/common/prompts/discuss-prompt';
import type { DesignScheme } from '~/types/design-scheme';
import { resolveModel } from './resolve-model';
import { LLMManager } from '~/lib/modules/llm/manager';
import {
  resolveModelForOperation,
  parseFallbackModel,
  type OperationType,
  type ModelRoutingConfig,
} from './model-router';
import { runPhasePipeline, buildPhaseEvent, getPhaseNames } from './phase-pipeline';
import type { WebSocket } from 'ws';
import { pushChatEvent } from '~/lib/.server/ws/ws-handlers';
import { isFlutterAvailable } from '~/lib/.server/flutter';
import type { FallbackEvent } from '~/types/api-types';

export type Messages = Message[];

export interface StreamingOptions extends Omit<Parameters<typeof _streamText>[0], 'model'> {
  supabaseConnection?: {
    isConnected: boolean;
    hasSelectedProject: boolean;
    credentials?: {
      anonKey?: string;
      supabaseUrl?: string;
    };
  };
  agentMode?: boolean;
  operationType?: OperationType;
  modelRoutingConfig?: ModelRoutingConfig;
}

const logger = createScopedLogger('stream-text');

/**
 * Categorizes an LLM provider error for fallback decision-making.
 * Only errors that indicate the model/provider is unavailable warrant a fallback attempt.
 */
function categorizeLLMError(error: unknown): FallbackEvent['errorCategory'] {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const status = (error as { status?: number })?.status ?? (error as { statusCode?: number })?.statusCode;

  if (status === 429 || message.includes('rate limit') || message.includes('quota')) {
    return 'rate_limit';
  }

  if (status === 401 || status === 403 || message.includes('unauthorized') || message.includes('api key')) {
    return 'auth_failure';
  }

  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('network')
  ) {
    return 'timeout';
  }

  if (
    status === 404 ||
    (message.includes('not found') && (message.includes('model') || message.includes('models/'))) ||
    message.includes('model_not_found') ||
    message.includes('does not exist') ||
    message.includes('deprecated')
  ) {
    return 'model_not_found';
  }

  if (status !== undefined && status >= 500) {
    return 'provider_error';
  }

  return 'unknown';
}

/**
 * Determines whether an error category warrants a fallback attempt.
 * Client-side errors (bad request, validation) should NOT trigger fallback
 * because the same request will likely fail on any model.
 */
function shouldAttemptFallback(errorCategory: FallbackEvent['errorCategory']): boolean {
  return errorCategory !== 'unknown';
}

// getCompletionTokenLimit is imported from ./constants

/*
 * Essential files whose content the LLM needs to see in the template message.
 * Everything else (shadcn components, etc.) gets replaced with "..." to save tokens.
 */
const ESSENTIAL_FILE_PATTERNS = [
  'package.json',
  'vite.config.ts',
  'vite.config.js',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'tailwind.config.js',
  'tailwind.config.ts',
  'postcss.config.js',
  'postcss.config.mjs',
  'components.json',
  'index.html',
  'src/App.tsx',
  'src/App.jsx',
  'src/main.tsx',
  'src/main.jsx',
  'src/index.tsx',
  'src/index.jsx',
  'src/index.css',
  'src/App.css',
  'src/lib/utils.ts',
  'src/vite-env.d.ts',
  'app/root.tsx',
  'app/entry.client.tsx',
  'app/entry.server.tsx',
  'app/routes/_index.tsx',
  'next.config.js',
  'next.config.ts',
  'next.config.mjs',
  'app/layout.tsx',
  'app/layout.jsx',
  'app/page.tsx',
  'app/page.jsx',
  'app/globals.css',

  // SvelteKit
  'svelte.config.js',
  'src/routes/+page.svelte',
  'src/routes/+layout.svelte',
  'src/app.html',
  'src/app.css',
  'src/app.d.ts',
  'src/App.svelte',

  // Angular
  'angular.json',
  'src/main.ts',
  'src/styles.css',
  'src/styles.scss',
  'src/app/app.component.ts',
  'src/app/app.module.ts',
  'src/app/app-routing.module.ts',
  'src/app/app.config.ts',
  'src/app/app.routes.ts',

  // Vue
  'src/App.vue',
  'src/main.ts',
  'src/main.js',
  'nuxt.config.ts',

  // Astro
  'astro.config.mjs',
  'astro.config.ts',
  'src/pages/index.astro',

  // Expo / React Native
  'App.tsx',
  'App.jsx',
  'app.json',

  // Qwik
  'src/root.tsx',
  'src/routes/index.tsx',
];

function isEssentialFile(filePath: string): boolean {
  return ESSENTIAL_FILE_PATTERNS.some((pattern) => filePath === pattern || filePath.endsWith(`/${pattern}`));
}

/**
 * Simplify non-essential boltAction file contents to reduce token usage.
 * Essential config/entry files keep their full content so the LLM understands the project structure.
 * Lock files are stripped entirely (they're huge and the LLM never needs them).
 * Non-essential files are collapsed into a compact summary line listing their paths.
 */
function simplifyTemplateActions(text: string): string {
  /* Strip lock files entirely — they can be 6000+ lines (~25K tokens) */
  let result = text.replace(
    /<boltAction type="file" filePath="(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)">[\s\S]*?<\/boltAction>/g,
    '',
  );

  /* Collect non-essential file paths and remove their action blocks */
  const nonEssentialPaths: string[] = [];

  result = result.replace(
    /(<boltAction[^>]*type="file"[^>]*filePath="([^"]+)"[^>]*>)([\s\S]*?)(<\/boltAction>)/g,
    (match, _openTag: string, filePath: string, _content: string, _closeTag: string) => {
      if (isEssentialFile(filePath)) {
        return match;
      }

      nonEssentialPaths.push(filePath);

      return '';
    },
  );

  /* Append compact summary of non-essential files before closing artifact tag */
  if (nonEssentialPaths.length > 0) {
    const summary = `\n[Template includes ${nonEssentialPaths.length} additional pre-created files: ${nonEssentialPaths.join(', ')}]\n`;
    const closingTag = '</boltArtifact>';
    const closingIdx = result.lastIndexOf(closingTag);

    if (closingIdx !== -1) {
      result = result.slice(0, closingIdx) + summary + result.slice(closingIdx);
    } else {
      result += summary;
    }
  }

  return result;
}

function sanitizeText(text: string): string {
  let sanitized = text.replace(/<div class=\\"__boltThought__\\">.*?<\/div>/s, '');
  sanitized = sanitized.replace(/<think>.*?<\/think>/s, '');
  sanitized = simplifyTemplateActions(sanitized);

  return sanitized.trim();
}

export async function streamText(props: {
  messages: Omit<Message, 'id'>[];
  env?: Env;
  options?: StreamingOptions;
  apiKeys?: Record<string, string>;
  files?: FileMap;
  providerSettings?: Record<string, IProviderSetting>;
  promptId?: string;
  contextOptimization?: boolean;
  enableThinking?: boolean;
  contextFiles?: FileMap;
  summary?: string;
  messageSliceId?: number;
  chatMode?: 'discuss' | 'build';
  designScheme?: DesignScheme;
  planMode?: boolean;
  operationType?: OperationType;
  modelRoutingConfig?: ModelRoutingConfig;
  phaseWise?: boolean;
  wsConnection?: WebSocket;

  /** Callback invoked for each text delta chunk. Used by api.chat to feed the ServerOutputParser. */
  onTextDelta?: (delta: string) => void;

  /** Callback invoked for each error-validation event from the phase pipeline. Used by api.chat to emit SSE events. */
  onErrorValidation?: (event: import('~/types/streaming-events').ErrorValidationEvent) => void;
}) {
  const {
    messages,
    env: serverEnv,
    options,
    apiKeys,
    files,
    providerSettings,
    promptId,
    contextOptimization,
    contextFiles,
    summary,
    chatMode,
    designScheme,
  } = props;
  const planMode = props.planMode ?? false;
  const enableThinking = props.enableThinking ?? false;
  const operationType = props.operationType;
  const modelRoutingConfig = props.modelRoutingConfig;
  const phaseWise = props.phaseWise ?? false;
  const onTextDelta = props.onTextDelta;
  const onErrorValidation = props.onErrorValidation;

  let currentModel = DEFAULT_MODEL;
  let currentProvider = DEFAULT_PROVIDER.name;
  let processedMessages = messages.map((message) => {
    const newMessage = { ...message };

    if (message.role === 'user') {
      const { model, provider, content } = extractPropertiesFromMessage(message);
      currentModel = model;
      currentProvider = provider;
      newMessage.content = sanitizeText(content);
    } else if (message.role === 'assistant') {
      newMessage.content = sanitizeText(message.content);
    }

    // Sanitize all text parts in parts array, if present
    if (Array.isArray(message.parts)) {
      newMessage.parts = message.parts.map((part) =>
        part.type === 'text' ? { ...part, text: sanitizeText(part.text) } : part,
      );
    }

    return newMessage;
  });

  // Apply per-operation model routing if an operation type is specified
  if (operationType) {
    const routed = resolveModelForOperation(operationType, modelRoutingConfig, currentProvider, currentModel);
    logger.info(`Model routing: operation="${operationType}" → ${routed.provider}/${routed.model}`);
    currentProvider = routed.provider;
    currentModel = routed.model;
  }

  const provider = PROVIDER_LIST.find((p) => p.name === currentProvider) || DEFAULT_PROVIDER;
  const modelDetails = await resolveModel({
    provider,
    currentModel,
    apiKeys,
    providerSettings,
    serverEnv,
    logger,
  });

  const dynamicMaxTokens = modelDetails ? getCompletionTokenLimit(modelDetails) : Math.min(MAX_TOKENS, 16384);

  // Use model-specific limits directly - no artificial cap needed
  const safeMaxTokens = dynamicMaxTokens;

  logger.info(
    `Token limits for model ${modelDetails.name}: maxTokens=${safeMaxTokens}, maxTokenAllowed=${modelDetails.maxTokenAllowed}, maxCompletionTokens=${modelDetails.maxCompletionTokens}`,
  );

  /*
   * Auto-select the compact prompt for very small context windows: the full
   * fine-tuned prompt (~10k tokens) would crowd out code context and output.
   * An explicitly chosen non-default prompt is always respected.
   */
  const SMALL_CONTEXT_THRESHOLD = 16000;
  const effectivePromptId =
    (!promptId || promptId === 'default') && (modelDetails.maxTokenAllowed ?? 128000) <= SMALL_CONTEXT_THRESHOLD
      ? 'compact'
      : promptId || 'default';

  if (effectivePromptId !== (promptId || 'default')) {
    logger.info(
      `Auto-selected compact prompt for small-context model ${modelDetails.name} (context: ${modelDetails.maxTokenAllowed})`,
    );
  }

  let systemPrompt =
    PromptLibrary.getPromptFromLibrary(effectivePromptId, {
      cwd: WORK_DIR,
      allowedHtmlElements: allowedHTMLElements,
      modificationTagName: MODIFICATIONS_TAG_NAME,
      designScheme,
      supabase: {
        isConnected: options?.supabaseConnection?.isConnected || false,
        hasSelectedProject: options?.supabaseConnection?.hasSelectedProject || false,
        credentials: options?.supabaseConnection?.credentials || undefined,
      },
      flutterAvailable: isFlutterAvailable(),
    }) ?? getFineTunedPrompt(WORK_DIR, undefined, undefined, isFlutterAvailable());

  if (chatMode === 'build' && contextFiles && contextOptimization) {
    const codeContext = createFilesContext(contextFiles, true);

    systemPrompt = `${systemPrompt}

    Below is the artifact containing the context loaded into context buffer for you to have knowledge of and might need changes to fullfill current user request.
    CONTEXT BUFFER:
    ---
    ${codeContext}
    ---
    `;

    if (summary) {
      systemPrompt = `${systemPrompt}
      below is the chat history till now
      CHAT SUMMARY:
      ---
      ${props.summary}
      ---
      `;

      if (props.messageSliceId) {
        processedMessages = processedMessages.slice(props.messageSliceId);
      } else {
        const lastMessage = processedMessages.pop();

        if (lastMessage) {
          processedMessages = [lastMessage];
        }
      }
    }
  }

  const effectiveLockedFilePaths = new Set<string>();

  if (files) {
    for (const [filePath, fileDetails] of Object.entries(files)) {
      if (fileDetails?.isLocked) {
        effectiveLockedFilePaths.add(filePath);
      }
    }
  }

  if (effectiveLockedFilePaths.size > 0) {
    const lockedFilesListString = Array.from(effectiveLockedFilePaths)
      .map((filePath) => `- ${filePath}`)
      .join('\n');
    systemPrompt = `${systemPrompt}

    IMPORTANT: The following files are locked and MUST NOT be modified in any way. Do not suggest or make any changes to these files. You can proceed with the request but DO NOT make any changes to these files specifically:
    ${lockedFilesListString}
    ---
    `;
  } else {
    logger.debug('No locked files found from any source for prompt.');
  }

  if (planMode) {
    systemPrompt = `${systemPrompt}

<plan_mode>
## CRITICAL: PLANNING MODE IS ACTIVE — TWO-PHASE WORKFLOW

You are in **Plan Mode**. This is a TWO-PHASE workflow. The user will review your plan before you implement anything.

### PHASE 1 — PLAN ONLY (current phase unless told otherwise)
Your ONLY action is to create a file called \`PLAN.md\` in the project root (\`/home/project/PLAN.md\`).

**Rules (NON-NEGOTIABLE):**
1. Create PLAN.md with a markdown checklist of ALL steps needed to fulfill the request.
2. Each step MUST be a checkbox: \`- [ ] Step description\`
3. Steps should be specific, actionable, and ordered logically.
4. **DO NOT create, modify, or delete ANY other files.**
5. **DO NOT run ANY shell commands.**
6. **DO NOT write ANY code other than PLAN.md.**
7. After creating PLAN.md, STOP. Do not continue with implementation.
8. End your response with: "📋 Plan ready for review. Approve to begin implementation."

### PHASE 2 — EXECUTE (only when user says to execute)
When the user sends a message like "execute the plan", "approved", or "go ahead":
1. Read the existing PLAN.md (the user may have modified it).
2. Implement each step in order, creating/editing files and running commands as needed.
3. After completing each step, update PLAN.md to mark it done: \`- [x] Step description\`
4. Continue until all steps are marked complete.

### Example PLAN.md content:
\`\`\`markdown
# Plan

- [ ] Set up project structure with Vite + React
- [ ] Create main App component with counter state
- [ ] Add increment, decrement, and reset buttons
- [ ] Style the counter component
- [ ] Add basic tests
\`\`\`

**REMEMBER: Right now you are in PHASE 1. Create PLAN.md ONLY. Do NOT implement anything yet.**
</plan_mode>
`;
  }

  // PROJECT.md: Persistent project memory - read from project root if exists
  const projectMemoryPaths = ['/home/project/PROJECT.md', '/home/project/BOLT.md', '/home/project/AGENTS.md'];
  let projectMemoryContent: string | undefined;

  for (const memoryPath of projectMemoryPaths) {
    const memoryFile = files?.[memoryPath];

    if (memoryFile?.type === 'file' && memoryFile.content && memoryFile.content.trim().length > 0) {
      projectMemoryContent = memoryFile.content;
      logger.info(`Loaded project memory from: ${memoryPath}`);
      break;
    }
  }

  if (projectMemoryContent) {
    systemPrompt = `${systemPrompt}

<project_memory>
The following are project-specific instructions from the user's PROJECT.md (or BOLT.md/AGENTS.md) file. You MUST follow these instructions for this project:

${projectMemoryContent}
</project_memory>
`;
  }

  // Knowledge base: user-uploaded reference documents from .bolt/knowledge/
  const knowledgeBaseSection = buildKnowledgeBaseSection(files);

  if (knowledgeBaseSection) {
    logger.info('Injecting knowledge base documents into system prompt');
    systemPrompt = `${systemPrompt}\n\n${knowledgeBaseSection}\n`;
  }

  logger.info(`Sending llm call to ${provider.name} with model ${modelDetails.name}`);

  // Log reasoning model detection and token parameters
  const isReasoning = isReasoningModel(modelDetails.name);
  logger.info(
    `Model "${modelDetails.name}" is reasoning model: ${isReasoning}, using ${isReasoning ? 'maxCompletionTokens' : 'maxTokens'}: ${safeMaxTokens}`,
  );

  // Validate token limits before API call
  if (safeMaxTokens > (modelDetails.maxTokenAllowed || 128000)) {
    logger.warn(
      `Token limit warning: requesting ${safeMaxTokens} tokens but model supports max ${modelDetails.maxTokenAllowed || 128000}`,
    );
  }

  // Use maxCompletionTokens for reasoning models (o1, GPT-5), maxTokens for traditional models
  const tokenParams = isReasoning ? { maxCompletionTokens: safeMaxTokens } : { maxTokens: safeMaxTokens };

  // Build providerOptions for extended thinking (Anthropic / Google)
  let thinkingProviderOptions: ReturnType<typeof getThinkingProviderOptions> | undefined;

  if (enableThinking) {
    thinkingProviderOptions = getThinkingProviderOptions(provider.name, modelDetails.name, safeMaxTokens);

    if (thinkingProviderOptions) {
      logger.info(
        `Extended thinking enabled for ${provider.name}/${modelDetails.name}:`,
        JSON.stringify(thinkingProviderOptions),
      );
    } else {
      logger.info(`Extended thinking requested but not supported for ${provider.name}/${modelDetails.name}`);
    }
  }

  // Filter out unsupported parameters for reasoning models
  const filteredOptions =
    isReasoning && options
      ? Object.fromEntries(
          Object.entries(options).filter(
            ([key]) =>
              ![
                'temperature',
                'topP',
                'presencePenalty',
                'frequencyPenalty',
                'logprobs',
                'topLogprobs',
                'logitBias',
              ].includes(key),
          ),
        )
      : options || {};

  // DEBUG: Log filtered options
  logger.info(
    `DEBUG STREAM: Options filtering for model "${modelDetails.name}":`,
    JSON.stringify(
      {
        isReasoning,
        originalOptions: options || {},
        filteredOptions,
        originalOptionsKeys: options ? Object.keys(options) : [],
        filteredOptionsKeys: Object.keys(filteredOptions),
        removedParams: options ? Object.keys(options).filter((key) => !(key in filteredOptions)) : [],
      },
      null,
      2,
    ),
  );

  /*
   * AGENT MODE: Replace system prompt entirely when agent mode is enabled
   * This ensures the AI uses agent tools instead of artifacts
   */
  if (options?.agentMode) {
    logger.info('🤖 Agent Mode: Using agent-specific system prompt (replacing standard prompt)');
    systemPrompt = AGENT_MODE_FULL_SYSTEM_PROMPT(WORK_DIR);

    // Add context files reference for agent mode
    if (chatMode === 'build' && contextFiles && contextOptimization) {
      /*
       * In agent mode, provide file paths as references instead of full content.
       * The agent can use bolt_read_file to read specific files when needed.
       */
      const fileList = Object.keys(contextFiles);

      if (fileList.length <= 5) {
        // Few files — include full content for efficiency
        const codeContext = createFilesContext(contextFiles, true);
        systemPrompt = `${systemPrompt}

<context_buffer>
Below are the current project files loaded into context:
---
${codeContext}
---
</context_buffer>
`;
      } else {
        // Many files — provide list only, agent can read as needed
        systemPrompt = `${systemPrompt}

<context_buffer>
The following ${fileList.length} project files are available. Use bolt_read_file to read specific files as needed:
${fileList.map((f) => `- ${f}`).join('\n')}
</context_buffer>
`;
      }
    }
  }

  // Filter out empty assistant messages (can occur from aborted requests)
  const cleanedMessages = processedMessages.filter(
    (m) => !(m.role === 'assistant' && typeof m.content === 'string' && !m.content.trim()),
  );

  const streamParams = {
    model: provider.getModelInstance({
      model: modelDetails.name,
      serverEnv,
      apiKeys,
      providerSettings,
    }),
    system: chatMode === 'build' ? systemPrompt : discussPrompt(),
    ...tokenParams,
    messages: convertToCoreMessages(cleanedMessages as any),
    ...filteredOptions,

    // Set temperature to 1 for reasoning models (required by OpenAI API)
    ...(isReasoning ? { temperature: 1 } : {}),

    // Inject provider-specific thinking options (Anthropic thinking / Google thinkingConfig)
    ...(thinkingProviderOptions ? { providerOptions: thinkingProviderOptions } : {}),

    // Wire onTextDelta into the AI SDK's onChunk callback for server-side parsing
    ...(onTextDelta
      ? {
          onChunk: ({ chunk }: { chunk: { type: string; textDelta?: string } }) => {
            if (chunk.type === 'text-delta' && chunk.textDelta) {
              onTextDelta(chunk.textDelta);
            }
          },
        }
      : {}),
  };

  // DEBUG: Log final streaming parameters
  logger.info(
    `DEBUG STREAM: Final streaming params for model "${modelDetails.name}":`,
    JSON.stringify(
      {
        hasTemperature: 'temperature' in streamParams,
        hasMaxTokens: 'maxTokens' in streamParams,
        hasMaxCompletionTokens: 'maxCompletionTokens' in streamParams,
        paramKeys: Object.keys(streamParams).filter((key) => !['model', 'messages', 'system'].includes(key)),
        streamParams: Object.fromEntries(
          Object.entries(streamParams).filter(([key]) => !['model', 'messages', 'system'].includes(key)),
        ),
      },
      null,
      2,
    ),
  );

  // ── Phase-wise pipeline (opt-in) ────────────────────────────────────────
  if (phaseWise) {
    logger.info('Phase-wise pipeline enabled — running 4-phase generation');

    const pipelineResult = await runPhasePipeline({
      getModelInstance: (routedProvider: string, routedModel: string) => {
        const prov = PROVIDER_LIST.find((p) => p.name === routedProvider) || provider;

        return prov.getModelInstance({
          model: routedModel,
          serverEnv,
          apiKeys,
          providerSettings,
        });
      },
      modelRoutingConfig,
      defaultProvider: currentProvider,
      defaultModel: currentModel,
      systemPrompt: typeof streamParams.system === 'string' ? streamParams.system : '',
      messages: processedMessages,
      maxTokens: safeMaxTokens,
    });

    logger.info(
      `Phase pipeline complete: reviewPassed=${pipelineResult.reviewPassed}, ` +
        `correctionRetries=${pipelineResult.correctionRetries}, ` +
        `errorValidationEvents=${pipelineResult.errorValidationEvents.length}`,
    );

    // Forward error-validation events to the SSE stream via the callback
    if (onErrorValidation && pipelineResult.errorValidationEvents.length > 0) {
      for (const event of pipelineResult.errorValidationEvents) {
        onErrorValidation(event);
      }

      logger.info(`Emitted ${pipelineResult.errorValidationEvents.length} error_validation events to SSE stream`);
    }

    // Build a synthetic response that includes phase-event markers and the final output
    const phaseNames = getPhaseNames();
    const parts: string[] = [];

    for (const phase of phaseNames) {
      parts.push(buildPhaseEvent(phase));

      if (phase === 'implement') {
        // Emit the final implementation as the visible output
        parts.push(pipelineResult.output);
      }
    }

    if (!pipelineResult.reviewPassed) {
      parts.push(
        `\n\n<!-- Phase pipeline warning: review did not pass after ${pipelineResult.correctionRetries} correction retries. Output is best-effort. -->`,
      );
    }

    const syntheticText = parts.join('\n');

    /*
     * Return a streamText result that simply emits the pre-generated text.
     * This reuses the same Vercel AI SDK streamText interface so the caller
     * (api.chat.ts) does not need to differentiate between pipeline and
     * single-pass modes.
     */
    const phaseResult = await _streamText({
      ...streamParams,
      messages: convertToCoreMessages([
        { role: 'user', content: 'Return the following text verbatim, with no changes:\n' + syntheticText },
      ] as any),
    });

    if (props.wsConnection) {
      pipeStreamToWebSocket(phaseResult, props.wsConnection);
    }

    return phaseResult;
  }

  // ── Primary call with fallback chain (max 1 fallback attempt) ───────────
  const fallbackRoute = parseFallbackModel(modelDetails);

  let result: Awaited<ReturnType<typeof _streamText>>;

  /*
   * AI SDK v4 wraps certain provider-level HTTP errors (e.g. 404 for
   * deprecated/removed models) into stream error events instead of
   * rejecting the streamText() promise.  This helper probes the first
   * event of the stream and throws if it is an error, enabling the
   * fallback chain to catch deferred provider errors.
   */
  async function probeStreamForErrors(streamResult: Awaited<ReturnType<typeof _streamText>>): Promise<void> {
    /*
     * AI SDK v4's `fullStream` is a GETTER that creates a fresh independent
     * stream copy each time it's accessed (via internal `teeStream('full')`).
     * We grab one copy to peek at the first event; downstream consumers
     * (the monitoring IIFE and `mergeIntoDataStream()`) will each get
     * their own complete copies when they access the getter later.
     */
    const probeStream = streamResult.fullStream;
    const iterator = probeStream[Symbol.asyncIterator]();

    try {
      const first = await iterator.next();

      if (!first.done && first.value?.type === 'error') {
        throw first.value.error ?? new Error('Stream returned an error event');
      }
    } finally {
      /*
       * Always release the probe iterator to prevent resource leaks,
       * whether we succeeded, found an error, or hit an unexpected exception.
       */
      await iterator.return?.();
    }
  }

  try {
    result = await _streamText(streamParams);
    await probeStreamForErrors(result);
  } catch (primaryError: unknown) {
    const errorCategory = categorizeLLMError(primaryError);
    const primaryLabel = `${provider.name}/${modelDetails.name}`;

    logger.error(
      `Primary model ${primaryLabel} failed (${errorCategory}):`,
      primaryError instanceof Error ? primaryError.message : String(primaryError),
    );

    if (!shouldAttemptFallback(errorCategory)) {
      throw primaryError;
    }

    // Determine fallback candidates — use explicit config or auto-select for model_not_found
    const effectiveFallbackRoute = fallbackRoute;

    if (!effectiveFallbackRoute && errorCategory === 'model_not_found') {
      /*
       * No explicit fallback configured — build a list of candidate models to try.
       * Prefer dynamic/cached models (represent actually-available API models)
       * over static list (which may contain deprecated models).
       */
      const llm = LLMManager.getInstance();
      let candidateModels = llm
        .getModelList()
        .filter((m) => m.provider === provider.name && m.name !== modelDetails.name);

      // If the full model list has no alternatives for this provider, fall back to static list
      if (candidateModels.length === 0) {
        candidateModels = llm.getStaticModelListFromProvider(provider).filter((m) => m.name !== modelDetails.name);
      }

      // Try each candidate until one succeeds with stream probing
      for (const candidate of candidateModels) {
        logger.info(`Trying fallback candidate: ${provider.name}/${candidate.name}`);

        try {
          const candidateModelDetails = await resolveModel({
            provider,
            currentModel: candidate.name,
            apiKeys,
            providerSettings,
            serverEnv,
            logger,
          });

          const candidateModelInstance = provider.getModelInstance({
            model: candidateModelDetails.name,
            serverEnv,
            apiKeys,
            providerSettings,
          });

          result = await _streamText({
            ...streamParams,
            model: candidateModelInstance,
          });
          await probeStreamForErrors(result);

          logger.info(
            `Fallback succeeded: ${provider.name}/${candidateModelDetails.name} ` +
              `(primary ${primaryLabel} failed with ${errorCategory})`,
          );

          /*
           * Found a working model — break out of candidate loop and skip the
           * single-route fallback logic below
           */
          if (props.wsConnection) {
            pipeStreamToWebSocket(result, props.wsConnection);
          }

          return result;
        } catch (candidateError: unknown) {
          logger.warn(
            `Fallback candidate ${provider.name}/${candidate.name} failed: ` +
              `${candidateError instanceof Error ? candidateError.message : String(candidateError)}`,
          );

          // Continue to next candidate
        }
      }

      // All candidates exhausted — no effectiveFallbackRoute to try below
      logger.error(`All ${candidateModels.length} fallback candidates for ${provider.name} failed`);
      throw primaryError;
    }

    if (!effectiveFallbackRoute) {
      throw primaryError;
    }

    logger.info(
      `Attempting fallback: ${primaryLabel} → ${effectiveFallbackRoute.provider}/${effectiveFallbackRoute.model}`,
    );

    // Resolve fallback provider + model through the same resolution path as primary
    const fallbackProvider = PROVIDER_LIST.find((p) => p.name === effectiveFallbackRoute!.provider) || DEFAULT_PROVIDER;
    const fallbackModelDetails = await resolveModel({
      provider: fallbackProvider,
      currentModel: effectiveFallbackRoute!.model,
      apiKeys,
      providerSettings,
      serverEnv,
      logger,
    });

    const fallbackModelInstance = fallbackProvider.getModelInstance({
      model: fallbackModelDetails.name,
      serverEnv,
      apiKeys,
      providerSettings,
    });

    try {
      result = await _streamText({
        ...streamParams,
        model: fallbackModelInstance,
      });
      await probeStreamForErrors(result);

      logger.info(
        `Fallback succeeded: ${effectiveFallbackRoute.provider}/${fallbackModelDetails.name} ` +
          `(primary ${primaryLabel} failed with ${errorCategory})`,
      );
    } catch (fallbackError: unknown) {
      logger.error(
        `Fallback model ${effectiveFallbackRoute.provider}/${fallbackModelDetails.name} also failed:`,
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      );

      // Both failed — surface the original primary error to the caller
      throw primaryError;
    }
  }

  if (props.wsConnection) {
    pipeStreamToWebSocket(result, props.wsConnection);
  }

  return result;
}

/**
 * Pipe an AI SDK stream result to a WebSocket connection.
 *
 * Iterates over `fullStream` and sends each chunk as a JSON message
 * using the `chat` message type. Also pushes events to any globally
 * subscribed WebSocket clients via `pushChatEvent`.
 *
 * The SSE path is NOT affected — the caller still receives the stream
 * result and can merge it into an SSE data stream as before.
 */
function pipeStreamToWebSocket(streamResult: Awaited<ReturnType<typeof _streamText>>, ws: WebSocket): void {
  const streamId = `stream-${Date.now()}`;
  const WS_OPEN = 1; // WebSocket.OPEN

  (async () => {
    for await (const part of streamResult.fullStream) {
      if (ws.readyState !== WS_OPEN) {
        logger.debug('WebSocket closed during stream pipe, stopping');
        break;
      }

      const event: {
        streamId: string;
        partType: string;
        textDelta?: string;
        error?: string;
        finished?: boolean;
      } = {
        streamId,
        partType: part.type,
      };

      if (part.type === 'text-delta') {
        event.textDelta = part.textDelta;
      } else if (part.type === 'error') {
        event.error = part.error instanceof Error ? part.error.message : String(part.error);
      }

      // Send directly to the connected client
      try {
        ws.send(JSON.stringify({ type: 'chat', payload: event }));
      } catch {
        logger.debug('Failed to send stream chunk to WebSocket');
        break;
      }

      // Also push to globally subscribed chat clients
      pushChatEvent(event);
    }

    // Send completion marker
    if (ws.readyState === WS_OPEN) {
      const finishEvent = { streamId, partType: 'finish', finished: true };

      try {
        ws.send(JSON.stringify({ type: 'chat', payload: finishEvent }));
      } catch {
        // Client may have disconnected
      }

      pushChatEvent(finishEvent);
    }
  })().catch((err) => {
    logger.error('WebSocket stream pipe error:', err instanceof Error ? err.message : String(err));

    try {
      if (ws.readyState === WS_OPEN || ws.readyState === 0 /* CONNECTING */) {
        ws.close(1011, 'Stream pipe error');
      }
    } catch {
      /* ignore close errors */
    }
  });
}
