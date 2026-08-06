/**
 * @module ws-server
 * WebSocket server for real-time streaming alongside SSE fallback.
 *
 * Runs on the same HTTP server as Remix via the `upgrade` event handler.
 * Authenticates connections using the BOLT_API_KEY (query param `?token=`).
 * Routes messages to type-specific handlers (chat, terminal, filesystem).
 *
 * @see {@link ./ws-handlers.ts} for message handler implementations
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { createScopedLogger } from '~/utils/logger';
import { routeMessage, type WsMessageType } from './ws-handlers';

const logger = createScopedLogger('WebSocket');

/*
 * ---------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------------
 */

/** Extended WebSocket with metadata for connection management. */
export interface AuthenticatedWebSocket extends WebSocket {
  isAlive: boolean;
  clientId: string;
}

/** Inbound JSON message protocol. */
export interface WsMessage {
  type: WsMessageType;
  payload: unknown;
}

/*
 * ---------------------------------------------------------------------------
 * Singleton WebSocket server
 * ---------------------------------------------------------------------------
 */

let wss: WebSocketServer | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

/** 30-second ping/pong heartbeat to detect dead connections. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Counter for generating unique client IDs. */
let clientIdCounter = 0;

/**
 * Get or create the singleton `WebSocketServer` (noServer mode).
 *
 * Uses `noServer: true` so we control `handleUpgrade` manually —
 * this keeps the WS path (`/ws`) separated from Remix HMR (`/__remix_hmr`).
 */
export function getOrCreateWebSocketServer(): WebSocketServer {
  if (wss) {
    return wss;
  }

  wss = new WebSocketServer({ noServer: true });

  // Heartbeat: detect and clean up dead connections
  heartbeatInterval = setInterval(() => {
    if (!wss) {
      return;
    }

    for (const ws of wss.clients) {
      const client = ws as AuthenticatedWebSocket;

      if (!client.isAlive) {
        logger.debug(`Terminating unresponsive client: ${client.clientId}`);
        client.terminate();
        continue;
      }

      client.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    const client = ws as AuthenticatedWebSocket;
    client.isAlive = true;
    client.clientId = `ws-client-${++clientIdCounter}`;

    logger.info(`Client connected: ${client.clientId}`);

    // Pong keeps the connection alive
    ws.on('pong', () => {
      (ws as AuthenticatedWebSocket).isAlive = true;
    });

    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      handleIncomingMessage(client, raw);
    });

    ws.on('error', (err: Error) => {
      logger.error(`Client ${client.clientId} error:`, err.message);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      logger.info(
        `Client ${client.clientId} disconnected (code=${code}, reason=${reason.toString('utf-8') || 'none'})`,
      );
    });

    // Send connection acknowledgment
    sendMessage(client, {
      type: 'system' as WsMessageType,
      payload: { status: 'connected', clientId: client.clientId },
    });
  });

  wss.on('error', (err: Error) => {
    logger.error('WebSocketServer error:', err.message);
  });

  logger.info('WebSocket server created (noServer mode)');

  return wss;
}

/**
 * Shut down the WebSocket server and clean up resources.
 * Used in tests and during graceful server shutdown.
 */
export function shutdownWebSocketServer(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  if (wss) {
    for (const client of wss.clients) {
      client.close(1001, 'Server shutting down');
    }

    wss.close();
    wss = null;
  }

  clientIdCounter = 0;
  logger.info('WebSocket server shut down');
}

/*
 * ---------------------------------------------------------------------------
 * HTTP Upgrade Handler
 * ---------------------------------------------------------------------------
 */

/**
 * Validate a token against BOLT_API_KEY using timing-safe comparison.
 * Returns true when the token matches, false otherwise.
 */
export function validateWsToken(token: string | null): boolean {
  const expected = process.env.BOLT_API_KEY;

  if (!expected || !token) {
    return false;
  }

  try {
    const expectedBuf = Buffer.from(expected, 'utf-8');
    const tokenBuf = Buffer.from(token, 'utf-8');

    if (expectedBuf.length !== tokenBuf.length) {
      return false;
    }

    return timingSafeEqual(expectedBuf, tokenBuf);
  } catch {
    return false;
  }
}

/**
 * Handle an HTTP `upgrade` event.
 *
 * - Validates the request path is `/ws`
 * - Authenticates via `?token=` query parameter
 * - Upgrades the connection and emits `connection` on the WebSocketServer
 *
 * Attach this to `server.on('upgrade', handleUpgrade)`.
 */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);

  // Only handle /ws — let other paths (e.g. /__remix_hmr) pass through
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();

    return;
  }

  const token = url.searchParams.get('token');

  if (!validateWsToken(token)) {
    logger.warn(`Rejected unauthenticated WebSocket connection from ${req.socket.remoteAddress}`);
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();

    return;
  }

  const server = getOrCreateWebSocketServer();

  server.handleUpgrade(req, socket, head, (ws) => {
    server.emit('connection', ws, req);
  });
}

/*
 * ---------------------------------------------------------------------------
 * Message Handling
 * ---------------------------------------------------------------------------
 */

/**
 * Parse and route an incoming WebSocket message.
 */
function handleIncomingMessage(client: AuthenticatedWebSocket, raw: Buffer | ArrayBuffer | Buffer[]): void {
  let text: string;

  try {
    if (Buffer.isBuffer(raw)) {
      text = raw.toString('utf-8');
    } else if (raw instanceof ArrayBuffer) {
      text = Buffer.from(raw).toString('utf-8');
    } else {
      text = Buffer.concat(raw).toString('utf-8');
    }
  } catch {
    sendError(client, 'Failed to decode message');

    return;
  }

  let message: WsMessage;

  try {
    message = JSON.parse(text) as WsMessage;
  } catch {
    sendError(client, 'Invalid JSON');

    return;
  }

  if (!message.type || typeof message.type !== 'string') {
    sendError(client, 'Missing or invalid "type" field');

    return;
  }

  routeMessage(client, message.type, message.payload);
}

/*
 * ---------------------------------------------------------------------------
 * Outbound helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Send a JSON message to a connected client.
 * Silently drops the message if the socket is not open.
 */
export function sendMessage(ws: WebSocket, message: { type: string; payload: unknown }): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  try {
    ws.send(JSON.stringify(message));
  } catch (err) {
    logger.error('Failed to send message:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Send an error message to a connected client.
 */
export function sendError(ws: WebSocket, error: string): void {
  sendMessage(ws, { type: 'error', payload: { error } });
}

/**
 * Broadcast a message to all connected clients.
 */
export function broadcast(message: { type: string; payload: unknown }): void {
  const server = wss;

  if (!server) {
    return;
  }

  const data = JSON.stringify(message);

  for (const client of server.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(data);
      } catch {
        // Client may have disconnected between the check and the send
      }
    }
  }
}

/**
 * Get the current number of connected clients.
 */
export function getConnectedClientCount(): number {
  return wss?.clients.size ?? 0;
}
