/**
 * Vercel API Proxy
 *
 * A flexible proxy that routes all Vercel API requests through the server
 * to bypass CORS restrictions. This is necessary because Vercel's API
 * doesn't allow browser-based requests with custom headers.
 *
 * Usage:
 *   POST /api/vercel-proxy
 *   Body: { endpoint: '/v2/user', method: 'GET', body?: object }
 *
 * The proxy will:
 * 1. Get the Vercel token from cookies or Authorization header
 * 2. Make the request to Vercel API server-side
 * 3. Return the response to the client
 */

import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { externalFetch, resolveToken } from '~/lib/api/apiUtils';
import { withSecurity } from '~/lib/security';
import { successResponse, errorResponse } from '~/lib/api/responses';
import { AppError, AppErrorType } from '~/lib/api/errors';
import { AUTH_PRESETS } from '~/lib/security-config';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('VercelProxy');

const VERCEL_API_BASE = 'https://api.vercel.com';

interface ProxyRequest {
  /** Vercel API endpoint path (e.g., '/v2/user', '/v9/projects') */
  endpoint: string;

  /** HTTP method */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

  /** Request body for POST/PUT/PATCH */
  body?: Record<string, unknown>;

  /** Query parameters */
  params?: Record<string, string>;
}

/**
 * Handle GET requests - simple user info endpoint
 */
async function vercelProxyLoader({ request, context }: LoaderFunctionArgs) {
  const vercelToken = resolveToken(request, context, 'VITE_VERCEL_ACCESS_TOKEN');

  if (!vercelToken) {
    return errorResponse(new AppError(AppErrorType.UNAUTHORIZED, 'Vercel token not found'));
  }

  try {
    const response = await externalFetch({
      url: `${VERCEL_API_BASE}/v2/user`,
      token: vercelToken,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new AppError(AppErrorType.NETWORK, `Vercel API error: ${errorText}`, response.status);
    }

    const data = await response.json();

    return successResponse(data);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error);
    }

    logger.error('Vercel proxy loader failed', error);

    return errorResponse(error instanceof Error ? error : String(error));
  }
}

/**
 * Handle POST requests - flexible proxy for any Vercel API endpoint
 */
async function vercelProxyAction({ request, context }: ActionFunctionArgs) {
  const vercelToken = resolveToken(request, context, 'VITE_VERCEL_ACCESS_TOKEN');

  if (!vercelToken) {
    return errorResponse(new AppError(AppErrorType.UNAUTHORIZED, 'Vercel token not found'));
  }

  try {
    const proxyRequest: ProxyRequest = await request.json();
    const { endpoint, method = 'GET', body, params } = proxyRequest;

    if (!endpoint) {
      return errorResponse(new AppError(AppErrorType.VALIDATION, 'Missing endpoint in request body'));
    }

    let url = `${VERCEL_API_BASE}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;

    if (params && Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams(params);
      url += `?${searchParams.toString()}`;
    }

    const fetchOptions: RequestInit = {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${vercelToken}`,
        'User-Agent': 'bolt-app',
        'Content-Type': 'application/json',
      },
    };

    if (body && method !== 'GET') {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);

    const contentType = response.headers.get('content-type');
    let responseData: unknown;

    if (contentType?.includes('application/json')) {
      responseData = await response.json();
    } else {
      responseData = await response.text();
    }

    if (!response.ok) {
      throw new AppError(AppErrorType.NETWORK, `Vercel API error: ${response.status}`, response.status, {
        details: responseData,
      });
    }

    return successResponse(responseData);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error);
    }

    logger.error('Vercel proxy action failed', error);

    return errorResponse(error instanceof Error ? error : String(error));
  }
}

export const loader = withSecurity(vercelProxyLoader, { auth: AUTH_PRESETS.authenticated });

export const action = withSecurity(vercelProxyAction, { auth: AUTH_PRESETS.authenticated });
