import type { AppLoadContext } from 'react-router';
import { getApiKeysFromCookie } from '~/lib/api/cookies';
import { createScopedLogger } from '~/utils/logger';
import { ApiError } from '~/lib/api/errors';

export { ApiError };
export { csrfFetch, getCsrfToken } from '~/lib/api/csrf-client';

const logger = createScopedLogger('ApiUtils');

/**
 * Resolve a service token from cookies, Cloudflare env, or process.env.
 *
 * Priority order (matches original per-route behaviour):
 *   1. All cookie keys (user-provided tokens always win)
 *   2. All Cloudflare env keys
 *   3. All process.env keys
 *   4. Authorization header bearer token
 */
export function resolveToken(
  request: Request,
  context: AppLoadContext | undefined,
  ...envKeys: string[]
): string | null {
  const cookieHeader = request.headers.get('Cookie');
  const apiKeys = getApiKeysFromCookie(cookieHeader);

  for (const key of envKeys) {
    if (apiKeys[key]) {
      return apiKeys[key];
    }
  }

  const cfEnv = (context as { cloudflare?: { env?: Record<string, string> } })?.cloudflare?.env;

  for (const key of envKeys) {
    if (cfEnv?.[key]) {
      return cfEnv[key];
    }
  }

  for (const key of envKeys) {
    if (process.env[key]) {
      return process.env[key]!;
    }
  }

  const authHeader = request.headers.get('Authorization');

  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  return null;
}

/**
 * Return a 401 JSON response when a service token is missing.
 */
export function unauthorizedResponse(serviceName: string) {
  return Response.json({ error: `${serviceName} token not found` }, { status: 401 });
}

export interface ExternalFetchOptions {
  url: string;
  token: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;

  /** Request timeout in milliseconds (default: 30 000) */
  timeoutMs?: number;
}

/**
 * Fetch an external API with standard auth and user-agent headers.
 * Returns the raw Response so callers can handle status codes as needed.
 * Includes a default 30 s timeout to prevent hanging requests.
 */
export async function externalFetch({
  url,
  token,
  method = 'GET',
  body,
  headers = {},
  timeoutMs = 30_000,
}: ExternalFetchOptions) {
  return fetch(url, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'bolt-app',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/**
 * Wrap an async handler with standardised error logging and JSON error responses.
 * Use inside route handlers to avoid repetitive try/catch blocks.
 *
 * Preserves upstream status codes when the thrown error is an ApiError.
 */
export async function handleApiError(
  scope: string,
  fn: () => Promise<Response>,
  fallbackMessage = 'An unexpected error occurred',
): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    logger.error(`[${scope}]`, error);

    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof Error) {
      if (error.message.includes('fetch')) {
        return Response.json({ error: 'Network error. Please check your connection.' }, { status: 503 });
      }

      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ error: fallbackMessage }, { status: 500 });
  }
}
