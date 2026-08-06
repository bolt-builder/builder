import { timingSafeEqual } from 'node:crypto';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('API');

/*
 * ---------------------------------------------------------------------------
 * Bearer token validation
 * ---------------------------------------------------------------------------
 */

/**
 * Validate a Bearer token from the `Authorization` header against the
 * `BOLT_API_KEY` environment variable.
 *
 * - If `BOLT_API_KEY` is not set, **all requests are rejected** (unlike the
 *   UI auth which is permissive when unconfigured).  The programmatic API is
 *   opt-in and must be explicitly enabled.
 * - Uses timing-safe comparison to prevent timing attacks.
 *
 * @returns An object with `valid` (boolean) and, when invalid, `reason` (one
 *   of `'missing_header'`, `'malformed'`, `'not_configured'`, `'invalid'`).
 */
export function validateBearerToken(request: Request): {
  valid: boolean;
  reason?: 'missing_header' | 'malformed' | 'not_configured' | 'invalid';
} {
  const expected = process.env.BOLT_API_KEY;

  if (!expected) {
    return { valid: false, reason: 'not_configured' };
  }

  const authHeader = request.headers.get('Authorization');

  if (!authHeader) {
    return { valid: false, reason: 'missing_header' };
  }

  if (!authHeader.startsWith('Bearer ')) {
    return { valid: false, reason: 'malformed' };
  }

  const token = authHeader.slice('Bearer '.length);

  if (!token) {
    return { valid: false, reason: 'malformed' };
  }

  try {
    const expectedBuf = Buffer.from(expected, 'utf-8');
    const actualBuf = Buffer.from(token, 'utf-8');

    if (expectedBuf.length !== actualBuf.length) {
      return { valid: false, reason: 'invalid' };
    }

    if (!timingSafeEqual(expectedBuf, actualBuf)) {
      return { valid: false, reason: 'invalid' };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: 'invalid' };
  }
}

/*
 * ---------------------------------------------------------------------------
 * Per-API-key rate limiting  (separate pool from UI rate limiting)
 * ---------------------------------------------------------------------------
 */

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/**
 * In-memory sliding-window rate limiter keyed by API key (NOT by IP).
 * This is a completely separate pool from the UI rate limiter in
 * `~/lib/security.ts`.
 */
const apiRateLimitStore = new Map<string, RateLimitEntry>();

/** Default: 60 requests per 60-second window per API key. */
const API_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const API_RATE_LIMIT_MAX_REQUESTS = 60;

/**
 * Check whether the given API key is within the rate limit.
 *
 * Uses a fixed-window algorithm: once `windowStart + windowMs` has elapsed,
 * the counter resets.
 *
 * @returns `{ allowed }` when OK, `{ allowed: false, retryAfterMs }` when
 *   the caller should back off.
 */
export function checkApiRateLimit(apiKey: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const entry = apiRateLimitStore.get(apiKey);

  // Clean up expired entries lazily
  if (entry && now - entry.windowStart >= API_RATE_LIMIT_WINDOW_MS) {
    apiRateLimitStore.delete(apiKey);
  }

  const current = apiRateLimitStore.get(apiKey);

  if (!current) {
    apiRateLimitStore.set(apiKey, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (current.count >= API_RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterMs = current.windowStart + API_RATE_LIMIT_WINDOW_MS - now;
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
  }

  current.count++;

  return { allowed: true };
}

/**
 * Reset the API rate limit store.  **Only for testing.**
 */
export function _resetApiRateLimitStore(): void {
  apiRateLimitStore.clear();
}

/*
 * ---------------------------------------------------------------------------
 * Middleware: requireApiAuth
 * ---------------------------------------------------------------------------
 */

/**
 * Wraps a Remix action/loader to enforce Bearer-token auth **and**
 * per-API-key rate limiting for programmatic `/api/v1/` endpoints.
 *
 * This is layered **on top of** `withSecurity()` — `withSecurity()` handles
 * method checks and security headers, while `requireApiAuth` handles Bearer
 * auth and the separate API rate limit pool.
 */
export function requireApiAuth(
  handler: (args: ActionFunctionArgs | LoaderFunctionArgs) => Promise<Response> | Response,
): (args: ActionFunctionArgs | LoaderFunctionArgs) => Promise<Response> | Response {
  return async (args: ActionFunctionArgs | LoaderFunctionArgs) => {
    const { request } = args;
    const url = new URL(request.url);

    // 1. Validate Bearer token
    const authResult = validateBearerToken(request);

    if (!authResult.valid) {
      const statusMessage =
        authResult.reason === 'not_configured' ? 'API key not configured on server' : 'Unauthorized';

      logger.warn(`API auth failed for ${url.pathname}: ${authResult.reason}`);

      return new Response(JSON.stringify({ error: true, message: statusMessage }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer',
        },
      });
    }

    // 2. Per-API-key rate limiting
    const token = request.headers.get('Authorization')!.slice('Bearer '.length);
    const rateResult = checkApiRateLimit(token);

    if (!rateResult.allowed) {
      const retryAfterSec = Math.ceil((rateResult.retryAfterMs ?? 0) / 1000);
      logger.warn(`API rate limit exceeded for ${url.pathname}`);

      return new Response(JSON.stringify({ error: true, message: 'Rate limit exceeded' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfterSec),
        },
      });
    }

    return handler(args);
  };
}
