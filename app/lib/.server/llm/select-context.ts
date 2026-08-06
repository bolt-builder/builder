import { generateText, type CoreTool, type GenerateTextResult, type Message } from 'ai';
import { createHash } from 'node:crypto';
import ignore from 'ignore';
import type { IProviderSetting } from '~/types/model';
import { IGNORE_PATTERNS, OPERATION_TOKEN_BUDGETS, type FileMap } from './constants';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROVIDER_LIST } from '~/utils/constants';
import { createFilesContext, extractCurrentContext, extractPropertiesFromMessage, simplifyBoltActions } from './utils';
import { createScopedLogger } from '~/utils/logger';
import { resolveModel } from './resolve-model';
import type { OperationType } from './model-router';

// Common patterns to ignore, similar to .gitignore

const ig = ignore().add(IGNORE_PATTERNS);
const logger = createScopedLogger('select-context');

/** Approximate token count using character-based estimation (1 token ≈ 4 chars). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Per-file token threshold. Files whose content exceeds this limit are
 * summarized to their structural skeleton (imports, exports, function signatures).
 */
const PER_FILE_TOKEN_THRESHOLD = 2000;

/**
 * Produces a compact structural summary of a source file, retaining only
 * import/export statements and function/class/interface/type signatures.
 */
export function summarizeFileContent(content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let insideBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track block comments so we don't accidentally keep them as "signatures"
    if (insideBlockComment) {
      if (trimmed.includes('*/')) {
        insideBlockComment = false;
      }

      continue;
    }

    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) {
        insideBlockComment = true;
      }

      continue;
    }

    // Skip single-line comments and blank lines
    if (trimmed.startsWith('//') || trimmed === '') {
      continue;
    }

    // Keep import and export statements
    if (/^(import\s|export\s)/.test(trimmed)) {
      kept.push(line);
      continue;
    }

    // Keep function / class / interface / type / const+arrow signatures
    if (
      /^(export\s+)?(async\s+)?function\s/.test(trimmed) ||
      /^(export\s+)?(abstract\s+)?class\s/.test(trimmed) ||
      /^(export\s+)?(interface|type)\s/.test(trimmed) ||
      /^(export\s+)?const\s+\w+\s*[:=]/.test(trimmed)
    ) {
      // Include just the signature line (not the body)
      kept.push(line);
      continue;
    }
  }

  return kept.length > 0 ? kept.join('\n') : '// (no extractable signatures)';
}

/**
 * Applies per-operation token budgets to the merged file map.
 * Files that push the total past the budget are summarized or dropped.
 * Returns the budget-constrained file map and counts for logging.
 */
function applyTokenBudget(
  mergedFiles: FileMap,
  inputTokenBudget: number,
): { constrainedFiles: FileMap; includedCount: number; summarizedCount: number } {
  let usedTokens = 0;
  let includedCount = 0;
  let summarizedCount = 0;
  const constrainedFiles: FileMap = {};

  for (const [path, dirent] of Object.entries(mergedFiles)) {
    if (!dirent || dirent.type !== 'file') {
      constrainedFiles[path] = dirent;
      continue;
    }

    const contentTokens = estimateTokens(dirent.content);

    // If this single file exceeds the per-file threshold, summarize it
    if (contentTokens > PER_FILE_TOKEN_THRESHOLD) {
      const summary = summarizeFileContent(dirent.content);
      const summaryTokens = estimateTokens(summary);

      if (usedTokens + summaryTokens <= inputTokenBudget) {
        constrainedFiles[path] = { ...dirent, content: summary };
        usedTokens += summaryTokens;
        includedCount++;
        summarizedCount++;
      }

      // If even the summary exceeds remaining budget, skip the file
      continue;
    }

    // File fits under per-file threshold — include if within budget
    if (usedTokens + contentTokens <= inputTokenBudget) {
      constrainedFiles[path] = dirent;
      usedTokens += contentTokens;
      includedCount++;
    }
  }

  return { constrainedFiles, includedCount, summarizedCount };
}

/**
 * In-memory cache for context selection keyed by a hash of the user's
 * last message + available file paths.  Prevents redundant LLM calls
 * when consecutive messages target the same set of files.
 */
const contextCache = new Map<string, { files: FileMap; timestamp: number }>();
const CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CONTEXT_CACHE_MAX_SIZE = 30;

export async function selectContext(props: {
  messages: Message[];
  env?: Env;
  apiKeys?: Record<string, string>;
  files: FileMap;
  providerSettings?: Record<string, IProviderSetting>;
  promptId?: string;
  contextOptimization?: boolean;
  summary: string;
  operationType?: OperationType;
  onFinish?: (resp: GenerateTextResult<Record<string, CoreTool<any, any>>, never>) => void;
}) {
  const { messages, env: serverEnv, apiKeys, files, providerSettings, summary, operationType, onFinish } = props;
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

  const { codeContext } = extractCurrentContext(processedMessages);

  let filePaths = getFilePaths(files || {});
  filePaths = filePaths.filter((x) => {
    const relPath = x.replace('/home/project/', '');
    return !ig.ignores(relPath);
  });

  let context = '';
  const currentFiles: string[] = [];
  const contextFiles: FileMap = {};

  if (codeContext?.type === 'codeContext') {
    const codeContextFiles: string[] = codeContext.files;
    Object.keys(files || {}).forEach((path) => {
      let relativePath = path;

      if (path.startsWith('/home/project/')) {
        relativePath = path.replace('/home/project/', '');
      }

      if (codeContextFiles.includes(relativePath)) {
        contextFiles[relativePath] = files[path];
        currentFiles.push(relativePath);
      }
    });
    context = createFilesContext(contextFiles);
  }

  const summaryText = `Here is the summary of the chat till now: ${summary}`;

  const extractTextContent = (message: Message) =>
    Array.isArray(message.content)
      ? (message.content.find((item) => item.type === 'text')?.text as string) || ''
      : message.content;

  const lastUserMessage = processedMessages.filter((x) => x.role === 'user').pop();

  if (!lastUserMessage) {
    throw new Error('No user message found');
  }

  // --- Hash-based cache: skip LLM call if same user message + same file list ---
  const cacheInput = extractTextContent(lastUserMessage) + '|' + filePaths.sort().join(',');
  const cacheKey = createHash('sha256').update(cacheInput).digest('hex');

  // Evict stale entries
  for (const [key, entry] of contextCache) {
    if (Date.now() - entry.timestamp > CONTEXT_CACHE_TTL_MS) {
      contextCache.delete(key);
    }
  }

  const cached = contextCache.get(cacheKey);

  if (cached) {
    logger.info(`Context cache HIT — skipping LLM call (hash: ${cacheKey.slice(0, 8)}…)`);

    return cached.files;
  }

  logger.info(`Context cache MISS — calling LLM (hash: ${cacheKey.slice(0, 8)}…)`);

  // select files from the list of code file from the project that might be useful for the current request from the user
  const resp = await generateText({
    system: `
        You are a software engineer. You are working on a project. You have access to the following files:

        AVAILABLE FILES PATHS
        ---
        ${filePaths.map((path) => `- ${path}`).join('\n')}
        ---

        You have following code loaded in the context buffer that you can refer to:

        CURRENT CONTEXT BUFFER
        ---
        ${context}
        ---

        Now, you are given a task. You need to select the files that are relevant to the task from the list of files above.

        RESPONSE FORMAT:
        your response should be in following format:
---
<updateContextBuffer>
    <includeFile path="path/to/file"/>
    <excludeFile path="path/to/file"/>
</updateContextBuffer>
---
        * Your should start with <updateContextBuffer> and end with </updateContextBuffer>.
        * You can include multiple <includeFile> and <excludeFile> tags in the response.
        * You should not include any other text in the response.
        * You should not include any file that is not in the list of files above.
        * You should not include any file that is already in the context buffer.
        * If no changes are needed, you can leave the response empty updateContextBuffer tag.
        `,
    prompt: `
        ${summaryText}

        Users Question: ${extractTextContent(lastUserMessage)}

        update the context buffer with the files that are relevant to the task from the list of files above.

        CRITICAL RULES:
        * Only include relevant files in the context buffer.
        * context buffer should not include any file that is not in the list of files above.
        * context buffer is extremely expensive, so only include files that are absolutely necessary.
        * If no changes are needed, you can leave the response empty updateContextBuffer tag.
        * Only 5 files can be placed in the context buffer at a time.
        * if the buffer is full, you need to exclude files that is not needed and include files that is relevent.

        `,
    model: provider.getModelInstance({
      model: currentModel,
      serverEnv,
      apiKeys,
      providerSettings,
    }),
  });

  const response = resp.text;
  const updateContextBuffer = response.match(/<updateContextBuffer>([\s\S]*?)<\/updateContextBuffer>/);

  if (!updateContextBuffer) {
    throw new Error('Invalid response. Please follow the response format');
  }

  const includeFiles =
    updateContextBuffer[1]
      .match(/<includeFile path="(.*?)"/gm)
      ?.map((x) => x.replace('<includeFile path="', '').replace('"', '')) || [];
  const excludeFiles =
    updateContextBuffer[1]
      .match(/<excludeFile path="(.*?)"/gm)
      ?.map((x) => x.replace('<excludeFile path="', '').replace('"', '')) || [];

  const filteredFiles: FileMap = {};
  excludeFiles.forEach((path) => {
    delete contextFiles[path];
  });
  includeFiles.forEach((path) => {
    let fullPath = path;

    if (!path.startsWith('/home/project/')) {
      fullPath = `/home/project/${path}`;
    }

    if (!filePaths.includes(fullPath)) {
      logger.error(`File ${path} is not in the list of files above.`);
      return;
    }

    if (currentFiles.includes(path)) {
      return;
    }

    filteredFiles[path] = files[fullPath];
  });

  if (onFinish) {
    onFinish(resp);
  }

  // Merge surviving context files with newly included files
  let mergedFiles: FileMap = { ...contextFiles, ...filteredFiles };
  let totalFiles = Object.keys(mergedFiles).length;
  let summarizedCount = 0;

  // Apply per-operation token budget when operationType is provided
  if (operationType && OPERATION_TOKEN_BUDGETS[operationType]) {
    const budget = OPERATION_TOKEN_BUDGETS[operationType];
    const result = applyTokenBudget(mergedFiles, budget.inputTokens);
    mergedFiles = result.constrainedFiles;
    totalFiles = result.includedCount;
    summarizedCount = result.summarizedCount;

    logger.info(
      `Token budget for "${operationType}": ${budget.inputTokens} input tokens — ` +
        `${result.includedCount} files included, ${result.summarizedCount} summarized`,
    );
  } else {
    logger.info(
      `No operation token budget applied — ${totalFiles} files included ` +
        `(${Object.keys(contextFiles).length} existing, ${Object.keys(filteredFiles).length} new)`,
    );
  }

  if (totalFiles === 0) {
    logger.warn('No files selected for context — returning empty context');
  }

  if (summarizedCount > 0) {
    logger.info(`${summarizedCount} large file(s) were summarized to structural skeletons`);
  }

  // Store in cache (evict oldest if over cap)
  if (contextCache.size >= CONTEXT_CACHE_MAX_SIZE) {
    const oldestKey = contextCache.keys().next().value;

    if (oldestKey !== undefined) {
      contextCache.delete(oldestKey);
    }
  }

  contextCache.set(cacheKey, { files: mergedFiles, timestamp: Date.now() });

  return mergedFiles;

  // generateText({
}

export function getFilePaths(files: FileMap) {
  let filePaths = Object.keys(files);
  filePaths = filePaths.filter((x) => {
    const relPath = x.replace('/home/project/', '');
    return !ig.ignores(relPath);
  });

  return filePaths;
}
