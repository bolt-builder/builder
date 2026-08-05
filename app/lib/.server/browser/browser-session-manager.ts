/**
 * @module browser-session-manager
 * Server-side embedded browser sessions for the workbench Browser tab.
 *
 * Drives a real headless Chrome/Edge instance (found on the user's machine,
 * no bundled download) through playwright-core + CDP. Each session owns an
 * isolated browser context + page whose rendered output is streamed to the
 * client as JPEG screencast frames; the client forwards mouse/keyboard input
 * back through the API route.
 *
 * Lifecycle mirrors RuntimeManager: singleton, lazy launch, idle teardown.
 *
 * @see {@link app/routes/api.browser.ts} for the HTTP surface
 */

import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('BrowserSessions');

/** Sessions idle longer than this are torn down by the sweeper. */
const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Sweep interval for idle sessions. */
const SWEEP_INTERVAL_MS = 60 * 1000;

/** JPEG quality for screencast frames (0-100). */
const SCREENCAST_QUALITY = 60;

/** Minimum interval between frames fanned out to clients (~10 fps cap). */
const FRAME_MIN_INTERVAL_MS = 100;

/** Hard cap on screencast frame dimensions. */
const SCREENCAST_MAX_WIDTH = 1920;
const SCREENCAST_MAX_HEIGHT = 1080;

/** Default viewport when the client does not report a size. */
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

export interface BrowserFrame {
  /** Base64-encoded JPEG. */
  data: string;
  width: number;
  height: number;
}

export interface BrowserPageState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export type MouseEventInput =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'down'; x: number; y: number; button: 'left' | 'middle' | 'right'; clickCount: number }
  | { kind: 'up'; x: number; y: number; button: 'left' | 'middle' | 'right' }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number };

export type KeyEventInput = { kind: 'down' | 'up'; key: string } | { kind: 'insertText'; text: string };

interface BrowserSession {
  id: string;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  lastFrame: BrowserFrame | null;
  frameListeners: Set<(frame: BrowserFrame) => void>;
  stateListeners: Set<(state: BrowserPageState) => void>;
  loading: boolean;
  lastActivity: number;
  closed: boolean;
  lastFrameEmit: number;
  pendingFrameTimer: ReturnType<typeof setTimeout> | null;
}

/** Error thrown when no usable Chrome/Edge executable can be launched. */
export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserUnavailableError';
  }
}

export class BrowserSessionManager {
  static #instance: BrowserSessionManager | null = null;

  static getInstance(): BrowserSessionManager {
    if (!BrowserSessionManager.#instance) {
      BrowserSessionManager.#instance = new BrowserSessionManager();
    }

    return BrowserSessionManager.#instance;
  }

  #browser: Browser | null = null;
  #launching: Promise<Browser> | null = null;
  #sessions = new Map<string, BrowserSession>();
  #sweeper: ReturnType<typeof setInterval> | null = null;

  async #launchBrowser(): Promise<Browser> {
    if (this.#browser?.isConnected()) {
      return this.#browser;
    }

    if (this.#launching) {
      return this.#launching;
    }

    this.#launching = (async () => {
      const attempts: Array<{ label: string; options: Parameters<typeof chromium.launch>[0] }> = [];
      const envPath = process.env.CHROME_PATH || process.env.BROWSER_EXECUTABLE_PATH;

      if (envPath) {
        attempts.push({ label: `executable ${envPath}`, options: { executablePath: envPath, headless: true } });
      }

      attempts.push(
        { label: 'system Chrome', options: { channel: 'chrome', headless: true } },
        { label: 'system Edge', options: { channel: 'msedge', headless: true } },
        { label: 'playwright chromium', options: { headless: true } },
      );

      const failures: string[] = [];

      for (const attempt of attempts) {
        try {
          const browser = await chromium.launch(attempt.options);
          logger.info(`Launched embedded browser via ${attempt.label}`);
          browser.on('disconnected', () => {
            this.#browser = null;
          });

          return browser;
        } catch (err) {
          failures.push(`${attempt.label}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
        }
      }

      throw new BrowserUnavailableError(
        'No Chrome or Edge installation found for the embedded browser. ' +
          'Install Google Chrome or Microsoft Edge, or set CHROME_PATH to a Chromium executable. ' +
          `Tried: ${failures.join('; ')}`,
      );
    })();

    try {
      this.#browser = await this.#launching;

      return this.#browser;
    } finally {
      this.#launching = null;
    }
  }

  #ensureSweeper() {
    if (this.#sweeper) {
      return;
    }

    this.#sweeper = setInterval(() => {
      const now = Date.now();

      for (const session of this.#sessions.values()) {
        if (now - session.lastActivity > SESSION_IDLE_TIMEOUT_MS && session.frameListeners.size === 0) {
          logger.info(`Closing idle browser session ${session.id}`);
          void this.closeSession(session.id);
        }
      }
    }, SWEEP_INTERVAL_MS);

    this.#sweeper.unref?.();
  }

  #getSession(sessionId: string): BrowserSession {
    const session = this.#sessions.get(sessionId);

    if (!session || session.closed) {
      throw new Error(`Unknown browser session: ${sessionId}`);
    }

    session.lastActivity = Date.now();

    return session;
  }

  async #emitState(session: BrowserSession) {
    if (session.closed) {
      return;
    }

    let title = '';

    try {
      title = await session.page.title();
    } catch {
      // Page may be navigating; title is best-effort.
    }

    let canGoBack = false;
    let canGoForward = false;

    try {
      const history = (await session.cdp.send('Page.getNavigationHistory')) as {
        currentIndex: number;
        entries: unknown[];
      };
      canGoBack = history.currentIndex > 0;
      canGoForward = history.currentIndex < history.entries.length - 1;
    } catch {
      // CDP session may be detaching.
    }

    if (session.closed) {
      return;
    }

    const state: BrowserPageState = {
      url: session.page.url(),
      title,
      loading: session.loading,
      canGoBack,
      canGoForward,
    };

    for (const listener of session.stateListeners) {
      listener(state);
    }
  }

  async createSession(viewport?: { width: number; height: number }): Promise<string> {
    const browser = await this.#launchBrowser();
    const size = {
      width: Math.min(Math.max(viewport?.width ?? DEFAULT_VIEWPORT.width, 320), SCREENCAST_MAX_WIDTH),
      height: Math.min(Math.max(viewport?.height ?? DEFAULT_VIEWPORT.height, 240), SCREENCAST_MAX_HEIGHT),
    };

    const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);

    const session: BrowserSession = {
      id: randomUUID(),
      context,
      page,
      cdp,
      lastFrame: null,
      frameListeners: new Set(),
      stateListeners: new Set(),
      loading: false,
      lastActivity: Date.now(),
      closed: false,
      lastFrameEmit: 0,
      pendingFrameTimer: null,
    };

    const emitLatestFrame = () => {
      const frame = session.lastFrame;

      if (!frame || session.closed) {
        return;
      }

      session.lastFrameEmit = Date.now();

      for (const listener of session.frameListeners) {
        listener(frame);
      }
    };

    cdp.on(
      'Page.screencastFrame',
      (event: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
        session.lastFrame = {
          data: event.data,
          width: event.metadata.deviceWidth,
          height: event.metadata.deviceHeight,
        };

        /*
         * Throttle fan-out to ~10 fps: heavy pages (animations, video) can
         * push 60 screencast frames/s of ~200 KB each, which floods the SSE
         * stream and freezes the client tab. Always ack so Chrome keeps
         * capturing; emit at most every FRAME_MIN_INTERVAL_MS with a
         * trailing emit so the final frame always lands.
         */
        const now = Date.now();
        const elapsed = now - session.lastFrameEmit;

        if (elapsed >= FRAME_MIN_INTERVAL_MS) {
          emitLatestFrame();
        } else if (!session.pendingFrameTimer) {
          session.pendingFrameTimer = setTimeout(() => {
            session.pendingFrameTimer = null;
            emitLatestFrame();
          }, FRAME_MIN_INTERVAL_MS - elapsed);
        }

        void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
      },
    );

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        void this.#emitState(session);
      }
    });

    page.on('load', () => {
      session.loading = false;
      void this.#emitState(session);
    });

    page.on('close', () => {
      void this.closeSession(session.id);
    });

    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: SCREENCAST_QUALITY,
      maxWidth: SCREENCAST_MAX_WIDTH,
      maxHeight: SCREENCAST_MAX_HEIGHT,
      everyNthFrame: 1,
    });

    this.#sessions.set(session.id, session);
    this.#ensureSweeper();
    logger.info(`Created browser session ${session.id} (${size.width}x${size.height})`);

    return session.id;
  }

  async navigate(sessionId: string, url: string) {
    const session = this.#getSession(sessionId);
    session.loading = true;
    void this.#emitState(session);

    try {
      await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      logger.warn(`Navigation failed for ${url}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    } finally {
      session.loading = false;
      void this.#emitState(session);
    }
  }

  async goBack(sessionId: string) {
    const session = this.#getSession(sessionId);
    await session.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
    void this.#emitState(session);
  }

  async goForward(sessionId: string) {
    const session = this.#getSession(sessionId);
    await session.page.goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
    void this.#emitState(session);
  }

  async reload(sessionId: string) {
    const session = this.#getSession(sessionId);
    session.loading = true;
    void this.#emitState(session);
    await session.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    session.loading = false;
    void this.#emitState(session);
  }

  async dispatchMouse(sessionId: string, event: MouseEventInput) {
    const session = this.#getSession(sessionId);
    const { mouse } = session.page;

    switch (event.kind) {
      case 'move': {
        await mouse.move(event.x, event.y);
        break;
      }
      case 'down': {
        await mouse.move(event.x, event.y);
        await mouse.down({ button: event.button, clickCount: event.clickCount });
        break;
      }
      case 'up': {
        await mouse.up({ button: event.button });
        break;
      }
      case 'wheel': {
        await mouse.move(event.x, event.y);
        await mouse.wheel(event.deltaX, event.deltaY);
        break;
      }
    }
  }

  async dispatchKey(sessionId: string, event: KeyEventInput) {
    const session = this.#getSession(sessionId);
    const { keyboard } = session.page;

    if (event.kind === 'insertText') {
      await keyboard.insertText(event.text);
      return;
    }

    if (event.kind === 'down') {
      await keyboard.down(event.key);
    } else {
      await keyboard.up(event.key);
    }
  }

  async setViewport(sessionId: string, width: number, height: number) {
    const session = this.#getSession(sessionId);
    await session.page.setViewportSize({
      width: Math.min(Math.max(width, 320), SCREENCAST_MAX_WIDTH),
      height: Math.min(Math.max(height, 240), SCREENCAST_MAX_HEIGHT),
    });
  }

  getState(sessionId: string): { lastFrame: BrowserFrame | null } {
    const session = this.#getSession(sessionId);

    return { lastFrame: session.lastFrame };
  }

  /**
   * Subscribe to frames + page state for a session. Returns an unsubscribe fn.
   * The latest cached frame is replayed immediately so a reconnecting client
   * paints without waiting for the next repaint of the page.
   */
  subscribe(
    sessionId: string,
    onFrame: (frame: BrowserFrame) => void,
    onState: (state: BrowserPageState) => void,
  ): () => void {
    const session = this.#getSession(sessionId);
    session.frameListeners.add(onFrame);
    session.stateListeners.add(onState);

    if (session.lastFrame) {
      onFrame(session.lastFrame);
    }

    void this.#emitState(session);

    return () => {
      session.frameListeners.delete(onFrame);
      session.stateListeners.delete(onState);
      session.lastActivity = Date.now();
    };
  }

  async closeSession(sessionId: string) {
    const session = this.#sessions.get(sessionId);

    if (!session || session.closed) {
      return;
    }

    session.closed = true;
    this.#sessions.delete(sessionId);
    session.frameListeners.clear();
    session.stateListeners.clear();

    if (session.pendingFrameTimer) {
      clearTimeout(session.pendingFrameTimer);
      session.pendingFrameTimer = null;
    }

    await session.context.close().catch(() => {});
    logger.info(`Closed browser session ${sessionId}`);

    if (this.#sessions.size === 0 && this.#browser) {
      const browser = this.#browser;
      this.#browser = null;
      await browser.close().catch(() => {});
      logger.info('Closed embedded browser (no active sessions)');
    }
  }
}
