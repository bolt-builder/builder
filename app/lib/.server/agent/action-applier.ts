import type { DevonzAction } from '~/types/actions';
import { WORK_DIR } from '~/utils/constants';
import { validateCommand, auditCommand, DEFAULT_EXEC_TIMEOUT_MS } from '~/lib/runtime/command-safety';
import { applySearchReplaceDiff } from '~/lib/runtime/diff/apply-diff';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ActionApplier');

/**
 * Server-side applier for parsed devonzArtifact actions.
 *
 * This is the headless counterpart of the browser's ActionRunner: it executes
 * `file`, `diff`, `shell`, and `build` actions directly against a server-side
 * runtime instance, with no UI stores, terminals, or approval flows. Actions
 * that only make sense in an interactive session (`start` dev servers,
 * `supabase`, `plan`, `task-update`) are recorded as skipped.
 */

export interface AppliedActionResult {
  type: DevonzAction['type'];

  /** File path for file/diff actions; the command for shell-like actions. */
  target?: string;
  status: 'applied' | 'failed' | 'skipped';
  detail?: string;
}

/**
 * Minimal structural runtime interface so the applier is testable without
 * booting a real LocalRuntime. `RuntimeProvider` instances satisfy it.
 */
export interface AgentRuntime {
  fs: {
    writeFile(path: string, content: string | Uint8Array): Promise<void>;
    readFile(path: string): Promise<string>;
  };
  exec(command: string, options?: { timeout?: number }): Promise<{ exitCode: number; output: string }>;
}

/**
 * Normalize an action file path (usually absolute like `/home/project/src/x.ts`)
 * to a project-relative path accepted by the jailed runtime filesystem.
 */
export function toProjectRelativePath(filePath: string): string {
  let path = filePath.trim();

  if (path === WORK_DIR) {
    throw new Error(`Action path points at the project root: ${filePath}`);
  }

  if (path.startsWith(`${WORK_DIR}/`)) {
    path = path.slice(WORK_DIR.length + 1);
  }

  path = path.replace(/^\/+/, '');

  if (!path) {
    throw new Error(`Empty action path: ${filePath}`);
  }

  return path;
}

const OUTPUT_TAIL_CHARS = 600;

function tail(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > OUTPUT_TAIL_CHARS ? `…${trimmed.slice(-OUTPUT_TAIL_CHARS)}` : trimmed;
}

async function runShellCommand(
  runtime: AgentRuntime,
  projectId: string,
  action: { type: DevonzAction['type']; content: string },
  execTimeoutMs: number,
): Promise<AppliedActionResult> {
  const command = action.content.trim();
  const validation = validateCommand(command);

  if (!validation.allowed) {
    return { type: action.type, target: command, status: 'skipped', detail: `Blocked: ${validation.reason}` };
  }

  auditCommand(projectId, command, 'exec');

  const result = await runtime.exec(command, { timeout: execTimeoutMs });

  if (result.exitCode !== 0) {
    return {
      type: action.type,
      target: command,
      status: 'failed',
      detail: `Exit code ${result.exitCode}: ${tail(result.output)}`,
    };
  }

  return { type: action.type, target: command, status: 'applied' };
}

/**
 * Apply parsed actions sequentially against the runtime. Never throws for a
 * single action failure — each action gets its own result entry so the caller
 * can report a full run summary.
 */
export async function applyActions(
  runtime: AgentRuntime,
  projectId: string,
  actions: DevonzAction[],
  options?: { execTimeoutMs?: number },
): Promise<AppliedActionResult[]> {
  const execTimeoutMs = options?.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const results: AppliedActionResult[] = [];

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'file': {
          const relativePath = toProjectRelativePath(action.filePath);
          await runtime.fs.writeFile(relativePath, action.content);
          results.push({ type: 'file', target: relativePath, status: 'applied' });
          break;
        }

        case 'diff': {
          const relativePath = toProjectRelativePath(action.filePath);
          const original = await runtime.fs.readFile(relativePath);
          const diffResult = applySearchReplaceDiff(original, action.diffBlocks);

          if (diffResult.failedBlocks.length > 0) {
            results.push({
              type: 'diff',
              target: relativePath,
              status: 'failed',
              detail: `${diffResult.failedBlocks.length} of ${action.diffBlocks.length} blocks did not match`,
            });
            break;
          }

          await runtime.fs.writeFile(relativePath, diffResult.result);
          results.push({
            type: 'diff',
            target: relativePath,
            status: 'applied',
            detail: `${diffResult.appliedCount} blocks applied`,
          });
          break;
        }

        case 'shell':
        case 'build': {
          results.push(await runShellCommand(runtime, projectId, action, execTimeoutMs));
          break;
        }

        case 'start': {
          results.push({
            type: 'start',
            target: action.content.trim(),
            status: 'skipped',
            detail: 'Dev servers are not started in headless agent runs',
          });
          break;
        }

        default: {
          results.push({
            type: action.type,
            status: 'skipped',
            detail: 'Action type is not supported in headless agent runs',
          });
        }
      }
    } catch (error) {
      logger.error(`Failed to apply ${action.type} action`, error);
      results.push({
        type: action.type,
        target: 'filePath' in action ? action.filePath : undefined,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
