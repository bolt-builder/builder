import { timingSafeEqual } from 'node:crypto';
import type { ZodType } from 'zod';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { createScopedLogger } from '~/utils/logger';
import { SecurityError, SecurityErrorType } from './api/errors';
import { errorResponse } from './api/responses';
import { validateInput } from './api/schemas';
import { CsrfService } from './csrf';
import { AUTH_CONFIG, CSP_CONNECT_SRC_ALLOWLIST, RATE_LIMITS } from './security-config';
import type { AuthConfig } from './security-config';

const logger = createScopedLogger('Security');

// Rate limiting store (in-memory for serverless environments)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

/**
 * Rate limiting middleware
 */
export function checkRateLimit(request: Request, endpoint: string): { allowed: boolean; resetTime?: number } {
  const clientIP = getClientIP(request);
  const key = `${clientIP}:${endpoint}`;

  // Find matching rate limit rule (prefer specific over wildcard)
  const entries = Object.entries(RATE_LIMITS);

  // Check exact matches first
  const exactMatch = entries.find(([pattern]) => pattern === endpoint);

  // Then check prefix patterns (e.g. '/api/github-*')
  const prefixMatch = entries.find(([pattern]) => {
    if (pattern.endsWith('-*')) {
      const basePattern = pattern.slice(0, -1);
      return endpoint.startsWith(basePattern);
    }

    return false;
  });

  // Then check wildcard patterns (e.g. '/api/*')
  const wildcardMatch = entries.find(([pattern]) => {
    if (pattern.endsWith('/*')) {
      const basePattern = pattern.slice(0, -2);
      return endpoint.startsWith(basePattern);
    }

    return false;
  });

  const rule = exactMatch || prefixMatch || wildcardMatch;

  if (!rule) {
    return { allowed: true }; // No rate limit for this endpoint
  }

  const [, config] = rule;
  const now = Date.now();

  // Clean up expired entries — resetTime is the absolute expiry timestamp
  for (const [storedKey, data] of rateLimitStore.entries()) {
    if (data.resetTime < now) {
      rateLimitStore.delete(storedKey);
    }
  }

  // Get or create rate limit data
  const rateLimitData = rateLimitStore.get(key) || { count: 0, resetTime: now + config.windowMs };

  if (rateLimitData.count >= config.maxRequests) {
    return { allowed: false, resetTime: rateLimitData.resetTime };
  }

  // Update rate limit data
  rateLimitData.count++;
  rateLimitStore.set(key, rateLimitData);

  return { allowed: true };
}

/**
 * Get client IP address from request
 */
function getClientIP(request: Request): string {
  // Try various headers that might contain the real IP
  const forwardedFor = request.headers.get('x-forwarded-for');
  const realIP = request.headers.get('x-real-ip');
  const cfConnectingIP = request.headers.get('cf-connecting-ip');

  // Return the first available IP or a fallback
  return cfConnectingIP || realIP || forwardedFor?.split(',')[0]?.trim() || 'unknown';
}

/**
 * Build a Content Security Policy string based on environment context.
 *
 * ### CSP strategy
 *
 * Full nonce-based CSP is impractical in this Remix/React stack because
 * UnoCSS, Radix UI portals and Framer Motion all inject inline styles,
 * and the theme-init script runs inline before React hydrates.
 *
 * **`style-src 'unsafe-inline'`** — kept in every environment.  Migrating
 * all inline styles to external sheets or nonces is not feasible today.
 *
 * **`script-src 'unsafe-eval'`** — allowed **only in development** so Vite
 * HMR can function.  Removed entirely in production.
 *
 * **`script-src 'unsafe-inline'`** — kept for the theme-init script that
 * must run before hydration.  In production, when `'strict-dynamic'` is
 * present, modern browsers ignore `'unsafe-inline'`; it remains as a
 * fallback for older user-agents.
 *
 * **`script-src 'strict-dynamic'`** — added in production so that scripts
 * loaded by trusted first-party scripts are automatically trusted without
 * needing an explicit allowlist for every sub-resource.
 *
 * **`upgrade-insecure-requests`** — added in production to automatically
 * promote any remaining HTTP sub-resource requests to HTTPS.
 *
 * **`object-src 'none'`**, **`base-uri 'self'`**, **`form-action 'self'`**
 * harden against plugin injection, base-tag hijacking and form-action
 * hijacking respectively.
 *
 * @param isProduction - Whether the app is running in production mode.
 * @returns The assembled CSP header value.
 */
export function buildContentSecurityPolicy(isProduction: boolean): string {
  const scriptSrc = isProduction
    ? "script-src 'self' 'unsafe-inline' 'strict-dynamic'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

  const directives: string[] = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https: blob:",
    "font-src 'self' data:",
    ["connect-src 'self'", ...CSP_CONNECT_SRC_ALLOWLIST].join(' '),
    "frame-src 'self' http://localhost:*",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  if (isProduction) {
    directives.push('upgrade-insecure-requests');
  }

  return directives.join('; ');
}

/**
 * Security headers middleware.
 *
 * @param env - Optional override for the runtime environment
 *              (defaults to `process.env.NODE_ENV`).
 */
export function createSecurityHeaders(env?: string) {
  const isProduction = (env ?? process.env.NODE_ENV) === 'production';

  return {
    // Prevent clickjacking
    'X-Frame-Options': 'DENY',

    // Prevent MIME type sniffing
    'X-Content-Type-Options': 'nosniff',

    // Enable XSS protection
    'X-XSS-Protection': '1; mode=block',

    // Content Security Policy
    'Content-Security-Policy': buildContentSecurityPolicy(isProduction),

    // Referrer Policy
    'Referrer-Policy': 'strict-origin-when-cross-origin',

    // Permissions Policy (formerly Feature Policy)
    'Permissions-Policy': ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()'].join(', '),

    // HSTS (HTTP Strict Transport Security) - only in production
    ...(isProduction
      ? {
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
        }
      : {}),
  };
}

/**
 * Validate API key format (basic validation)
 */
export function validateApiKeyFormat(apiKey: string, provider: string): boolean {
  if (!apiKey || typeof apiKey !== 'string') {
    return false;
  }

  // Basic length checks for different providers
  const minLengths: Record<string, number> = {
    anthropic: 50,
    openai: 50,
    groq: 50,
    google: 30,
    github: 30,
    netlify: 30,
  };

  const minLength = minLengths[provider.toLowerCase()] || 20;

  return apiKey.length >= minLength && !apiKey.includes('your_') && !apiKey.includes('here');
}

/**
 * Sanitize error messages to prevent information leakage
 */
export function sanitizeErrorMessage(error: unknown, isDevelopment = false): string {
  if (isDevelopment) {
    // In development, show full error details
    return error instanceof Error ? error.message : String(error);
  }

  // In production, show generic messages to prevent information leakage
  if (error instanceof Error) {
    // Check for sensitive information in error messages
    if (error.message.includes('API key') || error.message.includes('token') || error.message.includes('secret')) {
      return 'Authentication failed';
    }

    if (error.message.includes('rate limit') || error.message.includes('429')) {
      return 'Rate limit exceeded. Please try again later.';
    }
  }

  return 'An unexpected error occurred';
}

/**
 * Validates the auth token from the request against the configured
 * `BOLT_AUTH_TOKEN` environment variable.
 *
 * Token is read from the `X-Auth-Token` header or the `bolt-auth` cookie.
 * If `BOLT_AUTH_TOKEN` is not set, auth is bypassed (local dev friendly).
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param request - The incoming request to validate.
 * @returns `true` if the token is valid or if no auth token is configured.
 */
export function validateAuthToken(request: Request): boolean {
  const expected = process.env[AUTH_CONFIG.envVariable];

  // If no auth token is configured, bypass auth (local dev friendly)
  if (!expected) {
    return true;
  }

  // Extract token from auth header
  let token = request.headers.get(AUTH_CONFIG.tokenHeader);

  // Fall back to auth cookie
  if (!token) {
    const cookies = request.headers.get('Cookie') ?? '';
    const pattern = new RegExp(`(?:^|;\\s*)${AUTH_CONFIG.cookieName}=([^;]*)`);
    const match = cookies.match(pattern);
    token = match?.[1] ?? null;
  }

  if (!token) {
    return false;
  }

  // Timing-safe comparison — both buffers must be the same length
  try {
    const expectedBuf = Buffer.from(expected, 'utf-8');
    const actualBuf = Buffer.from(token, 'utf-8');

    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }

    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

/** HTTP methods that can carry a request body and require CSRF / body validation. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * Options for the security wrapper.
 *
 * Supports both legacy options (`requireAuth`, `rateLimit`, `allowedMethods`)
 * and new declarative options (`auth`, `csrfExempt`, `validateBody`).
 * When `auth` is provided it takes precedence over `requireAuth`.
 */
export interface SecurityOptions {
  /** @deprecated Use `auth` with an AuthConfig preset instead. */
  requireAuth?: boolean;

  /** Whether rate limiting is applied. Defaults to `true`. */
  rateLimit?: boolean;

  /** Restrict to specific HTTP methods (e.g. `['GET', 'POST']`). */
  allowedMethods?: string[];

  /** Declarative auth configuration. Takes precedence over `requireAuth`. */
  auth?: AuthConfig;

  /** Skip CSRF validation for this route. Defaults to `false`. Only effective when `auth` is provided. */
  csrfExempt?: boolean;

  /** Zod schema for pre-handler body validation on mutating requests. */
  validateBody?: ZodType<any>;
}

/**
 * Security wrapper for API routes.
 *
 * Applies rate limiting, authentication, CSRF protection, optional body
 * validation, and security headers. Accepts handlers that may or may not
 * consume the route args parameter.
 *
 * ### Backward compatibility
 *
 * Legacy call-sites (`withSecurity(handler)` or
 * `withSecurity(handler, { requireAuth: true })`) continue to work unchanged.
 * CSRF protection only activates when the new `auth` option is used.
 */
export function withSecurity(
  handler: (args: ActionFunctionArgs | LoaderFunctionArgs) => Promise<Response> | Response,
  options: SecurityOptions = {},
) {
  return async (args: ActionFunctionArgs | LoaderFunctionArgs): Promise<Response> => {
    const { request } = args;
    const url = new URL(request.url);
    const endpoint = url.pathname;
    const method = request.method.toUpperCase();
    const clientIP = getClientIP(request);
    const requestContext = { method, path: endpoint, clientIP };

    const secHeaders = createSecurityHeaders();

    /** Append security headers (and optional extras) to a response. */
    const applyHeaders = (response: Response, extra?: Record<string, string>): Response => {
      for (const [key, value] of Object.entries(secHeaders)) {
        response.headers.set(key, value);
      }

      if (extra) {
        for (const [key, value] of Object.entries(extra)) {
          response.headers.set(key, value);
        }
      }

      return response;
    };

    // --- Method check ----------------------------------------------------------
    if (options.allowedMethods && !options.allowedMethods.includes(method)) {
      logger.warn('Method not allowed', requestContext);

      return applyHeaders(errorResponse(new SecurityError(SecurityErrorType.FORBIDDEN, 'Method not allowed'), 405));
    }

    // --- Authentication --------------------------------------------------------
    const useNewAuth = options.auth !== undefined;
    const authRequired = useNewAuth
      ? options.auth!.level === 'authenticated' || options.auth!.level === 'ownerOnly'
      : options.requireAuth === true;

    if (authRequired && !validateAuthToken(request)) {
      logger.warn('Unauthorized request', requestContext);

      return applyHeaders(errorResponse(new SecurityError(SecurityErrorType.UNAUTHORIZED, 'Unauthorized')), {
        'WWW-Authenticate': 'Bearer',
      });
    }

    // --- Rate limiting ---------------------------------------------------------
    if (options.rateLimit !== false) {
      const rateLimitResult = checkRateLimit(request, endpoint);

      if (!rateLimitResult.allowed) {
        logger.warn('Rate limit exceeded', requestContext);

        return applyHeaders(errorResponse(new SecurityError(SecurityErrorType.RATE_LIMITED, 'Rate limit exceeded')), {
          'Retry-After': Math.ceil((rateLimitResult.resetTime! - Date.now()) / 1000).toString(),
          'X-RateLimit-Reset': rateLimitResult.resetTime!.toString(),
        });
      }
    }

    // --- CSRF protection (only when using the new `auth` option) ---------------
    const csrfActive = useNewAuth && !options.csrfExempt && options.auth!.csrfRequired !== false;

    if (csrfActive && MUTATING_METHODS.has(method)) {
      const csrfResult = CsrfService.validateRequest(request);

      if (!csrfResult.valid) {
        logger.warn('CSRF validation failed', requestContext);

        return applyHeaders(errorResponse(csrfResult.error));
      }
    }

    // --- Body validation (optional) --------------------------------------------
    if (options.validateBody && MUTATING_METHODS.has(method)) {
      const clonedRequest = request.clone();
      const validation = await validateInput(clonedRequest, options.validateBody);

      if (!validation.success) {
        logger.warn('Body validation failed', requestContext);

        return applyHeaders(errorResponse(validation.error));
      }
    }

    /*
     * Reuse the existing CSRF token from the request cookie instead of
     * generating a new one on every GET response.  Token rotation on every
     * GET causes race conditions during rapid concurrent requests: in-flight
     * POSTs read the old cookie value for the X-CSRF-Token header, but the
     * browser sends the new cookie value set by a concurrent GET response,
     * producing a mismatch.  The double-submit cookie pattern does NOT
     * require per-request rotation — security comes from the Same-Origin
     * Policy preventing cross-origin cookie reads.
     */
    const existingCsrfToken = csrfActive ? CsrfService.extractTokenFromRequest(request) : null;

    try {
      // Execute the handler
      const response = await handler(args);

      /*
       * For SSE / streaming responses we must NOT re-wrap the body in a new
       * Response — doing so loses the original controller reference and can
       * surface EPIPE errors when the client disconnects mid-stream.
       * Instead, mutate the original response headers in-place and return it.
       */
      const contentType = response.headers.get('Content-Type') ?? '';
      const isStreaming = contentType.includes('text/event-stream') || contentType.includes('application/octet-stream');

      if (isStreaming) {
        applyHeaders(response);

        // Set CSRF token cookie on streaming GET responses when CSRF is active
        if (csrfActive && method === 'GET') {
          CsrfService.setTokenCookie(response, existingCsrfToken ?? CsrfService.generateToken());
        }

        return response;
      }

      // Build new response with security headers
      const responseHeaders = new Headers(response.headers);

      for (const [key, value] of Object.entries(secHeaders)) {
        responseHeaders.set(key, value);
      }

      const wrappedResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });

      // Set CSRF token cookie on GET responses when CSRF is active
      if (csrfActive && method === 'GET') {
        CsrfService.setTokenCookie(wrappedResponse, existingCsrfToken ?? CsrfService.generateToken());
      }

      return wrappedResponse;
    } catch (error) {
      // Silently ignore broken-pipe errors from SSE client disconnects
      const code = (error as NodeJS.ErrnoException)?.code;

      if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_WRITE_AFTER_END') {
        logger.debug('Client disconnected during response (ignored)', {
          ...requestContext,
          errorCode: code,
        });

        return applyHeaders(new Response(null, { status: 499 }));
      }

      logger.error('Security-wrapped handler error', { ...requestContext, error });

      const message = sanitizeErrorMessage(error, process.env.NODE_ENV === 'development');

      return applyHeaders(errorResponse(message, 500));
    }
  };
}
