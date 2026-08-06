import { generateText, type CoreTool, type GenerateTextResult, type Message } from 'ai';
import { createHash } from 'node:crypto';
import type { IProviderSetting } from '~/types/model';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROVIDER_LIST } from '~/utils/constants';
import { extractCurrentContext, extractPropertiesFromMessage, simplifyBoltActions } from './utils';
import { createScopedLogger } from '~/utils/logger';
import { resolveModel } from './resolve-model';
import type { TokenBudgetState, ContextWindowConfig } from '~/lib/agent/types';

const logger = createScopedLogger('create-summary');

/**
 * In-memory cache for summaries keyed by a hash of sliced message content.
 * Prevents redundant LLM calls when the same messages are reprocessed
 * (e.g. rapid re-sends or continuation requests with identical history).
 */
const summaryCache = new Map<string, { summary: string; timestamp: number }>();
const SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SUMMARY_CACHE_MAX_SIZE = 50; // Cap to prevent unbounded memory growth

export async function createSummary(props: {
  messages: Message[];
  env?: Env;
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
  promptId?: string;
  contextOptimization?: boolean;
  onFinish?: (resp: GenerateTextResult<Record<string, CoreTool<any, any>>, never>) => void;
}) {
  const { messages, env: serverEnv, apiKeys, providerSettings, onFinish } = props;
  let currentModel = DEFAULT_MODEL;
  let currentProvider = DEFAULT_PROVIDER.name;
  const processedMessages = messages.map((message) => {
    if (message.role === 'user') {
      const { model, provider, content } = extractPropertiesFromMessage(message);
      currentModel = model;
      currentProvider = provider;

      return { ...message, content };
    } else if (message.role === 'assistant') {
      let content = message.content;

      content = simplifyBoltActions(content);
      content = content.replace(/<div class=\\"__boltThought__\\">.*?<\/div>/s, '');
      content = content.replace(/<think>.*?<\/think>/s, '');

      return { ...message, content };
    }

    return message;
  });

  const provider = PROVIDER_LIST.find((p) => p.name === currentProvider) || DEFAULT_PROVIDER;
  const resolvedModel = await resolveModel({
    provider,
    currentModel,
    apiKeys,
    providerSettings,
    serverEnv,
    logger,
  });

  // Use resolved model name (may differ from requested if fallback occurred)
  currentModel = resolvedModel.name;

  let slicedMessages = processedMessages;
  const { summary } = extractCurrentContext(processedMessages);
  let summaryText: string | undefined = undefined;
  let chatId: string | undefined = undefined;

  if (summary && summary.type === 'chatSummary') {
    chatId = summary.chatId;
    summaryText = `Below is the Chat Summary till now, this is chat summary before the conversation provided by the user
you should also use this as historical message while providing the response to the user.
${summary.summary}`;

    if (chatId) {
      let index = 0;

      for (let i = 0; i < processedMessages.length; i++) {
        if (processedMessages[i].id === chatId) {
          index = i;
          break;
        }
      }
      slicedMessages = processedMessages.slice(index + 1);
    }
  }

  logger.debug('Sliced Messages:', slicedMessages.length);

  const extractTextContent = (message: Message) =>
    Array.isArray(message.content)
      ? (message.content.find((item) => item.type === 'text')?.text as string) || ''
      : message.content;

  // --- Hash-based cache: skip LLM call if sliced messages + old summary are identical ---
  const cacheInput = (summaryText || '') + slicedMessages.map((m) => `${m.role}:${extractTextContent(m)}`).join('|');
  const cacheKey = createHash('sha256').update(cacheInput).digest('hex');

  // Evict stale entries
  for (const [key, entry] of summaryCache) {
    if (Date.now() - entry.timestamp > SUMMARY_CACHE_TTL_MS) {
      summaryCache.delete(key);
    }
  }

  const cached = summaryCache.get(cacheKey);

  if (cached) {
    logger.info(`Summary cache HIT — skipping LLM call (hash: ${cacheKey.slice(0, 8)}…)`);

    return cached.summary;
  }

  logger.info(`Summary cache MISS — calling LLM (hash: ${cacheKey.slice(0, 8)}…)`);

  // select files from the list of code file from the project that might be useful for the current request from the user
  const resp = await generateText({
    system: `
        You are a software engineer. You are working on a project. you need to summarize the work till now and provide a summary of the chat till now.

        Please only use the following format to generate the summary:
---
# Project Overview
- **Project**: {project_name} - {brief_description}
- **Current Phase**: {phase}
- **Tech Stack**: {languages}, {frameworks}, {key_dependencies}
- **Environment**: {critical_env_details}

# Conversation Context
- **Last Topic**: {main_discussion_point}
- **Key Decisions**: {important_decisions_made}
- **User Context**:
  - Technical Level: {expertise_level}
  - Preferences: {coding_style_preferences}
  - Communication: {preferred_explanation_style}

# Implementation Status
## Current State
- **Active Feature**: {feature_in_development}
- **Progress**: {what_works_and_what_doesn't}
- **Blockers**: {current_challenges}

## Code Evolution
- **Recent Changes**: {latest_modifications}
- **Working Patterns**: {successful_approaches}
- **Failed Approaches**: {attempted_solutions_that_failed}

# Requirements
- **Implemented**: {completed_features}
- **In Progress**: {current_focus}
- **Pending**: {upcoming_features}
- **Technical Constraints**: {critical_constraints}

# Critical Memory
- **Must Preserve**: {crucial_technical_context}
- **User Requirements**: {specific_user_needs}
- **Known Issues**: {documented_problems}

# Next Actions
- **Immediate**: {next_steps}
- **Open Questions**: {unresolved_issues}

---
Note:
4. Keep entries concise and focused on information needed for continuity


---

        RULES:
        * Only provide the whole summary of the chat till now.
        * Do not provide any new information.
        * DO not need to think too much just start writing imidiately
        * do not write any thing other that the summary with with the provided structure
        `,
    prompt: `

Here is the previous summary of the chat:
<old_summary>
${summaryText}
</old_summary>

Below is the chat after that:
---
<new_chats>
${slicedMessages
  .map((x) => {
    return `---\n[${x.role}] ${extractTextContent(x)}\n---`;
  })
  .join('\n')}
</new_chats>
---

Please provide a summary of the chat till now including the hitorical summary of the chat.
`,
    model: provider.getModelInstance({
      model: currentModel,
      serverEnv,
      apiKeys,
      providerSettings,
    }),
  });

  const response = resp.text;

  // Store in cache for future identical requests (evict oldest if over cap)
  if (summaryCache.size >= SUMMARY_CACHE_MAX_SIZE) {
    const oldestKey = summaryCache.keys().next().value;

    if (oldestKey !== undefined) {
      summaryCache.delete(oldestKey);
    }
  }

  summaryCache.set(cacheKey, { summary: response, timestamp: Date.now() });

  if (onFinish) {
    onFinish(resp);
  }

  return response;
}

/*
 * Mid-conversation summarization (Agent Mode v3)
 */

const MID_CONV_CACHE_PREFIX = 'mid-conv:';
const MIN_MESSAGES_FOR_SUMMARY = 6;
const DEFAULT_PRESERVE_LAST_N = 4;

/**
 * Determines whether the current context usage warrants mid-conversation
 * summarization based on the configured threshold.
 *
 * Returns `false` when usage is unknown (`usagePercentage === -1`).
 */
export function shouldSummarize(tokenBudget: TokenBudgetState, config: ContextWindowConfig): boolean {
  if (tokenBudget.usagePercentage === -1) {
    return false;
  }

  return tokenBudget.usagePercentage >= config.thresholdPercentage;
}

/** Options accepted by {@link createMidConversationSummary}. */
export interface MidConversationSummaryOptions {
  env?: Env;
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;

  /** Number of most-recent messages to preserve (not summarized). @default 4 */
  preserveLastN?: number;
}

/** Return value of {@link createMidConversationSummary}. */
export interface MidConversationSummaryResult {
  summary: string;
  messagesRemoved: number;
  originalTokenCount: number;
  summarizedTokenCount: number;
}

/**
 * Extracts text content from a message regardless of its storage format.
 * Works for both plain-string and array-of-parts content fields.
 */
function extractTextContent(message: Message): string {
  return Array.isArray(message.content)
    ? (message.content.find((item) => item.type === 'text')?.text as string) || ''
    : message.content;
}

/**
 * Identifies message indices that belong to the last N agent "steps".
 * A *step* is an assistant message that contains tool invocations (i.e. the
 * agent performed tool calls during that turn).  The returned `Set` contains
 * the indices of those assistant messages so they are never summarised away
 * — keeping tool call results visible for the model's next turn.
 */
function getPinnedToolResultIndices(messages: Message[], stepCount: number): Set<number> {
  const pinned = new Set<number>();
  let found = 0;

  for (let i = messages.length - 1; i >= 0 && found < stepCount; i--) {
    const msg = messages[i];

    if (msg.role === 'assistant' && hasToolInvocations(msg)) {
      pinned.add(i);
      found++;
    }
  }

  return pinned;
}

/**
 * Checks whether a message contains tool invocations, using either the
 * legacy `toolInvocations` array or the newer `parts` array with
 * `'tool-invocation'` entries.
 */
function hasToolInvocations(msg: Message): boolean {
  if (msg.toolInvocations && msg.toolInvocations.length > 0) {
    return true;
  }

  if (msg.parts) {
    return msg.parts.some((p) => p.type === 'tool-invocation');
  }

  return false;
}

/**
 * Creates a mid-conversation summary by summarising older messages while
 * preserving system messages, the most recent N user/assistant messages, and
 * tool-call results from the last 2 agent steps.
 *
 * Returns `null` if there are fewer than {@link MIN_MESSAGES_FOR_SUMMARY}
 * messages — not enough context to justify summarization overhead.
 */
export async function createMidConversationSummary(
  messages: Message[],
  options: MidConversationSummaryOptions = {},
): Promise<MidConversationSummaryResult | null> {
  const { env: serverEnv, apiKeys, providerSettings, preserveLastN = DEFAULT_PRESERVE_LAST_N } = options;

  // Guard: too few messages to warrant summarization
  if (messages.length < MIN_MESSAGES_FOR_SUMMARY) {
    logger.debug(
      `Skipping mid-conversation summary: only ${messages.length} messages (min ${MIN_MESSAGES_FOR_SUMMARY})`,
    );

    return null;
  }

  // ---- Resolve model (mirrors createSummary pattern) ----
  let currentModel = DEFAULT_MODEL;
  let currentProvider = DEFAULT_PROVIDER.name;

  for (const msg of messages) {
    if (msg.role === 'user') {
      const { model, provider } = extractPropertiesFromMessage(msg);
      currentModel = model;
      currentProvider = provider;
    }
  }

  const provider = PROVIDER_LIST.find((p) => p.name === currentProvider) || DEFAULT_PROVIDER;
  const resolvedModel = await resolveModel({
    provider,
    currentModel,
    apiKeys,
    providerSettings,
    serverEnv,
    logger,
  });
  currentModel = resolvedModel.name;

  // ---- Classify messages into buckets ----
  const pinnedStepIndices = getPinnedToolResultIndices(messages, 2);

  // Indices of the last N non-system messages (preserveLastN)
  const preservedTailIndices = new Set<number>();
  let preserved = 0;

  for (let idx = messages.length - 1; idx >= 0 && preserved < preserveLastN; idx--) {
    if (messages[idx].role !== 'system') {
      preservedTailIndices.add(idx);
      preserved++;
    }
  }

  const systemMessages: Message[] = [];
  const candidateMessages: Message[] = [];
  const keptMessages: Message[] = [];

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];

    if (msg.role === 'system') {
      systemMessages.push(msg);
    } else if (preservedTailIndices.has(idx) || pinnedStepIndices.has(idx)) {
      keptMessages.push(msg);
    } else {
      candidateMessages.push(msg);
    }
  }

  // Nothing to summarize — all messages are either pinned, preserved, or system
  if (candidateMessages.length === 0) {
    logger.debug('No candidate messages to summarize after classification');

    return null;
  }

  // ---- Cache lookup ----
  const candidateText = candidateMessages.map((m) => `${m.role}:${extractTextContent(m)}`).join('|');
  const rawCacheKey = createHash('sha256').update(candidateText).digest('hex');
  const cacheKey = `${MID_CONV_CACHE_PREFIX}${rawCacheKey}`;

  // Evict stale entries
  for (const [key, entry] of summaryCache) {
    if (Date.now() - entry.timestamp > SUMMARY_CACHE_TTL_MS) {
      summaryCache.delete(key);
    }
  }

  const cached = summaryCache.get(cacheKey);

  if (cached) {
    logger.info(`Mid-conv summary cache HIT (hash: ${rawCacheKey.slice(0, 8)}…)`);

    const originalTokenEstimate = candidateText.length;
    const summarizedTokenEstimate = cached.summary.length;

    return {
      summary: cached.summary,
      messagesRemoved: candidateMessages.length,
      originalTokenCount: originalTokenEstimate,
      summarizedTokenCount: summarizedTokenEstimate,
    };
  }

  logger.info(
    `Mid-conv summary cache MISS — summarizing ${candidateMessages.length} messages (hash: ${rawCacheKey.slice(0, 8)}…)`,
  );

  // ---- Prepare candidate content for summarization ----
  const processedCandidates = candidateMessages.map((msg) => {
    if (msg.role === 'assistant') {
      let content = extractTextContent(msg);
      content = simplifyBoltActions(content);
      content = content.replace(/<div class=\\"__boltThought__\\">.*?<\/div>/s, '');
      content = content.replace(/<think>.*?<\/think>/s, '');

      return `[${msg.role}] ${content}`;
    }

    return `[${msg.role}] ${extractTextContent(msg)}`;
  });

  // ---- LLM call ----
  const resp = await generateText({
    system: `You are a conversation summarizer for a coding assistant. Summarize the following conversation excerpt concisely, preserving:
- All technical decisions and their rationale
- File paths, function names, and code patterns discussed
- Errors encountered and their resolutions
- User preferences and constraints mentioned
- Current state of the implementation

Keep the summary dense and factual. Do not add commentary.`,
    prompt: `Summarize the following conversation messages:\n\n${processedCandidates.join('\n---\n')}`,
    model: provider.getModelInstance({
      model: currentModel,
      serverEnv,
      apiKeys,
      providerSettings,
    }),
  });

  const summaryText = resp.text;

  // ---- Store in cache ----
  if (summaryCache.size >= SUMMARY_CACHE_MAX_SIZE) {
    const oldestKey = summaryCache.keys().next().value;

    if (oldestKey !== undefined) {
      summaryCache.delete(oldestKey);
    }
  }

  summaryCache.set(cacheKey, { summary: summaryText, timestamp: Date.now() });

  const originalTokenEstimate = candidateText.length;
  const summarizedTokenEstimate = summaryText.length;

  logger.info(
    `Mid-conv summary complete: ${candidateMessages.length} messages removed, ~${originalTokenEstimate} chars → ~${summarizedTokenEstimate} chars`,
  );

  return {
    summary: summaryText,
    messagesRemoved: candidateMessages.length,
    originalTokenCount: originalTokenEstimate,
    summarizedTokenCount: summarizedTokenEstimate,
  };
}
