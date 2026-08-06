/// <reference types="vitest/globals" />
import { createMockContext } from '~/test/test-utils';
import { _resetApiRateLimitStore } from '~/lib/.server/api/auth';

// Mock the logger to avoid noisy output
vi.mock('~/utils/logger', () => ({
  createScopedLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
  }),
}));

// Mock stream-text so we don't need real LLM providers
vi.mock('~/lib/.server/llm/stream-text', () => ({
  streamText: vi.fn().mockResolvedValue({
    fullStream: (async function* () {
      yield { type: 'text-delta', textDelta: 'Hello' };
      yield { type: 'text-delta', textDelta: ' world' };
    })(),
  }),
}));

// Mock constants to avoid LLMManager initialization
vi.mock('~/utils/constants', () => ({
  DEFAULT_MODEL: 'test-model',
  DEFAULT_PROVIDER: { name: 'TestProvider' },
  WORK_DIR: '/home/project',
}));

// Import the route AFTER mocks are set up
const { action } = await import('~/routes/api.v1.chat');

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.BOLT_API_KEY = 'test-api-key-for-chat';
  _resetApiRateLimitStore();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

// Helper to create an authenticated POST request
function createAuthenticatedCtx(body: Record<string, unknown>) {
  return createMockContext({
    method: 'POST',
    url: '/api/v1/chat',
    headers: { Authorization: 'Bearer test-api-key-for-chat' },
    body,
  });
}

/*
 * ---------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------------
 */
describe('POST /api/v1/chat', () => {
  it('returns a streamed SSE response for a valid request', async () => {
    const ctx = createAuthenticatedCtx({
      model: 'claude-3-5-sonnet-latest',
      prompt: 'Say hello',
    });

    const response = await action(ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');

    // Read the stream to verify SSE format
    const text = await response.text();
    expect(text).toContain('data:');
    expect(text).toContain('"type":"text"');
    expect(text).toContain('"type":"done"');
  });

  it('rejects invalid body with 400 and Zod validation details', async () => {
    const ctx = createAuthenticatedCtx({
      // missing required 'model' and 'prompt'
      context: 'some context',
    });

    const response = await action(ctx);

    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe(true);
    expect(body.message).toBe('Invalid request');
    expect(body.details).toBeDefined();
    expect(body.details.length).toBeGreaterThan(0);
  });

  it('enforces withSecurity — rejects disallowed HTTP method (GET)', async () => {
    const ctx = createMockContext({
      method: 'GET',
      url: '/api/v1/chat',
      headers: { Authorization: 'Bearer test-api-key-for-chat' },
    });

    const response = await action(ctx);

    // withSecurity returns 405 for disallowed methods
    expect(response.status).toBe(405);
  });

  it('returns 401 when Bearer token is missing (auth enforcement)', async () => {
    const ctx = createMockContext({
      method: 'POST',
      url: '/api/v1/chat',
      body: { model: 'test', prompt: 'hello' },
    });

    const response = await action(ctx);
    expect(response.status).toBe(401);
  });

  it('returns 429 when API rate limit is exceeded', async () => {
    // Exhaust the rate limit (60 requests)
    for (let i = 0; i < 60; i++) {
      const ctx = createAuthenticatedCtx({
        model: 'test-model',
        prompt: `request ${i}`,
      });
      await action(ctx);
    }

    // 61st request should be rate limited
    const ctx = createAuthenticatedCtx({
      model: 'test-model',
      prompt: 'one too many',
    });

    const response = await action(ctx);
    expect(response.status).toBe(429);

    const body = await response.json();
    expect(body.error).toBe(true);
    expect(body.message).toBe('Rate limit exceeded');
  });
});
