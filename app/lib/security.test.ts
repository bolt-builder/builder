/// <reference types="vitest/globals" />
import { createMockRequest, createMockContext } from '~/test/test-utils';
import {
  checkRateLimit,
  buildContentSecurityPolicy,
  createSecurityHeaders,
  validateApiKeyFormat,
  sanitizeErrorMessage,
  validateAuthToken,
  withSecurity,
} from './security';

/*
 * Rate limiting uses an in-memory Map that persists across tests.
 * Reset it before each test so prior calls don't influence results.
 * We achieve this by dynamically clearing the module and re-importing,
 * but since `checkRateLimit` already cleans up expired entries and we
 * can manipulate time, we'll simply use unique IPs per test instead.
 */

/*
 * ---------------------------------------------------------------------------
 * checkRateLimit
 * ---------------------------------------------------------------------------
 */
describe('checkRateLimit', () => {
  it('allows requests under the limit', () => {
    const req = createMockRequest({
      url: '/api/health',
      headers: { 'x-forwarded-for': 'rate-under-limit-1' },
    });
    const result = checkRateLimit(req, '/api/health');
    expect(result.allowed).toBe(true);
  });

  it('blocks requests exceeding the limit for /api/llmcall (10 per minute)', () => {
    // /api/llmcall allows 10 requests per minute
    for (let i = 0; i < 10; i++) {
      const req = createMockRequest({
        url: '/api/llmcall',
        headers: { 'x-forwarded-for': 'rate-exceed-llm' },
      });
      checkRateLimit(req, '/api/llmcall');
    }

    const req = createMockRequest({
      url: '/api/llmcall',
      headers: { 'x-forwarded-for': 'rate-exceed-llm' },
    });
    const result = checkRateLimit(req, '/api/llmcall');
    expect(result.allowed).toBe(false);
    expect(result.resetTime).toBeDefined();
    expect(typeof result.resetTime).toBe('number');
  });

  it('returns resetTime as a future timestamp when blocked', () => {
    const now = Date.now();

    for (let i = 0; i < 10; i++) {
      const req = createMockRequest({
        url: '/api/llmcall',
        headers: { 'x-forwarded-for': 'rate-reset-time' },
      });
      checkRateLimit(req, '/api/llmcall');
    }

    const req = createMockRequest({
      url: '/api/llmcall',
      headers: { 'x-forwarded-for': 'rate-reset-time' },
    });
    const result = checkRateLimit(req, '/api/llmcall');
    expect(result.allowed).toBe(false);
    expect(result.resetTime).toBeGreaterThan(now);
  });

  it('allows requests to endpoints with no matching rate limit rule', () => {
    const req = createMockRequest({
      url: '/unknown-path',
      headers: { 'x-forwarded-for': 'rate-no-rule' },
    });
    const result = checkRateLimit(req, '/unknown-path');
    expect(result.allowed).toBe(true);
    expect(result.resetTime).toBeUndefined();
  });

  it('matches prefix patterns like /api/github-*', () => {
    // /api/github-* allows 30 per minute
    for (let i = 0; i < 30; i++) {
      const req = createMockRequest({
        url: '/api/github-stats',
        headers: { 'x-forwarded-for': 'rate-github-prefix' },
      });
      checkRateLimit(req, '/api/github-stats');
    }

    const req = createMockRequest({
      url: '/api/github-stats',
      headers: { 'x-forwarded-for': 'rate-github-prefix' },
    });
    const result = checkRateLimit(req, '/api/github-stats');
    expect(result.allowed).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * buildContentSecurityPolicy
 * ---------------------------------------------------------------------------
 */
describe('buildContentSecurityPolicy', () => {
  it('includes strict-dynamic and excludes unsafe-eval in production', () => {
    const csp = buildContentSecurityPolicy(true);
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain('upgrade-insecure-requests');
  });

  it('includes unsafe-eval and excludes strict-dynamic in development', () => {
    const csp = buildContentSecurityPolicy(false);
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).not.toContain("'strict-dynamic'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('always includes unsafe-inline for style-src', () => {
    const prodCsp = buildContentSecurityPolicy(true);
    const devCsp = buildContentSecurityPolicy(false);
    expect(prodCsp).toContain("style-src 'self' 'unsafe-inline'");
    expect(devCsp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('includes hardening directives (object-src none, base-uri self, form-action self)', () => {
    const csp = buildContentSecurityPolicy(true);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });
});

/*
 * ---------------------------------------------------------------------------
 * createSecurityHeaders
 * ---------------------------------------------------------------------------
 */
describe('createSecurityHeaders', () => {
  it('returns all expected security headers', () => {
    const headers = createSecurityHeaders('development');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-XSS-Protection']).toBe('1; mode=block');
    expect(headers['Content-Security-Policy']).toBeDefined();
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toContain('camera=()');
  });

  it('includes HSTS header in production', () => {
    const headers = createSecurityHeaders('production');
    expect(headers['Strict-Transport-Security']).toContain('max-age=31536000');
    expect(headers['Strict-Transport-Security']).toContain('includeSubDomains');
  });

  it('excludes HSTS header in development', () => {
    const headers = createSecurityHeaders('development');
    expect(headers).not.toHaveProperty('Strict-Transport-Security');
  });
});

/*
 * ---------------------------------------------------------------------------
 * validateApiKeyFormat
 * ---------------------------------------------------------------------------
 */
describe('validateApiKeyFormat', () => {
  it('accepts a valid anthropic API key', () => {
    const key = 'sk-ant-' + 'a'.repeat(80);
    expect(validateApiKeyFormat(key, 'anthropic')).toBe(true);
  });

  it('rejects keys shorter than provider minimum length', () => {
    expect(validateApiKeyFormat('short', 'openai')).toBe(false);
  });

  it('rejects placeholder keys containing "your_"', () => {
    const key = 'your_' + 'a'.repeat(100);
    expect(validateApiKeyFormat(key, 'anthropic')).toBe(false);
  });

  it('rejects placeholder keys containing "here"', () => {
    const key = 'put-key-here' + 'a'.repeat(100);
    expect(validateApiKeyFormat(key, 'openai')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateApiKeyFormat('', 'openai')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(validateApiKeyFormat(undefined as unknown as string, 'openai')).toBe(false);
    expect(validateApiKeyFormat(null as unknown as string, 'openai')).toBe(false);
  });

  it('uses a fallback minimum length for unknown providers', () => {
    // Unknown providers default to 20 char minimum
    const shortKey = 'a'.repeat(19);
    const okKey = 'a'.repeat(20);
    expect(validateApiKeyFormat(shortKey, 'unknown-provider')).toBe(false);
    expect(validateApiKeyFormat(okKey, 'unknown-provider')).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * sanitizeErrorMessage
 * ---------------------------------------------------------------------------
 */
describe('sanitizeErrorMessage', () => {
  it('shows full error message in development mode', () => {
    const err = new Error('Detailed internal error with API key leak');
    expect(sanitizeErrorMessage(err, true)).toBe('Detailed internal error with API key leak');
  });

  it('sanitizes errors mentioning sensitive terms in production', () => {
    expect(sanitizeErrorMessage(new Error('Invalid API key provided'))).toBe('Authentication failed');
    expect(sanitizeErrorMessage(new Error('token expired'))).toBe('Authentication failed');
    expect(sanitizeErrorMessage(new Error('secret mismatch'))).toBe('Authentication failed');
  });

  it('returns rate limit message for 429-related errors in production', () => {
    expect(sanitizeErrorMessage(new Error('rate limit exceeded'))).toBe('Rate limit exceeded. Please try again later.');
    expect(sanitizeErrorMessage(new Error('Server returned 429'))).toBe('Rate limit exceeded. Please try again later.');
  });

  it('returns generic message for unknown errors in production', () => {
    expect(sanitizeErrorMessage(new Error('some random error'))).toBe('An unexpected error occurred');
    expect(sanitizeErrorMessage('string error')).toBe('An unexpected error occurred');
    expect(sanitizeErrorMessage(42)).toBe('An unexpected error occurred');
  });

  it('converts non-Error values to string in development mode', () => {
    expect(sanitizeErrorMessage('raw string', true)).toBe('raw string');
    expect(sanitizeErrorMessage(42, true)).toBe('42');
  });
});

/*
 * ---------------------------------------------------------------------------
 * validateAuthToken
 * ---------------------------------------------------------------------------
 */
describe('validateAuthToken', () => {
  const originalEnv = process.env.BOLT_AUTH_TOKEN;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.BOLT_AUTH_TOKEN = originalEnv;
    } else {
      delete process.env.BOLT_AUTH_TOKEN;
    }
  });

  it('bypasses auth when BOLT_AUTH_TOKEN is not set', () => {
    delete process.env.BOLT_AUTH_TOKEN;

    const req = createMockRequest({ url: '/api/chat' });
    expect(validateAuthToken(req)).toBe(true);
  });

  it('validates a correct token from the X-Auth-Token header', () => {
    process.env.BOLT_AUTH_TOKEN = 'my-secret-token';

    const req = createMockRequest({
      url: '/api/chat',
      headers: { 'X-Auth-Token': 'my-secret-token' },
    });
    expect(validateAuthToken(req)).toBe(true);
  });

  it('rejects an incorrect token from the header', () => {
    process.env.BOLT_AUTH_TOKEN = 'my-secret-token';

    const req = createMockRequest({
      url: '/api/chat',
      headers: { 'X-Auth-Token': 'wrong-token' },
    });
    expect(validateAuthToken(req)).toBe(false);
  });

  it('reads token from the bolt-auth cookie as fallback', () => {
    process.env.BOLT_AUTH_TOKEN = 'cookie-token';

    const req = createMockRequest({
      url: '/api/chat',
      headers: { Cookie: 'other=val; bolt-auth=cookie-token; extra=foo' },
    });
    expect(validateAuthToken(req)).toBe(true);
  });

  it('rejects request when token is missing entirely', () => {
    process.env.BOLT_AUTH_TOKEN = 'expected-token';

    const req = createMockRequest({ url: '/api/chat' });
    expect(validateAuthToken(req)).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * withSecurity
 * ---------------------------------------------------------------------------
 */
describe('withSecurity', () => {
  const okHandler = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('returns 405 for disallowed HTTP methods', async () => {
    const secured = withSecurity(okHandler, { allowedMethods: ['GET'], rateLimit: false });
    const ctx = createMockContext({ method: 'POST', url: '/api/test' });
    const response = await secured(ctx);
    expect(response.status).toBe(405);
  });

  it('returns 401 when requireAuth is enabled and token is missing', async () => {
    process.env.BOLT_AUTH_TOKEN = 'required-token';

    const secured = withSecurity(okHandler, { requireAuth: true, rateLimit: false });
    const ctx = createMockContext({ method: 'GET', url: '/api/test' });
    const response = await secured(ctx);
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe(true);
    expect(body.message).toBe('Unauthorized');

    delete process.env.BOLT_AUTH_TOKEN;
  });

  it('adds security headers to successful responses', async () => {
    delete process.env.BOLT_AUTH_TOKEN;

    const secured = withSecurity(okHandler, { rateLimit: false });
    const ctx = createMockContext({
      method: 'GET',
      url: '/api/test',
      headers: { 'x-forwarded-for': 'sec-headers-ok' },
    });
    const response = await secured(ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('returns 500 with sanitized error when handler throws', async () => {
    const throwingHandler = async () => {
      throw new Error('some internal failure');
    };
    const secured = withSecurity(throwingHandler, { rateLimit: false });
    const ctx = createMockContext({ method: 'GET', url: '/api/test', headers: { 'x-forwarded-for': 'sec-error-500' } });
    const response = await secured(ctx);
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error).toBe(true);

    // In test NODE_ENV, should get sanitized message
    expect(body.message).toBeDefined();
  });

  it('returns 499 for EPIPE errors (client disconnect)', async () => {
    const epipeHandler = async () => {
      const err = new Error('write EPIPE') as NodeJS.ErrnoException;
      err.code = 'EPIPE';
      throw err;
    };
    const secured = withSecurity(epipeHandler, { rateLimit: false });
    const ctx = createMockContext({ method: 'GET', url: '/api/test', headers: { 'x-forwarded-for': 'sec-epipe' } });
    const response = await secured(ctx);
    expect(response.status).toBe(499);
  });
});
