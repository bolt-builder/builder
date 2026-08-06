/// <reference types="vitest/globals" />
import {
  validateBearerToken,
  checkApiRateLimit,
  _resetApiRateLimitStore,
  requireApiAuth,
} from '~/lib/.server/api/auth';

/*
 * ---------------------------------------------------------------------------
 * validateBearerToken
 * ---------------------------------------------------------------------------
 */
describe('validateBearerToken', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('rejects when BOLT_API_KEY is not configured', () => {
    delete process.env.BOLT_API_KEY;

    const req = new Request('http://localhost/api/v1/status', {
      headers: { Authorization: 'Bearer some-token' },
    });
    const result = validateBearerToken(req);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('not_configured');
  });

  it('rejects when Authorization header is missing', () => {
    process.env.BOLT_API_KEY = 'test-secret-key-123';

    const req = new Request('http://localhost/api/v1/status');
    const result = validateBearerToken(req);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_header');
  });

  it('rejects malformed Authorization header (no Bearer prefix)', () => {
    process.env.BOLT_API_KEY = 'test-secret-key-123';

    const req = new Request('http://localhost/api/v1/status', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    const result = validateBearerToken(req);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('malformed');
  });

  it('rejects malformed Authorization header (Bearer with empty token)', () => {
    process.env.BOLT_API_KEY = 'test-secret-key-123';

    const req = new Request('http://localhost/api/v1/status', {
      headers: { Authorization: 'Bearer ' },
    });
    const result = validateBearerToken(req);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('malformed');
  });

  it('rejects invalid token (wrong value)', () => {
    process.env.BOLT_API_KEY = 'test-secret-key-123';

    const req = new Request('http://localhost/api/v1/status', {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    const result = validateBearerToken(req);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid');
  });

  it('accepts valid Bearer token', () => {
    process.env.BOLT_API_KEY = 'test-secret-key-123';

    const req = new Request('http://localhost/api/v1/status', {
      headers: { Authorization: 'Bearer test-secret-key-123' },
    });
    const result = validateBearerToken(req);

    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

/*
 * ---------------------------------------------------------------------------
 * checkApiRateLimit
 * ---------------------------------------------------------------------------
 */
describe('checkApiRateLimit', () => {
  beforeEach(() => {
    _resetApiRateLimitStore();
  });

  it('allows requests under the limit', () => {
    const result = checkApiRateLimit('key-under-limit');
    expect(result.allowed).toBe(true);
  });

  it('blocks requests exceeding the limit (60 per window)', () => {
    for (let i = 0; i < 60; i++) {
      checkApiRateLimit('key-exceed');
    }

    const result = checkApiRateLimit('key-exceed');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeDefined();
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(0);
  });

  it('uses separate counters per API key', () => {
    for (let i = 0; i < 60; i++) {
      checkApiRateLimit('key-a-full');
    }

    // key-a is exhausted
    expect(checkApiRateLimit('key-a-full').allowed).toBe(false);

    // key-b should still be allowed
    expect(checkApiRateLimit('key-b-fresh').allowed).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * requireApiAuth middleware
 * ---------------------------------------------------------------------------
 */
describe('requireApiAuth', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.BOLT_API_KEY = 'integration-test-key';
    _resetApiRateLimitStore();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns 401 when Bearer token is missing', async () => {
    const handler = vi.fn().mockResolvedValue(new Response('ok'));
    const wrapped = requireApiAuth(handler);

    const args = {
      request: new Request('http://localhost/api/v1/chat', { method: 'POST' }),
      params: {},
      context: {},
    };

    const response = (await wrapped(args as any)) as Response;
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();

    const body = await response.json();
    expect(body.error).toBe(true);
  });

  it('calls handler when Bearer token is valid', async () => {
    const handler = vi.fn().mockResolvedValue(new Response('ok'));
    const wrapped = requireApiAuth(handler);

    const args = {
      request: new Request('http://localhost/api/v1/chat', {
        method: 'POST',
        headers: { Authorization: 'Bearer integration-test-key' },
      }),
      params: {},
      context: {},
    };

    const response = (await wrapped(args as any)) as Response;
    expect(handler).toHaveBeenCalled();
    expect(response.status).toBe(200);
  });
});
