/**
 * @module server
 * Custom React Router v7 production server with WebSocket support.
 *
 * Replaces the default `@react-router/serve` entry to attach a WebSocket upgrade
 * handler on the `/ws` path — same HTTP port, no extra process.
 *
 * Usage (production):
 *   node --import ./instrument.server.mjs ./server.js
 *
 * In development, Vite manages its own server; this file is NOT used.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadableStreamFromReadable } from '@react-router/node';
import { createRequestHandler } from 'react-router';
import { handleUpgrade } from './app/lib/.server/ws/ws-server';

const PORT = Number(process.env.PORT) || 5173;

function log(level: string, ...args: unknown[]) {
  const timestamp = new Date().toISOString();

  console[level === 'error' ? 'error' : 'log'](`[${timestamp}] [Server]`, ...args);
}

/*
 * ---------------------------------------------------------------------------
 * React Router request handler
 * ---------------------------------------------------------------------------
 */

// @ts-ignore — build output is JavaScript, no type declarations
const build = await import('./build/server/index.js');

// @ts-expect-error — build is untyped (JS output), but satisfies ServerBuild at runtime
const requestHandler = createRequestHandler({ build, mode: process.env.NODE_ENV });

/*
 * ---------------------------------------------------------------------------
 * Node → Web Request adapter
 * ---------------------------------------------------------------------------
 */

function createWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? `localhost:${PORT}`;
  const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const url = new URL(req.url ?? '/', `${protocol}://${host}`);

  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const v of value) {
        headers.append(key, v);
      }
    } else {
      headers.set(key, value);
    }
  }

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const init: RequestInit = {
    method,
    headers,
  };

  if (hasBody) {
    init.body = createReadableStreamFromReadable(req as unknown as import('node:stream').Readable);
    (init as Record<string, unknown>).duplex = 'half';
  }

  return new Request(url.href, init);
}

/*
 * ---------------------------------------------------------------------------
 * Web Response → Node adapter
 * ---------------------------------------------------------------------------
 */

async function sendWebResponse(res: ServerResponse, webResponse: Response): Promise<void> {
  res.statusCode = webResponse.status;
  res.statusMessage = webResponse.statusText;

  for (const [key, value] of webResponse.headers) {
    // Headers with multiple values (e.g. Set-Cookie) need appendHeader
    res.appendHeader(key, value);
  }

  if (!webResponse.body) {
    res.end();

    return;
  }

  const reader = webResponse.body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      res.write(value);
    }
  } catch (err) {
    // Client disconnected (EPIPE / ECONNRESET) — silently ignore
    const code = (err as NodeJS.ErrnoException).code;

    if (code !== 'EPIPE' && code !== 'ECONNRESET' && code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      log('error', 'Error writing response:', err);
    }
  } finally {
    res.end();
  }
}

/*
 * ---------------------------------------------------------------------------
 * HTTP Server
 * ---------------------------------------------------------------------------
 */

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const webRequest = createWebRequest(req);
    const webResponse = await requestHandler(webRequest);
    await sendWebResponse(res, webResponse);
  } catch (err) {
    log('error', 'Unhandled request error:', err);
    res.statusCode = 500;
    res.end('Internal Server Error');
  }
});

// Attach WebSocket upgrade handler — only intercepts /ws
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/ws') {
    handleUpgrade(req, socket, head);

    return;
  }

  /*
   * Not our path — destroy the socket so other upgrade handlers aren't confused
   * (In production there shouldn't be any HMR upgrades, but guard anyway.)
   */
  socket.destroy();
});

server.listen(PORT, () => {
  log('info', `Bolt server listening on http://localhost:${PORT}`);
  log('info', `WebSocket endpoint: ws://localhost:${PORT}/ws`);
});

/*
 * ---------------------------------------------------------------------------
 * Graceful shutdown — release port on SIGINT / SIGTERM
 * ---------------------------------------------------------------------------
 */

function shutdown(signal: string) {
  log('info', `Received ${signal}, shutting down…`);
  server.close(() => {
    log('info', 'Server closed');
    process.exit(0);
  });

  // Force exit after 5 s if connections are still draining
  setTimeout(() => {
    log('error', 'Forced exit — connections did not drain in time');
    process.exit(1);
  }, 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
