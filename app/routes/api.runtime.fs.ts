/**
 * @route /api/runtime/fs
 * Server-side API route for filesystem operations.
 *
 * GET operations: readFile, readFileRaw, readdir, stat, exists, watch (SSE)
 * POST operations: writeFile, mkdir, rm, rename
 *
 * All paths are relative to the project directory. Path traversal is
 * validated on both client and server sides.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { Buffer } from 'node:buffer';
import { RuntimeManager } from '~/lib/runtime/local-runtime';
import type { RuntimeFileSystem, WatchEvent } from '~/lib/runtime/runtime-provider';
import { isValidProjectId, isSafePath } from '~/lib/runtime/runtime-provider';
import { withSecurity } from '~/lib/security';
import { fsWriteRequestSchema, parseOrError } from '~/lib/api/schemas';
import { successResponse, errorResponse } from '~/lib/api/responses';
import { AppError, AppErrorType } from '~/lib/api/errors';
import { AUTH_PRESETS } from '~/lib/security-config';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('RuntimeFS');

/*
 * ---------------------------------------------------------------------------
 * GET — Read operations
 * ---------------------------------------------------------------------------
 */

async function fsLoader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const op = url.searchParams.get('op');
  const projectId = url.searchParams.get('projectId');
  const filePath = url.searchParams.get('path') ?? '.';

  if (!projectId || !isValidProjectId(projectId)) {
    return errorResponse(new AppError(AppErrorType.VALIDATION, 'Invalid or missing projectId'));
  }

  if (!isSafePath(filePath)) {
    return errorResponse(new AppError(AppErrorType.VALIDATION, 'Invalid path: traversal detected'));
  }

  const manager = RuntimeManager.getInstance();
  const runtime = await manager.getRuntime(projectId);

  switch (op) {
    case 'readFile': {
      try {
        const encoding = (url.searchParams.get('encoding') ?? 'utf-8') as BufferEncoding;
        const content = await runtime.fs.readFile(filePath, encoding);

        return new Response(content, {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      } catch {
        /*
         * Use 204 (No Content) instead of 404 for missing files.
         * Browsers auto-log 404 fetch responses as console errors,
         * which creates noise during git clone operations where
         * isomorphic-git probes many non-existent files. 204 is
         * not logged and the client checks for it explicitly.
         */
        return new Response(null, { status: 204 });
      }
    }

    case 'readFileRaw': {
      try {
        const data = await runtime.fs.readFileRaw(filePath);

        return new Response(Buffer.from(data), {
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      } catch {
        return new Response(null, { status: 204 });
      }
    }

    case 'readdir': {
      try {
        const entries = await runtime.fs.readdir(filePath);
        return successResponse(entries);
      } catch (error) {
        /*
         * Return an empty array (200) instead of 404 for non-existent
         * directories. The dependency validator and component import
         * validator optimistically scan common directory names (src, app,
         * pages, components, etc.) — most won't exist for any given
         * project. Returning [] avoids noisy browser-console 404 errors
         * while being semantically correct: "nothing in this directory".
         */
        const code = (error as NodeJS.ErrnoException)?.code;

        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return successResponse([]);
        }

        logger.warn(`readdir failed: ${filePath}`, error);

        return errorResponse(error instanceof Error ? error : 'Readdir failed');
      }
    }

    case 'stat': {
      try {
        const stat = await runtime.fs.stat(filePath);
        return successResponse(stat);
      } catch {
        // Return 204 instead of 404 to avoid browser console noise
        return new Response(null, { status: 204 });
      }
    }

    case 'exists': {
      const exists = await runtime.fs.exists(filePath);
      return successResponse({ exists });
    }

    case 'watch': {
      const glob = url.searchParams.get('glob') ?? '**/*';

      // SSE stream for file watch events
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();

          const dispose = runtime.fs.watch(glob, (events) => {
            try {
              const data = `data: ${JSON.stringify(events)}\n\n`;
              controller.enqueue(encoder.encode(data));
            } catch {
              // Stream may have been closed
            }
          });

          // Send initial heartbeat
          controller.enqueue(encoder.encode('data: []\n\n'));

          /*
           * Emit initial file listing so existing files appear in the
           * file tree after a page refresh. fs.watch only reports
           * changes — it does not emit events for already-existing files.
           */
          try {
            const initialEvents = await walkProjectDir(runtime.fs);

            if (initialEvents.length > 0) {
              const data = `data: ${JSON.stringify(initialEvents)}\n\n`;
              controller.enqueue(encoder.encode(data));
            }
          } catch {
            // Non-critical — watcher still works for new changes
          }

          // Clean up when client disconnects
          request.signal.addEventListener('abort', () => {
            dispose();

            try {
              controller.close();
            } catch {
              // Controller may already be closed
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
      return errorResponse(new AppError(AppErrorType.VALIDATION, `Unknown operation: ${op}`));
    }
  }
}

/*
 * ---------------------------------------------------------------------------
 * POST — Write operations
 * ---------------------------------------------------------------------------
 */

async function fsAction({ request }: ActionFunctionArgs) {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(new AppError(AppErrorType.VALIDATION, 'Invalid JSON in request body'));
  }

  /*
   * The writeFile op is the default when `op` is omitted.
   * Inject it before schema validation so the discriminated union works.
   */
  const bodyWithOp =
    typeof rawBody === 'object' && rawBody !== null && !('op' in rawBody)
      ? { ...(rawBody as Record<string, unknown>), op: 'writeFile' }
      : rawBody;

  const parsed = parseOrError(fsWriteRequestSchema, bodyWithOp, 'RuntimeFS');

  if (!parsed.success) {
    return parsed.response;
  }

  const body = parsed.data;
  const { projectId, op } = body;

  const manager = RuntimeManager.getInstance();
  const runtime = await manager.getRuntime(projectId);

  switch (op) {
    case 'writeFile': {
      const { path: filePath, content, binary } = body;

      try {
        if (binary) {
          // Decode base64 to binary
          const binaryStr = atob(content);
          const bytes = new Uint8Array(binaryStr.length);

          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }

          await runtime.fs.writeFile(filePath, bytes);
        } else {
          await runtime.fs.writeFile(filePath, content);
        }

        return successResponse(null);
      } catch (error) {
        logger.error(`writeFile failed: ${filePath}`, error);

        return errorResponse(error instanceof Error ? error : 'Write failed');
      }
    }

    case 'mkdir': {
      const { path: dirPath, recursive } = body;

      try {
        await runtime.fs.mkdir(dirPath, { recursive: recursive ?? false });
        return successResponse(null);
      } catch (error) {
        logger.error(`mkdir failed: ${dirPath}`, error);

        return errorResponse(error instanceof Error ? error : 'Mkdir failed');
      }
    }

    case 'rm': {
      const { path: rmPath, recursive, force } = body;

      try {
        await runtime.fs.rm(rmPath, {
          recursive: recursive ?? false,
          force: force ?? false,
        });
        return successResponse(null);
      } catch (error) {
        logger.error(`rm failed: ${rmPath}`, error);

        return errorResponse(error instanceof Error ? error : 'Remove failed');
      }
    }

    case 'rename': {
      const { oldPath, newPath } = body;

      try {
        await runtime.fs.rename(oldPath, newPath);
        return successResponse(null);
      } catch (error) {
        logger.error(`rename failed: ${oldPath} → ${newPath}`, error);

        return errorResponse(error instanceof Error ? error : 'Rename failed');
      }
    }

    default: {
      return errorResponse(new AppError(AppErrorType.VALIDATION, `Unknown operation: ${op}`));
    }
  }
}

/*
 * ---------------------------------------------------------------------------
 * Initial file listing helper
 * ---------------------------------------------------------------------------
 */

/** Directories to skip during the initial walk. */
const WALK_SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '.dart_tool']);

/**
 * Recursively walk a project directory and return `addDir` / `add` watch
 * events for every entry. Used to populate the file tree when a watch
 * SSE client first connects (fs.watch only reports *changes*).
 */
async function walkProjectDir(fs: RuntimeFileSystem, dir = '.'): Promise<WatchEvent[]> {
  const events: WatchEvent[] = [];

  try {
    const entries = await fs.readdir(dir);

    for (const entry of entries) {
      if (WALK_SKIP.has(entry.name)) {
        continue;
      }

      const entryPath = dir === '.' ? entry.name : `${dir}/${entry.name}`;

      if (entry.isDirectory) {
        events.push({ type: 'addDir', path: entryPath });

        const sub = await walkProjectDir(fs, entryPath);
        events.push(...sub);
      } else if (entry.isFile) {
        events.push({ type: 'add', path: entryPath });
      }
    }
  } catch {
    // Directory doesn't exist or can't be read — not critical
  }

  return events;
}

/*
 * ---------------------------------------------------------------------------
 * Exports (wrapped with security middleware)
 * ---------------------------------------------------------------------------
 */

export const loader = withSecurity(fsLoader, { auth: AUTH_PRESETS.authenticated, rateLimit: false });
export const action = withSecurity(fsAction, { auth: AUTH_PRESETS.authenticated, rateLimit: false });
