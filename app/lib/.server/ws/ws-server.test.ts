/// <reference types="vitest/globals" />
import { WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import {
  shutdownWebSocketServer,
  handleUpgrade,
  validateWsToken,
  getConnectedClientCount,
} from '~/lib/.server/ws/ws-server';
import { _resetSubscriptions } from '~/lib/.server/ws/ws-handlers';

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

const ORIGINAL_ENV = process.env;
const TEST_TOKEN = 'test-ws-api-key-secret';

/** Create a throwaway HTTP server with the WebSocket upgrade handler attached. */
async function createTestServer(): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  server.on('upgrade', handleUpgrade);

  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

/**
 * Open an authenticated WebSocket connection and return the socket
 * along with any messages that arrived during the handshake (e.g. the ack).
 */
function connectWs(port: number, token: string = TEST_TOKEN): Promise<{ ws: WebSocket; earlyMessages: unknown[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const earlyMessages: unknown[] = [];

    ws.on('message', (data: Buffer) => {
      earlyMessages.push(JSON.parse(data.toString('utf-8')));
    });

    ws.once('open', () => {
      // Give a small tick for any messages already queued server-side
      setTimeout(() => resolve({ ws, earlyMessages }), 50);
    });

    ws.once('error', reject);
  });
}

/** Collect the next N messages from a WebSocket as parsed JSON. */
function collectMessages(ws: WebSocket, count: number, timeoutMs = 2000): Promise<unknown[]> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];

    const timer = setTimeout(() => {
      ws.removeListener('message', onMsg);
      resolve(messages);
    }, timeoutMs);

    function onMsg(data: Buffer) {
      messages.push(JSON.parse(data.toString('utf-8')));

      if (messages.length >= count) {
        clearTimeout(timer);
        ws.removeListener('message', onMsg);
        resolve(messages);
      }
    }

    ws.on('message', onMsg);
  });
}

/*
 * ---------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------------
 */

describe('WebSocket Server', () => {
  let testServer: Awaited<ReturnType<typeof createTestServer>>;

  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV, BOLT_API_KEY: TEST_TOKEN };
    testServer = await createTestServer();
  });

  afterEach(async () => {
    shutdownWebSocketServer();
    _resetSubscriptions();
    await testServer.close();
    process.env = ORIGINAL_ENV;
  });

  // ── Test 1: Connection upgrade handling ────────────────────────────────
  describe('connection upgrade handling', () => {
    it('upgrades to WebSocket on /ws with valid token and receives ack', async () => {
      const { ws, earlyMessages } = await connectWs(testServer.port);

      // The connection ack should have arrived during the handshake
      expect(earlyMessages.length).toBeGreaterThanOrEqual(1);

      const ack = earlyMessages[0] as { type: string; payload: { status: string; clientId: string } };
      expect(ack.type).toBe('system');
      expect(ack.payload.status).toBe('connected');
      expect(ack.payload.clientId).toMatch(/^ws-client-\d+$/);

      ws.close();
    });

    it('rejects connections to paths other than /ws', async () => {
      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${testServer.port}/other?token=${TEST_TOKEN}`);
          ws.once('open', () => {
            ws.close();
            reject(new Error('Should not have connected'));
          });
          ws.once('error', () => resolve());
          ws.once('close', () => resolve());
        }),
      ).resolves.toBeUndefined();
    });
  });

  // ── Test 2: Auth token validation on connect ───────────────────────────
  describe('auth token validation on connect', () => {
    it('rejects connections without a token', async () => {
      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${testServer.port}/ws`);
          ws.once('open', () => {
            ws.close();
            reject(new Error('Should not have connected without token'));
          });
          ws.once('error', () => resolve());

          // unexpected:close also counts as rejection
          ws.once('close', () => resolve());
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects connections with an invalid token', async () => {
      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${testServer.port}/ws?token=wrong-token`);
          ws.once('open', () => {
            ws.close();
            reject(new Error('Should not have connected with wrong token'));
          });
          ws.once('error', () => resolve());
          ws.once('close', () => resolve());
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects when BOLT_API_KEY is not configured', async () => {
      delete process.env.BOLT_API_KEY;

      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${testServer.port}/ws?token=any-token`);
          ws.once('open', () => {
            ws.close();
            reject(new Error('Should not have connected without API key configured'));
          });
          ws.once('error', () => resolve());
          ws.once('close', () => resolve());
        }),
      ).resolves.toBeUndefined();
    });
  });

  // ── Test 3: Message routing for chat/terminal/filesystem ───────────────
  describe('message routing for chat/terminal/filesystem events', () => {
    it('routes chat subscribe and returns confirmation', async () => {
      const { ws } = await connectWs(testServer.port);

      // Send chat subscribe
      ws.send(JSON.stringify({ type: 'chat', payload: { action: 'subscribe' } }));

      const messages = await collectMessages(ws, 1);
      const response = messages[0] as { type: string; payload: { status: string } };
      expect(response.type).toBe('chat');
      expect(response.payload.status).toBe('subscribed');

      ws.close();
    });

    it('routes terminal subscribe with sessionId and returns confirmation', async () => {
      const { ws } = await connectWs(testServer.port);

      ws.send(
        JSON.stringify({
          type: 'terminal',
          payload: { action: 'subscribe', sessionId: 'term-001' },
        }),
      );

      const messages = await collectMessages(ws, 1);
      const response = messages[0] as { type: string; payload: { status: string; sessionId: string } };
      expect(response.type).toBe('terminal');
      expect(response.payload.status).toBe('subscribed');
      expect(response.payload.sessionId).toBe('term-001');

      ws.close();
    });

    it('routes filesystem subscribe and returns confirmation', async () => {
      const { ws } = await connectWs(testServer.port);

      ws.send(
        JSON.stringify({
          type: 'filesystem',
          payload: { action: 'subscribe', projectId: 'proj-123' },
        }),
      );

      const messages = await collectMessages(ws, 1);
      const response = messages[0] as { type: string; payload: { status: string; projectId: string } };
      expect(response.type).toBe('filesystem');
      expect(response.payload.status).toBe('subscribed');
      expect(response.payload.projectId).toBe('proj-123');

      ws.close();
    });

    it('returns error for unknown message type', async () => {
      const { ws } = await connectWs(testServer.port);

      ws.send(JSON.stringify({ type: 'unknown_type', payload: {} }));

      const messages = await collectMessages(ws, 1);
      const response = messages[0] as { type: string; payload: { error: string } };
      expect(response.type).toBe('error');
      expect(response.payload.error).toContain('Unknown message type');

      ws.close();
    });

    it('returns error for invalid JSON', async () => {
      const { ws } = await connectWs(testServer.port);

      ws.send('not-valid-json{{{');

      const messages = await collectMessages(ws, 1);
      const response = messages[0] as { type: string; payload: { error: string } };
      expect(response.type).toBe('error');
      expect(response.payload.error).toContain('Invalid JSON');

      ws.close();
    });
  });

  // ── Test 4: Graceful disconnect / reconnect ────────────────────────────
  describe('graceful disconnect/reconnect', () => {
    it('handles client disconnect without server crash', async () => {
      const { ws } = await connectWs(testServer.port);
      expect(getConnectedClientCount()).toBe(1);

      // Close the connection and wait for cleanup
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        ws.close();
      });

      // Give a tick for the server to process the close
      await new Promise((r) => setTimeout(r, 50));
      expect(getConnectedClientCount()).toBe(0);

      // Server should still be operational — connect another client
      const { ws: ws2, earlyMessages } = await connectWs(testServer.port);
      expect(earlyMessages.length).toBeGreaterThanOrEqual(1);
      expect(getConnectedClientCount()).toBe(1);

      ws2.close();
    });

    it('handles rapid connect/disconnect cycles', async () => {
      const connections: WebSocket[] = [];

      for (let i = 0; i < 5; i++) {
        const { ws } = await connectWs(testServer.port);
        connections.push(ws);
      }

      expect(getConnectedClientCount()).toBe(5);

      // Close all and wait
      await Promise.all(
        connections.map(
          (ws) =>
            new Promise<void>((resolve) => {
              ws.once('close', () => resolve());
              ws.close();
            }),
        ),
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(getConnectedClientCount()).toBe(0);
    });
  });

  // ── Test 5: validateWsToken unit tests ─────────────────────────────────
  describe('validateWsToken', () => {
    it('returns true for valid token', () => {
      expect(validateWsToken(TEST_TOKEN)).toBe(true);
    });

    it('returns false for null token', () => {
      expect(validateWsToken(null)).toBe(false);
    });

    it('returns false for empty string token', () => {
      expect(validateWsToken('')).toBe(false);
    });

    it('returns false for wrong token', () => {
      expect(validateWsToken('wrong-token')).toBe(false);
    });

    it('returns false when BOLT_API_KEY is not set', () => {
      delete process.env.BOLT_API_KEY;
      expect(validateWsToken('any-token')).toBe(false);
    });
  });
});
