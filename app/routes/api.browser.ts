/**
 * @route /api/browser
 * Server-side API for the workbench's embedded real browser.
 *
 * POST operations:
 *   - create: Launch a new browser session (returns sessionId)
 *   - navigate / back / forward / reload: Navigation controls
 *   - mouse / key: Forward user input to the page
 *   - resize: Match the page viewport to the client panel
 *   - close: Tear down a session
 *
 * GET operations:
 *   - stream: SSE stream of screencast frames + page state for a session
 *
 * @see {@link app/lib/.server/browser/browser-session-manager.ts}
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import {
  BrowserSessionManager,
  BrowserUnavailableError,
  type BrowserFrame,
  type BrowserPageState,
} from '~/lib/.server/browser/browser-session-manager';
import { withSecurity } from '~/lib/security';
import { browserRequestSchema, validateInput } from '~/lib/api/schemas';
import { successResponse, errorResponse } from '~/lib/api/responses';
import { AppError, AppErrorType } from '~/lib/api/errors';
import { AUTH_PRESETS } from '~/lib/security-config';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('BrowserAPI');

/*
 * ---------------------------------------------------------------------------
 * GET — SSE frame/state streaming
 * ---------------------------------------------------------------------------
 */

async function browserLoader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const op = url.searchParams.get('op');

  if (op !== 'stream') {
    return errorResponse(new AppError(AppErrorType.VALIDATION, `Unknown GET operation: ${op}`));
  }

  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId) {
    return errorResponse(new AppError(AppErrorType.VALIDATION, 'Missing sessionId'));
  }

  const manager = BrowserSessionManager.getInstance();

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // Stream may have been closed by the client.
        }
      };

      let unsubscribe: (() => void) | null = null;

      try {
        unsubscribe = manager.subscribe(
          sessionId,
          (frame: BrowserFrame) => send({ type: 'frame', ...frame }),
          (state: BrowserPageState) => send({ type: 'state', ...state }),
        );
        send({ type: 'connected', sessionId });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        send({ type: 'error', error: errorMsg });

        try {
          controller.close();
        } catch {
          // Already closed
        }

        return;
      }

      // Heartbeat every 15 seconds to keep proxies from closing the stream.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);

      request.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        unsubscribe?.();

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

/*
 * ---------------------------------------------------------------------------
 * POST — session control + input forwarding
 * ---------------------------------------------------------------------------
 */

async function browserAction({ request }: ActionFunctionArgs) {
  const validation = await validateInput(request, browserRequestSchema);

  if (!validation.success) {
    return errorResponse(validation.error);
  }

  const manager = BrowserSessionManager.getInstance();
  const input = validation.data;

  try {
    switch (input.op) {
      case 'create': {
        const sessionId = await manager.createSession(
          input.width && input.height ? { width: input.width, height: input.height } : undefined,
        );

        return successResponse({ sessionId });
      }
      case 'navigate': {
        await manager.navigate(input.sessionId, input.url);

        return successResponse({ ok: true });
      }
      case 'back': {
        await manager.goBack(input.sessionId);

        return successResponse({ ok: true });
      }
      case 'forward': {
        await manager.goForward(input.sessionId);

        return successResponse({ ok: true });
      }
      case 'reload': {
        await manager.reload(input.sessionId);

        return successResponse({ ok: true });
      }
      case 'mouse': {
        await manager.dispatchMouse(input.sessionId, input.event);

        return successResponse({ ok: true });
      }
      case 'key': {
        await manager.dispatchKey(input.sessionId, input.event);

        return successResponse({ ok: true });
      }
      case 'resize': {
        await manager.setViewport(input.sessionId, input.width, input.height);

        return successResponse({ ok: true });
      }
      case 'close': {
        await manager.closeSession(input.sessionId);

        return successResponse({ ok: true });
      }
    }
  } catch (err) {
    if (err instanceof BrowserUnavailableError) {
      return errorResponse(new AppError(AppErrorType.INTERNAL, err.message));
    }

    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Browser API ${input.op} failed:`, message);

    return errorResponse(new AppError(AppErrorType.INTERNAL, message));
  }

  return errorResponse(new AppError(AppErrorType.VALIDATION, 'Unknown operation'));
}

export const loader = withSecurity(browserLoader, { auth: AUTH_PRESETS.authenticated, rateLimit: false });
export const action = withSecurity(browserAction, { auth: AUTH_PRESETS.authenticated, rateLimit: false });
