/**
 * Agent Tools Service
 *
 * This service provides the core tool implementations for Bolt AI Agent Mode.
 * Tools enable the AI to interact with the runtime filesystem and understand
 * the codebase context for autonomous coding capabilities.
 *
 * Tools follow the Vercel AI SDK format for seamless integration with the chat system.
 */

import { z } from 'zod';
import { runtime } from '~/lib/runtime';
import { createScopedLogger } from '~/utils/logger';
import { autoFixStore } from '~/lib/stores/autofix';
import { parsePlanMd, serializePlanMd } from '~/lib/hooks/usePlanSync';
import { addMemoryEntry, removeMemoryEntry, memoryStore } from '~/lib/stores/agentMemory';
import { serializeMemoryMd } from '~/lib/hooks/useMemorySync';
import type {
  ToolExecutionResult,
  ReadFileParams,
  ReadFileResult,
  WriteFileParams,
  WriteFileResult,
  ListDirectoryParams,
  ListDirectoryResult,
  DirectoryEntry,
  RunCommandParams,
  RunCommandResult,
  GetErrorsParams,
  GetErrorsResult,
  ErrorInfo,
  SearchCodeParams,
  SearchCodeResult,
  SearchMatch,
  AgentToolDefinition,
  SubTaskStatus,
} from '~/lib/agent/types';

const logger = createScopedLogger('AgentTools');

// Lazy import to avoid circular dependencies
let workbenchStoreModule: typeof import('~/lib/stores/workbench') | null = null;

async function getWorkbenchStore() {
  if (!workbenchStoreModule) {
    workbenchStoreModule = await import('~/lib/stores/workbench');
  }

  return workbenchStoreModule.workbenchStore;
}

/*
 * ============================================================================
 * Tool Implementations
 * ============================================================================
 */

/**
 * Validate and normalize a filesystem path to prevent traversal outside the project.
 * Rejects paths containing ".." segments that would escape the working directory.
 */
function validatePath(inputPath: string): { valid: true; normalized: string } | { valid: false; error: string } {
  const segments = inputPath.replace(/\\/g, '/').split('/');

  if (segments.some((s) => s === '..')) {
    return { valid: false, error: `Path traversal not allowed: ${inputPath}` };
  }

  /*
   * Return a relative path (no leading slash). The server-side isSafePath()
   * rejects absolute paths starting with '/' to prevent traversal.
   * Use '.' for root (empty after filtering) — the server resolves it
   * to the project directory.
   */
  const normalized = segments.filter(Boolean).join('/') || '.';

  return { valid: true, normalized };
}

/**
 * Read File Tool
 * Reads the contents of a file from the runtime filesystem.
 */
async function readFile(params: ReadFileParams): Promise<ToolExecutionResult<ReadFileResult>> {
  const { path, startLine, endLine } = params;
  const pathCheck = validatePath(path);

  if (!pathCheck.valid) {
    return { success: false, error: pathCheck.error };
  }

  try {
    const container = await runtime;
    const content = await container.fs.readFile(pathCheck.normalized, 'utf-8');
    const lines = content.split('\n');

    // Handle line range if specified
    let resultContent = content;
    let truncated = false;

    if (startLine !== undefined || endLine !== undefined) {
      const start = (startLine ?? 1) - 1; // Convert to 0-indexed
      const end = endLine ?? lines.length;
      resultContent = lines.slice(start, end).join('\n');
      truncated = start > 0 || end < lines.length;
    }

    logger.debug(`Read file: ${path}`, { lineCount: lines.length, truncated });

    return {
      success: true,
      data: {
        content: resultContent,
        path,
        lineCount: lines.length,
        truncated,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to read file: ${path}`, error);

    return {
      success: false,
      error: `Failed to read file '${path}': ${errorMessage}`,
    };
  }
}

/**
 * Write File Tool
 * Writes content to a file in the runtime filesystem.
 * Creates parent directories if they don't exist.
 */
async function writeFile(params: WriteFileParams): Promise<ToolExecutionResult<WriteFileResult>> {
  const { path, content } = params;
  const pathCheck = validatePath(path);

  if (!pathCheck.valid) {
    return { success: false, error: pathCheck.error };
  }

  const safePath = pathCheck.normalized;

  try {
    const container = await runtime;

    let fileExists = false;

    try {
      await container.fs.readFile(safePath, 'utf-8');
      fileExists = true;
    } catch {
      // File doesn't exist, will be created
    }

    const parentDir = safePath.substring(0, safePath.lastIndexOf('/'));

    if (parentDir) {
      await container.fs.mkdir(parentDir, { recursive: true });
    }

    await container.fs.writeFile(safePath, content);

    logger.info(`Wrote file: ${path}`, {
      bytes: content.length,
      created: !fileExists,
    });

    return {
      success: true,
      data: {
        path,
        bytesWritten: content.length,
        created: !fileExists,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to write file: ${path}`, error);

    return {
      success: false,
      error: `Failed to write file '${path}': ${errorMessage}`,
    };
  }
}

/**
 * List Directory Tool
 * Lists files and subdirectories in a directory.
 * Supports recursive listing with filtering.
 */
async function listDirectory(params: ListDirectoryParams): Promise<ToolExecutionResult<ListDirectoryResult>> {
  const { path = '/', recursive = false, maxDepth = 3 } = params;
  const pathCheck = validatePath(path);

  if (!pathCheck.valid) {
    return { success: false, error: pathCheck.error };
  }

  try {
    const container = await runtime;
    const entries: DirectoryEntry[] = [];

    // Directories to skip during recursive traversal
    const skipDirs = ['node_modules', '.git', '.next', 'dist', 'build', '.cache'];

    async function traverse(dirPath: string, currentDepth: number): Promise<void> {
      const items = await container.fs.readdir(dirPath);

      for (const item of items) {
        const fullPath = dirPath === '.' ? item.name : `${dirPath}/${item.name}`;
        const isDir = item.isDirectory;

        entries.push({
          name: fullPath,
          isDirectory: isDir,
        });

        // Recurse into subdirectories if enabled and within depth limit
        if (recursive && isDir && currentDepth < maxDepth) {
          // Skip common large/irrelevant directories
          if (!skipDirs.includes(item.name) && !item.name.startsWith('.')) {
            await traverse(fullPath, currentDepth + 1);
          }
        }
      }
    }

    await traverse(pathCheck.normalized, 0);

    logger.debug(`Listed directory: ${pathCheck.normalized}`, {
      entryCount: entries.length,
      recursive,
    });

    return {
      success: true,
      data: {
        path,
        entries,
        truncated: false,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to list directory: ${path}`, error);

    return {
      success: false,
      error: `Failed to list directory '${path}': ${errorMessage}`,
    };
  }
}

/**
 * Run Command Tool
 * Executes a shell command using the BoltShell.
 * Requires the terminal to be initialized and ready.
 */
async function runCommand(params: RunCommandParams): Promise<ToolExecutionResult<RunCommandResult>> {
  const { command, cwd, timeout = 30000 } = params;

  try {
    const workbench = await getWorkbenchStore();
    const shell = workbench.boltTerminal;

    // Check if shell is ready
    await shell.ready();

    if (!shell.terminal || !shell.process) {
      return {
        success: false,
        error: 'Terminal is not initialized. The terminal must be attached to run commands.',
      };
    }

    // Build the command with optional cwd (quote the path to handle spaces/metacharacters)
    let fullCommand = command;

    if (cwd) {
      const safeCwd = cwd.replace(/'/g, "'\\''");
      fullCommand = `cd '${safeCwd}' && ${command}`;
    }

    logger.info(`Executing agent command: ${fullCommand}`);

    // Execute with a session ID unique to this agent call
    const sessionId = `agent-${Date.now()}`;

    // Create a timeout promise with cleanup to prevent unhandled rejections
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<null>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Command timed out after ${timeout}ms`)), timeout);
    });

    try {
      // Race between command execution and timeout
      const result = await Promise.race([shell.executeCommand(sessionId, fullCommand), timeoutPromise]);

      clearTimeout(timeoutId!);

      if (!result) {
        return {
          success: false,
          error: 'Command execution returned no result',
        };
      }

      const isSuccess = result.exitCode === 0;

      logger.debug(`Command completed with exit code ${result.exitCode}`, {
        outputLength: result.output?.length,
      });

      return {
        success: true,
        data: {
          exitCode: result.exitCode,
          stdout: isSuccess ? result.output : '',
          stderr: isSuccess ? '' : result.output,
        },
      };
    } finally {
      clearTimeout(timeoutId!);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to execute command: ${command}`, error);

    return {
      success: false,
      error: `Failed to execute command: ${errorMessage}`,
    };
  }
}

/**
 * Get Errors Tool
 * Retrieves current errors from the autofix store and preview error handler.
 */
async function getErrors(params: GetErrorsParams): Promise<ToolExecutionResult<GetErrorsResult>> {
  const { source } = params;

  try {
    const errors: ErrorInfo[] = [];

    // Get errors from autofix store
    const autoFixState = autoFixStore.get();

    if (autoFixState.currentError) {
      const err = autoFixState.currentError;

      // Filter by source if specified ('all' or undefined returns everything)
      if (!source || source === 'all' || err.source === source) {
        errors.push({
          source: err.source,
          type: err.type,
          message: err.message,
          file: undefined,
          line: undefined,
          column: undefined,
          content: err.content,
        });
      }
    }

    /*
     * Note: PreviewErrorHandler doesn't expose a getErrors() method.
     * Preview errors are captured via autoFixStore when they occur.
     */

    logger.debug(`Retrieved errors`, { count: errors.length, source });

    return {
      success: true,
      data: {
        errors,
        count: errors.length,
        hasErrors: errors.length > 0,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to get errors', error);

    return {
      success: false,
      error: `Failed to get errors: ${errorMessage}`,
    };
  }
}

/**
 * Search Code Tool
 * Searches for a text pattern across files in the project.
 */
async function searchCode(params: SearchCodeParams): Promise<ToolExecutionResult<SearchCodeResult>> {
  const {
    query,
    path = '.',
    maxResults = 50,
    includePattern,
    excludePattern,
    filePattern,
    caseSensitive = false,
  } = params;

  // Normalize the search root to a relative path (e.g. '/' → '.')
  const pathCheck = validatePath(path);

  if (!pathCheck.valid) {
    return { success: false, error: pathCheck.error };
  }

  const searchRoot = pathCheck.normalized;

  try {
    const container = await runtime;
    const results: SearchMatch[] = [];
    let totalMatches = 0;

    // Validate include/exclude regex patterns early — fall back to null if invalid
    let validatedIncludePattern: RegExp | null = null;
    let validatedExcludePattern: RegExp | null = null;

    if (includePattern) {
      try {
        validatedIncludePattern = new RegExp(includePattern);
      } catch {
        logger.warn(`Invalid includePattern regex: "${includePattern}", ignoring`);
      }
    }

    if (excludePattern) {
      try {
        validatedExcludePattern = new RegExp(excludePattern);
      } catch {
        logger.warn(`Invalid excludePattern regex: "${excludePattern}", ignoring`);
      }
    }

    /*
     * Compile the search regex ONCE before entering the file loop.
     * If the query is an invalid regex, fall back to literal string matching.
     */
    let searchRegex: RegExp | null = null;

    try {
      searchRegex = new RegExp(query, caseSensitive ? '' : 'i');
    } catch {
      // Invalid regex — searchRegex stays null, literal match used below
    }

    // File extensions to search
    const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.md', '.yaml', '.yml'];

    // Directories to skip
    const skipDirs = ['node_modules', '.git', '.next', 'dist', 'build', '.cache'];

    async function searchInDirectory(dirPath: string): Promise<void> {
      if (totalMatches >= maxResults) {
        return;
      }

      const items = await container.fs.readdir(dirPath);

      for (const item of items) {
        if (totalMatches >= maxResults) {
          break;
        }

        const fullPath = dirPath === '.' ? item.name : `${dirPath}/${item.name}`;

        if (item.isDirectory) {
          // Skip excluded directories
          if (!skipDirs.includes(item.name) && !item.name.startsWith('.')) {
            // Check exclude pattern
            if (validatedExcludePattern && validatedExcludePattern.test(fullPath)) {
              continue;
            }

            await searchInDirectory(fullPath);
          }
        } else {
          // Check if file should be searched
          const ext = item.name.substring(item.name.lastIndexOf('.'));

          // If filePattern is specified, only search files matching the pattern
          if (filePattern) {
            const matchesPattern = filePattern.split(',').some((p) => {
              const trimmed = p.trim();

              if (trimmed.startsWith('.')) {
                return ext === trimmed;
              }

              if (trimmed.startsWith('*')) {
                return item.name.endsWith(trimmed.slice(1));
              }

              return item.name === trimmed || item.name.endsWith(trimmed);
            });

            if (!matchesPattern) {
              continue;
            }
          } else if (!codeExtensions.includes(ext)) {
            continue;
          }

          // Check include/exclude patterns
          if (validatedIncludePattern && !validatedIncludePattern.test(fullPath)) {
            continue;
          }

          if (validatedExcludePattern && validatedExcludePattern.test(fullPath)) {
            continue;
          }

          // Search in file
          try {
            const content = await container.fs.readFile(fullPath, 'utf-8');
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
              if (totalMatches >= maxResults) {
                break;
              }

              // Use pre-compiled regex, fall back to literal match
              let isMatch = false;

              if (searchRegex) {
                isMatch = searchRegex.test(lines[i]);
              } else {
                isMatch = caseSensitive
                  ? lines[i].includes(query)
                  : lines[i].toLowerCase().includes(query.toLowerCase());
              }

              if (isMatch) {
                // Calculate match positions
                let matchStart = 0;
                let matchEnd = 0;

                if (searchRegex) {
                  const regexMatch = lines[i].match(searchRegex);

                  if (regexMatch && regexMatch.index !== undefined) {
                    matchStart = regexMatch.index;
                    matchEnd = regexMatch.index + regexMatch[0].length;
                  }
                } else {
                  matchStart = caseSensitive
                    ? lines[i].indexOf(query)
                    : lines[i].toLowerCase().indexOf(query.toLowerCase());
                  matchEnd = matchStart + query.length;
                }

                results.push({
                  file: fullPath,
                  line: i + 1,
                  content: lines[i].trim(),
                  matchStart,
                  matchEnd,
                });
                totalMatches++;
              }
            }
          } catch {
            // Skip files that can't be read
          }
        }
      }
    }

    await searchInDirectory(searchRoot);

    logger.debug(`Search completed for: ${query}`, { matchCount: results.length });

    return {
      success: true,
      data: {
        query,
        results,
        matchCount: results.length,
        truncated: totalMatches >= maxResults,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to search code for: ${query}`, error);

    return {
      success: false,
      error: `Failed to search code: ${errorMessage}`,
    };
  }
}

/**
 * Delete File Tool
 * Deletes a file or directory from the runtime filesystem.
 */
async function deleteFile(params: {
  path: string;
  recursive?: boolean;
}): Promise<ToolExecutionResult<{ path: string; deleted: boolean }>> {
  const { path, recursive = false } = params;
  const pathCheck = validatePath(path);

  if (!pathCheck.valid) {
    return { success: false, error: pathCheck.error };
  }

  const safePath = pathCheck.normalized;

  try {
    const container = await runtime;

    try {
      const entries = await container.fs.readdir(safePath);

      if (recursive) {
        await container.fs.rm(safePath, { recursive: true });
      } else {
        if (entries.length > 0) {
          return {
            success: false,
            error: `Directory '${safePath}' is not empty. Use recursive: true to delete non-empty directories.`,
          };
        }

        await container.fs.rm(safePath);
      }
    } catch {
      await container.fs.rm(safePath);
    }

    logger.info(`Deleted: ${safePath}`, { recursive });

    return {
      success: true,
      data: {
        path,
        deleted: true,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to delete: ${path}`, error);

    return {
      success: false,
      error: `Failed to delete '${path}': ${errorMessage}`,
    };
  }
}

/**
 * Rename/Move File Tool
 * Renames or moves a file in the runtime filesystem.
 */
async function renameFile(params: {
  oldPath: string;
  newPath: string;
}): Promise<ToolExecutionResult<{ oldPath: string; newPath: string; renamed: boolean }>> {
  const { oldPath, newPath } = params;

  const oldPathCheck = validatePath(oldPath);

  if (!oldPathCheck.valid) {
    return { success: false, error: oldPathCheck.error };
  }

  const newPathCheck = validatePath(newPath);

  if (!newPathCheck.valid) {
    return { success: false, error: newPathCheck.error };
  }

  const safeOldPath = oldPathCheck.normalized;
  const safeNewPath = newPathCheck.normalized;

  try {
    const container = await runtime;

    // Read the source file
    const content = await container.fs.readFile(safeOldPath, 'utf-8');

    // Ensure parent directory of destination exists
    const parentDir = safeNewPath.substring(0, safeNewPath.lastIndexOf('/'));

    if (parentDir) {
      await container.fs.mkdir(parentDir, { recursive: true });
    }

    // Write to new location
    await container.fs.writeFile(safeNewPath, content);

    // Delete old file
    await container.fs.rm(safeOldPath);

    logger.info(`Renamed: ${oldPath} → ${newPath}`);

    return {
      success: true,
      data: {
        oldPath,
        newPath,
        renamed: true,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to rename: ${oldPath} → ${newPath}`, error);

    return {
      success: false,
      error: `Failed to rename '${oldPath}' to '${newPath}': ${errorMessage}`,
    };
  }
}

/**
 * Patch File Tool
 * Makes targeted text replacements in a file without rewriting the entire content.
 * More efficient than bolt_write_file for small changes.
 */
async function patchFile(params: {
  path: string;
  replacements: Array<{ oldText: string; newText: string }>;
}): Promise<ToolExecutionResult<{ path: string; replacementsApplied: number; totalReplacements: number }>> {
  const { path, replacements } = params;
  const pathCheck = validatePath(path);

  if (!pathCheck.valid) {
    return { success: false, error: pathCheck.error };
  }

  const safePath = pathCheck.normalized;

  try {
    const container = await runtime;
    let content = await container.fs.readFile(safePath, 'utf-8');
    let applied = 0;

    for (const { oldText, newText } of replacements) {
      if (content.includes(oldText)) {
        content = content.replace(oldText, newText);
        applied++;
      }
    }

    if (applied === 0) {
      return {
        success: false,
        error: `No replacements matched in '${path}'. Verify the oldText strings are exact matches.`,
      };
    }

    await container.fs.writeFile(safePath, content);

    logger.info(`Patched file: ${path}`, { applied, total: replacements.length });

    return {
      success: true,
      data: {
        path,
        replacementsApplied: applied,
        totalReplacements: replacements.length,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to patch file: ${path}`, error);

    return {
      success: false,
      error: `Failed to patch file '${path}': ${errorMessage}`,
    };
  }
}

/*
 * ============================================================================
 * Zod Validation Schemas
 * ============================================================================
 */

/** Zod schema for bolt_update_plan parameters (discriminated union on action) */
const updatePlanSchema = z.discriminatedUnion('action', [
  z.object({
    taskId: z.string(),
    action: z.literal('add-subtask'),
    subTasks: z.array(
      z.object({
        title: z.string(),
        status: z.string().optional(),
      }),
    ),
  }),
  z.object({
    taskId: z.string(),
    action: z.literal('update-status'),
    status: z.enum(['not-started', 'in-progress', 'completed']),
  }),
  z.object({
    taskId: z.string(),
    action: z.literal('set-dependencies'),
    dependsOn: z.array(z.string()),
  }),
]);

/** Zod schema for bolt_save_memory parameters (discriminated union on action) */
const saveMemorySchema = z.discriminatedUnion('action', [
  z.object({
    category: z.string(),
    key: z.string(),
    value: z.string(),
    action: z.literal('save'),
  }),
  z.object({
    category: z.string(),
    key: z.string(),
    action: z.literal('delete'),
  }),
]);

/*
 * ============================================================================
 * Update Plan & Save Memory Implementations
 * ============================================================================
 */

/** Relative path for PLAN.md inside the WebContainer project root */
const PLAN_MD_RELATIVE = 'PLAN.md';

/** Relative path for MEMORY.md inside the WebContainer project root */
const MEMORY_MD_RELATIVE = 'MEMORY.md';

/**
 * Update Plan Tool
 * Reads PLAN.md, applies a structured update to a specific task, and writes it back.
 * Uses serializePlanMd for safe round-trip serialization — never builds markdown manually.
 */
async function updatePlan(
  params: Record<string, unknown>,
): Promise<ToolExecutionResult<{ taskId: string; action: string; detail: string }>> {
  const parsed = updatePlanSchema.safeParse(params);

  if (!parsed.success) {
    return { success: false, error: `Invalid parameters: ${parsed.error.message}` };
  }

  const { taskId, action } = parsed.data;

  try {
    const container = await runtime;

    // Read current PLAN.md
    let planContent: string;

    try {
      planContent = await container.fs.readFile(PLAN_MD_RELATIVE, 'utf-8');
    } catch {
      return { success: false, error: 'PLAN.md not found. Create a plan first.' };
    }

    // Parse into structured data
    const { title, tasks } = parsePlanMd(planContent);

    // Find the target task
    const taskIndex = tasks.findIndex((t) => t.id === taskId);

    if (taskIndex === -1) {
      const validIds = tasks.map((t) => t.id).join(', ');
      return { success: false, error: `Task "${taskId}" not found in PLAN.md. Valid IDs: ${validIds}` };
    }

    // Clone the task for mutation
    const task = { ...tasks[taskIndex] };
    let detail: string;

    switch (action) {
      case 'add-subtask': {
        const { subTasks: newSubTasks } = parsed.data;
        const existing = task.subTasks ? [...task.subTasks] : [];
        const additions = newSubTasks.map((st, i) => ({
          id: `${taskId}-sub-${existing.length + i}`,
          title: st.title,
          status: (st.status as SubTaskStatus) || ('pending' as const),
          parentTaskId: taskId,
          depth: 1 as const,
        }));
        task.subTasks = [...existing, ...additions];
        detail = `Added ${additions.length} sub-task(s) to "${task.title}"`;
        break;
      }

      case 'update-status': {
        const { status } = parsed.data;
        const previousStatus = task.status;
        task.status = status;
        detail = `Updated "${task.title}" status: ${previousStatus} → ${status}`;
        break;
      }

      case 'set-dependencies': {
        const { dependsOn } = parsed.data;

        // Validate that referenced task IDs exist
        const validIds = new Set(tasks.map((t) => t.id));
        const invalidIds = dependsOn.filter((id) => !validIds.has(id));

        if (invalidIds.length > 0) {
          return {
            success: false,
            error: `Invalid dependency IDs: ${invalidIds.join(', ')}. Valid IDs: ${[...validIds].join(', ')}`,
          };
        }

        // Prevent self-dependency
        if (dependsOn.includes(taskId)) {
          return { success: false, error: `Task "${taskId}" cannot depend on itself.` };
        }

        task.dependsOn = dependsOn;
        detail = `Set dependencies for "${task.title}": [${dependsOn.join(', ')}]`;
        break;
      }
    }

    // Replace task in array and serialize
    const updatedTasks = [...tasks];
    updatedTasks[taskIndex] = task;

    const newContent = serializePlanMd(title, updatedTasks);
    await container.fs.writeFile(PLAN_MD_RELATIVE, newContent);

    logger.info(`Updated plan task ${taskId}: ${action}`, { detail });

    return {
      success: true,
      data: { taskId, action, detail },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to update plan task "${taskId}"`, error);

    return { success: false, error: `Failed to update plan: ${errorMessage}` };
  }
}

/**
 * Save Memory Tool
 * Saves or deletes a memory entry and persists the change to MEMORY.md.
 * Uses the agentMemory store for in-memory state and serializeMemoryMd for file output.
 */
async function saveMemory(
  params: Record<string, unknown>,
): Promise<ToolExecutionResult<{ category: string; key: string; action: string }>> {
  const parsed = saveMemorySchema.safeParse(params);

  if (!parsed.success) {
    return { success: false, error: `Invalid parameters: ${parsed.error.message}` };
  }

  const { category, key, action } = parsed.data;

  try {
    if (action === 'save') {
      const { value } = parsed.data;
      addMemoryEntry(category, key, value);
      logger.info(`Memory saved: ${category}/${key}`);
    } else {
      const removed = removeMemoryEntry(category, key);

      if (!removed) {
        return { success: false, error: `Memory entry "${category}/${key}" not found.` };
      }

      logger.info(`Memory deleted: ${category}/${key}`);
    }

    // Persist to MEMORY.md
    const container = await runtime;
    const content = serializeMemoryMd(memoryStore.get());
    await container.fs.writeFile(MEMORY_MD_RELATIVE, content);

    return {
      success: true,
      data: { category, key, action },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to ${action} memory entry "${category}/${key}"`, error);

    return { success: false, error: `Failed to ${action} memory: ${errorMessage}` };
  }
}

/*
 * ============================================================================
 * Tool Definitions
 * ============================================================================
 */

/**
 * Agent tool definitions following Vercel AI SDK format.
 * Each tool has a name, description, parameters schema, and execute function.
 */
export const agentToolDefinitions: Record<string, AgentToolDefinition> = {
  bolt_read_file: {
    name: 'bolt_read_file',
    description:
      'Read the contents of a file from the project. Use this to examine existing code, configuration files, or any text file. Supports reading specific line ranges for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute path to the file to read (e.g., "/src/App.tsx")',
        },
        startLine: {
          type: 'number',
          description: 'Optional: Starting line number (1-indexed) for partial reads',
        },
        endLine: {
          type: 'number',
          description: 'Optional: Ending line number (inclusive) for partial reads',
        },
      },
      required: ['path'],
    },
    execute: readFile as unknown as (args: Record<string, unknown>) => Promise<ToolExecutionResult<unknown>>,
  },

  bolt_write_file: {
    name: 'bolt_write_file',
    description:
      'Write content to a file in the project. Creates the file if it does not exist, or overwrites if it does. Parent directories are created automatically. Use this to create new files or update existing ones.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute path where the file should be written (e.g., "/src/components/Button.tsx")',
        },
        content: {
          type: 'string',
          description: 'The complete content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
    execute: writeFile as unknown as (args: Record<string, unknown>) => Promise<ToolExecutionResult<unknown>>,
  },

  bolt_list_directory: {
    name: 'bolt_list_directory',
    description:
      'List all files and subdirectories in a directory. Use this to explore the project structure and find files. Supports recursive listing with configurable depth.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute path to the directory to list (defaults to "/")',
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to list contents recursively (default: false)',
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum depth for recursive listing (default: 3)',
        },
      },
      required: [],
    },
    execute: listDirectory,
  },

  bolt_run_command: {
    name: 'bolt_run_command',
    description:
      'Execute a shell command in the project environment. Use this to run build commands, install dependencies, run tests, or execute scripts.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute (e.g., "npm install", "npm run build")',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command (defaults to project root)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000, max: 120000)',
        },
      },
      required: ['command'],
    },
    execute: runCommand as unknown as (args: Record<string, unknown>) => Promise<ToolExecutionResult<unknown>>,
  },

  bolt_get_errors: {
    name: 'bolt_get_errors',
    description:
      'Get current errors from the development environment. This includes terminal errors, build errors, and runtime errors from the preview. Use this to understand what needs to be fixed.',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: ['terminal', 'preview', 'build', 'all'],
          description: 'Filter errors by source. Use "all" or omit to return errors from all sources.',
        },
      },
      required: [],
    },
    execute: getErrors,
  },

  bolt_search_code: {
    name: 'bolt_search_code',
    description:
      'Search for a text pattern across files in the project. Use this to find where specific functions, variables, imports, or patterns are used. Searches common code file types by default.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The text pattern to search for',
        },
        path: {
          type: 'string',
          description: 'Directory path to search in (defaults to "/" for entire project)',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return (default: 50)',
        },
        includePattern: {
          type: 'string',
          description: 'Regex pattern to include only matching file paths',
        },
        excludePattern: {
          type: 'string',
          description: 'Regex pattern to exclude matching file paths',
        },
        filePattern: {
          type: 'string',
          description:
            'Comma-separated file extensions or patterns to search (e.g., ".tsx,.ts" or "*.css"). Defaults to common code extensions.',
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Whether the search is case-sensitive (default: false)',
        },
      },
      required: ['query'],
    },
    execute: searchCode as unknown as (args: Record<string, unknown>) => Promise<ToolExecutionResult<unknown>>,
  },

  bolt_delete_file: {
    name: 'bolt_delete_file',
    description:
      'Delete a file or directory from the project. Use this to remove files that are no longer needed. For non-empty directories, set recursive to true.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute path to the file or directory to delete (e.g., "/src/old-component.tsx")',
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to recursively delete directory contents (default: false)',
        },
      },
      required: ['path'],
    },
    execute: deleteFile as unknown as (args: Record<string, unknown>) => Promise<ToolExecutionResult<unknown>>,
  },

  bolt_rename_file: {
    name: 'bolt_rename_file',
    description:
      'Rename or move a file to a new location. Creates parent directories automatically. Use this instead of shell mv commands.',
    parameters: {
      type: 'object',
      properties: {
        oldPath: {
          type: 'string',
          description: 'The current absolute path of the file (e.g., "/src/OldName.tsx")',
        },
        newPath: {
          type: 'string',
          description: 'The new absolute path for the file (e.g., "/src/NewName.tsx")',
        },
      },
      required: ['oldPath', 'newPath'],
    },
    execute: renameFile as unknown as (args: Record<string, unknown>) => Promise<ToolExecutionResult<unknown>>,
  },

  bolt_patch_file: {
    name: 'bolt_patch_file',
    description:
      'Make targeted text replacements in a file without rewriting the entire content. More efficient than bolt_write_file for small changes. Each replacement finds the exact oldText and replaces it with newText.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute path to the file to patch (e.g., "/src/App.tsx")',
        },
        replacements: {
          type: 'array',
          description: 'Array of {oldText, newText} objects. Each oldText must be an exact match in the file.',
          items: {
            type: 'object',
            properties: {
              oldText: {
                type: 'string',
                description: 'The exact text to find and replace',
              },
              newText: {
                type: 'string',
                description: 'The replacement text',
              },
            },
            required: ['oldText', 'newText'],
          },
        },
      },
      required: ['path', 'replacements'],
    },
    execute: patchFile as unknown as (args: Record<string, unknown>) => Promise<ToolExecutionResult<unknown>>,
  },

  bolt_update_plan: {
    name: 'bolt_update_plan',
    description:
      "Update the project plan (PLAN.md). Supports adding sub-tasks to a task, updating a task's status, or setting task dependencies. Always reads the current plan, applies the change, and writes it back atomically.",
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The ID of the plan task to update (e.g., "plan-task-0")',
        },
        action: {
          type: 'string',
          enum: ['add-subtask', 'update-status', 'set-dependencies'],
          description:
            'The type of update to perform. "add-subtask" adds sub-tasks, "update-status" changes task status, "set-dependencies" sets dependency IDs.',
        },
        subTasks: {
          type: 'array',
          description:
            'Sub-tasks to add (required when action is "add-subtask"). Each entry needs a title and optional status.',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Title of the sub-task',
              },
              status: {
                type: 'string',
                description: 'Initial status of the sub-task (default: "pending")',
              },
            },
            required: ['title'],
          },
        },
        status: {
          type: 'string',
          enum: ['not-started', 'in-progress', 'completed'],
          description: 'New status for the task (required when action is "update-status")',
        },
        dependsOn: {
          type: 'array',
          description: 'Array of task IDs this task depends on (required when action is "set-dependencies")',
          items: {
            type: 'string',
          },
        },
      },
      required: ['taskId', 'action'],
    },
    execute: updatePlan as unknown as (args: Record<string, unknown>) => Promise<ToolExecutionResult<unknown>>,
  },

  bolt_save_memory: {
    name: 'bolt_save_memory',
    description:
      'Save or delete a memory entry in MEMORY.md. Use "save" to store a key-value pair under a category, or "delete" to remove an entry. Memory persists across conversations for long-term context.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Category grouping for the memory entry (e.g., "preference", "pattern", "decision")',
        },
        key: {
          type: 'string',
          description: 'Unique key identifying this memory entry within its category',
        },
        value: {
          type: 'string',
          description: 'The value/summary to store (required when action is "save", omit for "delete")',
        },
        action: {
          type: 'string',
          enum: ['save', 'delete'],
          description: 'Whether to save (create/update) or delete the memory entry',
        },
      },
      required: ['category', 'key', 'action'],
    },
    execute: saveMemory as unknown as (args: Record<string, unknown>) => Promise<ToolExecutionResult<unknown>>,
  },
};

/*
 * ============================================================================
 * Public API
 * ============================================================================
 */

/**
 * Get all agent tools with execute functions.
 * Use this when registering tools with the AI SDK.
 */
export function getAgentTools(): Record<
  string,
  {
    description: string;
    parameters: AgentToolDefinition['parameters'];
    execute: (args: unknown) => Promise<ToolExecutionResult<unknown>>;
  }
> {
  const tools: Record<
    string,
    {
      description: string;
      parameters: AgentToolDefinition['parameters'];
      execute: (args: unknown) => Promise<ToolExecutionResult<unknown>>;
    }
  > = {};

  for (const [name, def] of Object.entries(agentToolDefinitions)) {
    tools[name] = {
      description: def.description,
      parameters: def.parameters,
      execute: def.execute as (args: unknown) => Promise<ToolExecutionResult<unknown>>,
    };
  }

  return tools;
}

/**
 * Get agent tools without execute functions.
 * Use this for serialization or sending to the client.
 */
export function getAgentToolsWithoutExecute(): Record<
  string,
  {
    description: string;
    parameters: AgentToolDefinition['parameters'];
  }
> {
  const tools: Record<
    string,
    {
      description: string;
      parameters: AgentToolDefinition['parameters'];
    }
  > = {};

  for (const [name, def] of Object.entries(agentToolDefinitions)) {
    tools[name] = {
      description: def.description,
      parameters: def.parameters,
    };
  }

  return tools;
}

/**
 * Execute a specific agent tool by name.
 * Use this for dynamic tool invocation.
 */
export async function executeAgentTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult<unknown>> {
  const tool = agentToolDefinitions[toolName];

  if (!tool) {
    logger.error(`Unknown agent tool: ${toolName}`);

    return {
      success: false,
      error: `Unknown tool: ${toolName}`,
    };
  }

  logger.info(`Executing agent tool: ${toolName}`, { args });

  try {
    const result = await tool.execute(args as never);
    logger.debug(`Tool ${toolName} completed`, { success: result.success });

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Tool ${toolName} failed with exception`, error);

    return {
      success: false,
      error: `Tool execution failed: ${errorMessage}`,
    };
  }
}

/**
 * Get list of available agent tool names.
 */
export function getAgentToolNames(): string[] {
  return Object.keys(agentToolDefinitions);
}

/**
 * Check if a tool name is a valid agent tool.
 */
export function isAgentTool(toolName: string): boolean {
  return toolName in agentToolDefinitions;
}

/*
 * ============================================================================
 * Parallel Batch Execution
 * ============================================================================
 */

/**
 * Tools that are safe to execute concurrently (read-only, no side effects).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'bolt_read_file',
  'bolt_list_directory',
  'bolt_search_code',
  'bolt_get_errors',
]);

/**
 * Check whether a tool name is read-only (safe for parallel execution).
 */
export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName);
}

/**
 * Result of a single tool within a parallel batch.
 */
export interface BatchToolResult {
  name: string;
  result: ToolExecutionResult<unknown>;
}

/**
 * Execute a batch of tool calls.
 *
 * When **all** tools in the batch belong to {@link READ_ONLY_TOOLS} they run
 * concurrently via `Promise.allSettled`. If any tool is NOT read-only the
 * entire batch runs sequentially to preserve ordering guarantees.
 *
 * An error in one parallel tool does NOT abort the remaining tools — each
 * settled-promise is inspected independently.
 */
export async function executeToolBatch(
  toolCalls: ReadonlyArray<{ name: string; params: Record<string, unknown> }>,
): Promise<{ parallel: boolean; results: BatchToolResult[] }> {
  if (toolCalls.length === 0) {
    return { parallel: false, results: [] };
  }

  const allReadOnly = toolCalls.every((tc) => READ_ONLY_TOOLS.has(tc.name));

  if (allReadOnly && toolCalls.length > 1) {
    logger.info(`Executing ${toolCalls.length} read-only tools in parallel`);

    const settled = await Promise.allSettled(toolCalls.map((tc) => executeAgentTool(tc.name, tc.params)));

    const results: BatchToolResult[] = settled.map((outcome, idx) => {
      if (outcome.status === 'fulfilled') {
        return { name: toolCalls[idx].name, result: outcome.value };
      }

      const errorMessage = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      logger.error(`Parallel tool ${toolCalls[idx].name} rejected`, outcome.reason);

      return {
        name: toolCalls[idx].name,
        result: { success: false, error: `Tool execution rejected: ${errorMessage}` },
      };
    });

    return { parallel: true, results };
  }

  // Sequential execution (mixed batch or single tool)
  logger.info(`Executing ${toolCalls.length} tool(s) sequentially`);

  const results: BatchToolResult[] = [];

  for (const tc of toolCalls) {
    const result = await executeAgentTool(tc.name, tc.params);
    results.push({ name: tc.name, result });
  }

  return { parallel: false, results };
}
