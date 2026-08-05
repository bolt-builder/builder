import type { ActionFunctionArgs } from 'react-router';
import { z } from 'zod';
import { streamText, type Messages } from '~/lib/.server/llm/stream-text';
import { withSecurity } from '~/lib/security';
import { requireApiAuth } from '~/lib/.server/api/auth';
import { errorResponse, successResponse } from '~/lib/api/responses';
import { AppError, AppErrorType } from '~/lib/api/errors';
import { AUTH_PRESETS } from '~/lib/security-config';
import { createScopedLogger } from '~/utils/logger';
import { DEFAULT_PROVIDER } from '~/utils/constants';
import { RuntimeManager } from '~/lib/runtime/local-runtime';
import { isValidProjectId } from '~/lib/runtime/runtime-provider';
import { StreamingMessageParser } from '~/lib/runtime/message-parser';
import { applyActions, type AppliedActionResult } from '~/lib/.server/agent/action-applier';
import type { DevonzAction } from '~/types/actions';

const logger = createScopedLogger('api.v1.agent');

/**
 * Headless backend agent (experimental, feature-flagged).
 *
 * Runs a full LLM build turn server-side and applies the resulting
 * devonzArtifact actions (file writes, diffs, shell/build commands) directly
 * against the project's runtime — no browser required to drive the work.
 *
 * Gating (both required):
 *   - DEVONZ_API_KEY        — bearer token auth for the whole /api/v1 surface
 *   - DEVONZ_BACKEND_AGENT=1 — opt-in flag for this endpoint
 */

const v1AgentRequestSchema = z.object({
  projectId: z.string().min(1).max(64),
  model: z.string().min(1),
  provider: z.string().min(1).optional(),
  prompt: z.string().min(1),
  context: z.string().optional(),
});

function isBackendAgentEnabled(): boolean {
  return process.env.DEVONZ_BACKEND_AGENT === '1' || process.env.DEVONZ_BACKEND_AGENT === 'true';
}

async function v1AgentAction({ context, request }: ActionFunctionArgs): Promise<Response> {
  if (!isBackendAgentEnabled()) {
    return errorResponse(
      new AppError(AppErrorType.NOT_FOUND, 'Backend agent is disabled. Set DEVONZ_BACKEND_AGENT=1 to enable it.'),
    );
  }

  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(new AppError(AppErrorType.VALIDATION, 'Invalid JSON in request body'));
  }

  const parsed = v1AgentRequestSchema.safeParse(rawBody);

  if (!parsed.success) {
    logger.warn('v1/agent validation failed:', parsed.error.issues);

    return errorResponse(new AppError(AppErrorType.VALIDATION, 'Invalid request'));
  }

  const { projectId, model, provider, prompt, context: userContext } = parsed.data;

  if (!isValidProjectId(projectId)) {
    return errorResponse(new AppError(AppErrorType.VALIDATION, 'Invalid project id'));
  }

  try {
    // Boot (or reuse) the project runtime before spending tokens
    const runtimeManager = RuntimeManager.getInstance();
    await runtimeManager.getRuntime(projectId);

    const messages: Messages = [];

    if (userContext) {
      messages.push({ id: 'ctx-1', role: 'system', content: userContext });
    }

    messages.push({
      id: 'msg-1',
      role: 'user',
      content: `[Model: ${model}]\n\n[Provider: ${provider ?? DEFAULT_PROVIDER.name}]\n\n${prompt}`,
    });

    const result = await streamText({
      messages,
      env: context.cloudflare?.env as Record<string, string> | undefined,
      chatMode: 'build',
    });

    // Drain the stream to completion server-side
    let responseText = '';

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        responseText += part.textDelta;
      } else if (part.type === 'error') {
        logger.error('v1/agent stream error:', part.error);

        return errorResponse(new AppError(AppErrorType.INTERNAL, 'LLM stream failed'));
      }
    }

    // Parse devonzArtifact actions out of the completed response
    const actions: DevonzAction[] = [];
    const parser = new StreamingMessageParser({
      callbacks: {
        onActionClose: (data) => {
          actions.push(data.action);
        },
      },
    });
    parser.parse('v1-agent-run', responseText);

    // Re-acquire the runtime (refreshes idle-teardown activity) and apply
    const runtime = await runtimeManager.getRuntime(projectId);
    const applied: AppliedActionResult[] = await applyActions(runtime, projectId, actions);

    const summary = {
      applied: applied.filter((a) => a.status === 'applied').length,
      failed: applied.filter((a) => a.status === 'failed').length,
      skipped: applied.filter((a) => a.status === 'skipped').length,
    };

    logger.info(
      `v1/agent run for project ${projectId}: ${summary.applied} applied, ${summary.failed} failed, ${summary.skipped} skipped`,
    );

    return successResponse({
      projectId,
      responseText,
      summary,
      actions: applied,
    });
  } catch (error) {
    logger.error('v1/agent run failed:', error);

    return errorResponse(error instanceof Error ? error : String(error));
  }
}

export const action = withSecurity(requireApiAuth(v1AgentAction), {
  auth: AUTH_PRESETS.public,
  csrfExempt: true,
  allowedMethods: ['POST'],
  rateLimit: false, // rate limiting is handled by requireApiAuth (separate API pool)
});
