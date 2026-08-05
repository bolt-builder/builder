/// <reference types="vitest/globals" />
import type { AppLoadContext, LoaderFunctionArgs, ActionFunctionArgs } from 'react-router';

/**
 * Options for creating a mock Request object.
 */
interface MockRequestOptions {
  /** HTTP method (default: 'GET') */
  method?: string;

  /** URL path (default: '/') */
  url?: string;

  /** Request headers as key-value pairs */
  headers?: Record<string, string>;

  /** Request body — will be JSON-stringified if it is an object */
  body?: BodyInit | Record<string, unknown> | null;

  /** URL search params to append to the URL */
  searchParams?: Record<string, string>;
}

/**
 * Options for creating a mock Remix context.
 */
interface MockContextOptions {
  /** HTTP method for the embedded request (default: 'GET') */
  method?: string;

  /** URL path for the embedded request (default: '/') */
  url?: string;

  /** Request headers */
  headers?: Record<string, string>;

  /** Request body */
  body?: BodyInit | Record<string, unknown> | null;

  /** URL search params */
  searchParams?: Record<string, string>;

  /** URL route params (e.g. { id: '123' }) */
  params?: Record<string, string>;

  /** Custom cloudflare env values */
  cloudflareEnv?: Record<string, string>;
}

/**
 * Creates a mock Web API Request suitable for testing Remix API routes.
 *
 * @example
 * ```ts
 * const req = createMockRequest({ method: 'POST', url: '/api/health' });
 * ```
 */
export function createMockRequest(options: MockRequestOptions = {}): Request {
  const { method = 'GET', headers = {}, body = null, searchParams = {} } = options;
  const { url = '/' } = options;

  // Build full URL with origin so the URL constructor doesn't throw
  const base = 'http://localhost';
  const urlObj = new URL(url, base);

  for (const [key, value] of Object.entries(searchParams)) {
    urlObj.searchParams.set(key, value);
  }

  const requestHeaders = new Headers(headers);

  let requestBody: BodyInit | null = null;

  if (body !== null && body !== undefined) {
    if (
      typeof body === 'object' &&
      !(body instanceof ReadableStream) &&
      !(body instanceof Blob) &&
      !(body instanceof FormData) &&
      !(body instanceof URLSearchParams) &&
      !(body instanceof ArrayBuffer)
    ) {
      requestBody = JSON.stringify(body);

      if (!requestHeaders.has('Content-Type')) {
        requestHeaders.set('Content-Type', 'application/json');
      }
    } else {
      requestBody = body as BodyInit;
    }
  }

  const init: RequestInit = {
    method,
    headers: requestHeaders,
  };

  // GET and HEAD requests cannot have a body per the Fetch spec
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = requestBody;
  }

  return new Request(urlObj.toString(), init);
}

/**
 * Creates a mock Remix LoaderFunctionArgs / ActionFunctionArgs context
 * suitable for testing route loaders and actions.
 *
 * @example
 * ```ts
 * const ctx = createMockContext({ url: '/api/check-env-key', searchParams: { provider: 'openai' } });
 * const response = await loader(ctx);
 * ```
 */
export function createMockContext(options: MockContextOptions = {}): LoaderFunctionArgs & ActionFunctionArgs {
  const { params = {}, cloudflareEnv = {} } = options;

  const request = createMockRequest({
    method: options.method,
    url: options.url,
    headers: options.headers,
    body: options.body,
    searchParams: options.searchParams,
  });

  const context: AppLoadContext = {
    cloudflare: {
      env: cloudflareEnv as Record<string, string>,
    },
  };

  return {
    request,
    params,
    context,
    url: new URL(request.url),
    pattern: '',
  } as LoaderFunctionArgs & ActionFunctionArgs;
}
