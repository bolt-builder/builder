/**
 * @route /api/runtime/terminal
 * Server-side API route for terminal session management.
 *
 * POST operations:
 *   - spawn: Create a new terminal session (shell or command)
 *   - write: Send input to a terminal session
 *   - resize: Resize terminal dimensions
 *   - kill: Terminate a terminal session
 *   - list: List active sessions for a project
 *
 * GET operations:
 *   - stream: SSE stream of terminal output for a session
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { existsSync } from 'node:fs';
import { RuntimeManager } from '~/lib/runtime/local-runtime';
import { validateCommand, auditCommand } from '~/lib/runtime/command-safety';
import { withSecurity } from '~/lib/security';
import { terminalRequestSchema, validateInput } from '~/lib/api/schemas';
import { successResponse, errorResponse } from '~/lib/api/responses';
import { AppError, AppErrorType } from '~/lib/api/errors';
import { AUTH_PRESETS } from '~/lib/security-config';
import { createScopedLogger } from '~/utils/logger';

/**
 * Resolve the native Git Bash path on Windows.
 * Prefers Git Bash over WSL bash to avoid WSL port-forwarding issues
 * and keep the project's dev server on the Windows network stack.
 */
let _resolvedGitBash: string | null | undefined;

function resolveGitBash(): string | null {
  if (_resolvedGitBash !== undefined) {
    return _resolvedGitBash;
  }

  const candidates = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'];

  for (const p of candidates) {
    if (existsSync(p)) {
      _resolvedGitBash = p;
      return p;
    }
  }

  _resolvedGitBash = null;

  return null;
}

const logger = createScopedLogger('RuntimeTerminal');

/*
 * ---------------------------------------------------------------------------
 * GET — SSE output streaming
 * ---------------------------------------------------------------------------
 */

async function terminalLoader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const op = url.searchParams.get('op');

  switch (op) {
    case 'stream': {
      const sessionId = url.searchParams.get('sessionId');

      if (!sessionId) {
        return errorResponse(new AppError(AppErrorType.VALIDATION, 'Missing sessionId'));
      }

      // Find the session across all runtimes
      const manager = RuntimeManager.getInstance();
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();

          // Search all runtimes for the session
          for (const projectId of manager.listProjects()) {
            // We need to use an async IIFE to manage the Promise-based getRuntime
            void (async () => {
              try {
                const runtime = await manager.getRuntime(projectId);
                const session = runtime.getSession(sessionId);

                if (!session) {
                  return;
                }

                // Register data listener for this session
                session.dataListeners.push((data: string) => {
                  try {
                    const payload = JSON.stringify({ type: 'data', data });
                    controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
                  } catch {
                    // Stream may have been closed
                  }
                });

                // Listen for process exit
                session.exitPromise
                  .then((exitCode) => {
                    try {
                      const payload = JSON.stringify({ type: 'exit', exitCode });
                      controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
                      controller.close();
                    } catch {
                      // Stream may already be closed
                    }
                  })
                  .catch(() => {
                    try {
                      controller.close();
                    } catch {
                      // Already closed
                    }
                  });

                // Send initial heartbeat
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`));
              } catch (err) {
                logger.error('Terminal stream error:', err);

                const errorMsg = err instanceof Error ? err.message : String(err);

                try {
                  controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: errorMsg })}\n\n`));
                  controller.close();
                } catch {
                  // Controller already closed
                }
              }
            })();
          }

          // Heartbeat every 15 seconds
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`));
            } catch {
              clearInterval(heartbeat);
            }
          }, 15_000);

          // Clean up on disconnect
          request.signal.addEventListener('abort', () => {
            clearInterval(heartbeat);

            try {
              controller.close();
            } catch {
              // Already closed
            }
          });
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    default: {
      return errorResponse(new AppError(AppErrorType.VALIDATION, `Unknown GET operation: ${op}`));
    }
  }
}

/*
 * ---------------------------------------------------------------------------
 * POST — Session management
 * ---------------------------------------------------------------------------
 */

async function terminalAction({ request }: ActionFunctionArgs) {
  const validation = await validateInput(request, terminalRequestSchema);

  if (!validation.success) {
    return errorResponse(validation.error);
  }

  const body = validation.data;
  const { op } = body;

  switch (op) {
    case 'spawn': {
      const { projectId, command, cols, rows, env, cwd } = body;

      /*
       * Normalize shell command for the current platform.
       * The client (browser) cannot detect the OS and defaults to /bin/bash.
       * On Windows, prefer Git Bash over WSL bash to keep the dev server on
       * the native Windows network stack and avoid WSL port-forwarding issues.
       */
      let shellCommand = command ?? '';

      if (process.platform === 'win32' && shellCommand) {
        // Strip Unix-style absolute path prefix (e.g. /bin/bash → bash)
        const stripped = shellCommand.replace(/^\/(?:usr\/)?bin\/((?:ba|z|fi|da)sh)\b/, '$1');

        // If the command resolves to a simple bash name, prefer Git Bash
        if (/^bash\b/.test(stripped)) {
          const gitBash = resolveGitBash();

          if (gitBash) {
            shellCommand = stripped.replace(/^bash/, `"${gitBash}"`);
            logger.debug(`Using Git Bash: ${shellCommand}`);
          } else {
            shellCommand = stripped;
            logger.debug(`Git Bash not found, falling back to PATH bash: ${shellCommand}`);
          }
        } else {
          shellCommand = stripped;
        }
      }

      if (!shellCommand) {
        shellCommand = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
      }

      if (command) {
        const validation = validateCommand(command);

        if (!validation.allowed) {
          logger.warn(`Blocked terminal command for project "${projectId}": ${command}`);
          return errorResponse(new AppError(AppErrorType.FORBIDDEN, `Command blocked: ${validation.reason}`));
        }
      }

      auditCommand(projectId, shellCommand, 'terminal');

      try {
        const manager = RuntimeManager.getInstance();
        const runtime = await manager.getRuntime(projectId);

        const spawnedProcess = await runtime.spawn(shellCommand, [], {
          terminal: { cols: cols ?? 80, rows: rows ?? 24 },
          env,
          cwd,
        });

        return successResponse({
          sessionId: spawnedProcess.id,
          pid: spawnedProcess.pid,
        });
      } catch (error) {
        logger.error('Terminal spawn failed:', error);

        return errorResponse(error instanceof Error ? error : 'Spawn failed');
      }
    }

    case 'write': {
      const { sessionId, data } = body;

      try {
        const manager = RuntimeManager.getInstance();

        // Search all runtimes for the session
        for (const projectId of manager.listProjects()) {
          const runtime = await manager.getRuntime(projectId);

          try {
            runtime.writeToSession(sessionId, data);
            return successResponse(null);
          } catch {
            // Session not in this runtime, try next
          }
        }

        return errorResponse(new AppError(AppErrorType.NOT_FOUND, 'Session not found'));
      } catch (error) {
        logger.error('Terminal write failed:', error);

        return errorResponse(error instanceof Error ? error : 'Write failed');
      }
    }

    case 'resize': {
      const { sessionId, cols, rows } = body;

      // Resizes PTY-backed sessions; no-op for pipe-based fallback sessions
      try {
        const manager = RuntimeManager.getInstance();

        for (const projectId of manager.listProjects()) {
          const runtime = await manager.getRuntime(projectId);

          try {
            runtime.resizeSession(sessionId, cols, rows);
            return successResponse(null);
          } catch {
            // Session not in this runtime, try next
          }
        }
      } catch (error) {
        logger.debug(`Resize failed for ${sessionId}:`, error);
      }

      return successResponse(null);
    }

    case 'kill': {
      const { sessionId, signal } = body;

      try {
        const manager = RuntimeManager.getInstance();

        for (const projectId of manager.listProjects()) {
          const runtime = await manager.getRuntime(projectId);

          try {
            runtime.killSession(sessionId, signal ?? 'SIGTERM');
            return successResponse(null);
          } catch {
            // Session not in this runtime, try next
          }
        }

        return errorResponse(new AppError(AppErrorType.NOT_FOUND, 'Session not found'));
      } catch (error) {
        logger.error('Terminal kill failed:', error);

        return errorResponse(error instanceof Error ? error : 'Kill failed');
      }
    }

    case 'list': {
      const { projectId } = body;

      try {
        const manager = RuntimeManager.getInstance();
        const runtime = await manager.getRuntime(projectId);
        const sessions = runtime.listSessions();

        return successResponse({ sessions });
      } catch (error) {
        logger.error('Terminal list failed:', error);

        return errorResponse(error instanceof Error ? error : 'List failed');
      }
    }

    default: {
      return errorResponse(new AppError(AppErrorType.VALIDATION, `Unknown operation: ${op}`));
    }
  }
}

/*
 * ---------------------------------------------------------------------------
 * Exports
 * ---------------------------------------------------------------------------
 */

export const loader = withSecurity(terminalLoader, { auth: AUTH_PRESETS.authenticated, rateLimit: false });
export const action = withSecurity(terminalAction, { auth: AUTH_PRESETS.authenticated, rateLimit: false });
