import type { RuntimeProvider, PortEvent, Disposer } from '~/lib/runtime/runtime-provider';
import { atom } from 'nanostores';
import { createScopedLogger } from '~/utils/logger';
import { versionsStore } from '~/lib/stores/versions';

const logger = createScopedLogger('PreviewsStore');

// Extend Window interface to include our custom property
declare global {
  interface Window {
    _tabId?: string;
  }
}

export interface PreviewInfo {
  port: number;
  ready: boolean;
  baseUrl: string;
}

// Create a broadcast channel for preview updates
const PREVIEW_CHANNEL = 'preview-updates';

export class PreviewsStore {
  #availablePreviews = new Map<number, PreviewInfo>();
  #runtime: Promise<RuntimeProvider>;
  #broadcastChannel?: BroadcastChannel;
  #lastUpdate = new Map<string, number>();
  #refreshTimeouts = new Map<string, NodeJS.Timeout>();
  #REFRESH_DELAY = 300;
  #storageChannel?: BroadcastChannel;
  #disposePortEvents: Disposer | undefined;
  #resetTimer: ReturnType<typeof setTimeout> | undefined;

  previews = atom<PreviewInfo[]>([]);

  constructor(runtimePromise: Promise<RuntimeProvider>) {
    this.#runtime = runtimePromise;
    this.#broadcastChannel = this.#maybeCreateChannel(PREVIEW_CHANNEL);
    this.#storageChannel = this.#maybeCreateChannel('storage-sync-channel');

    this.#setupChannelHandlers();
    this.#init();
  }

  #maybeCreateChannel(name: string): BroadcastChannel | undefined {
    if (typeof globalThis === 'undefined') {
      return undefined;
    }

    const globalBroadcastChannel = (
      globalThis as typeof globalThis & {
        BroadcastChannel?: typeof BroadcastChannel;
      }
    ).BroadcastChannel;

    if (typeof globalBroadcastChannel !== 'function') {
      return undefined;
    }

    try {
      return new globalBroadcastChannel(name);
    } catch (error) {
      logger.warn('BroadcastChannel unavailable:', error);
      return undefined;
    }
  }

  #setupChannelHandlers() {
    if (this.#broadcastChannel) {
      // Listen for preview updates from other tabs
      this.#broadcastChannel.onmessage = (event) => {
        const { type, previewId } = event.data;

        if (type === 'file-change') {
          const timestamp = event.data.timestamp;
          const lastUpdate = this.#lastUpdate.get(previewId) || 0;

          if (timestamp > lastUpdate) {
            this.#lastUpdate.set(previewId, timestamp);
            this.refreshPreview(previewId);
          }
        }
      };
    }

    if (this.#storageChannel) {
      // Listen for storage sync messages
      this.#storageChannel.onmessage = (event) => {
        const { storage, source } = event.data;

        if (storage && source !== this._getTabId()) {
          this._syncStorage(storage);
        }
      };
    }
  }

  // Generate a unique ID for this tab
  private _getTabId(): string {
    if (typeof window !== 'undefined') {
      if (!window._tabId) {
        window._tabId = Math.random().toString(36).substring(2, 15);
      }

      return window._tabId;
    }

    return '';
  }

  // Sync storage data between tabs
  private _syncStorage(storage: Record<string, string>) {
    if (typeof window !== 'undefined') {
      Object.entries(storage).forEach(([key, value]) => {
        try {
          const originalSetItem = Object.getPrototypeOf(localStorage).setItem;
          originalSetItem.call(localStorage, key, value);
        } catch (error) {
          logger.error('Error syncing storage:', error);
        }
      });

      // Force a refresh after syncing storage
      const previews = this.previews.get();
      previews.forEach((preview) => {
        const previewId = this.getPreviewId(preview.baseUrl);

        if (previewId) {
          this.refreshPreview(previewId);
        }
      });

      // Reload the page content
      if (typeof window !== 'undefined' && window.location) {
        const iframe = document.querySelector('iframe');

        if (iframe) {
          iframe.src = iframe.src;
        }
      }
    }
  }

  // Broadcast storage state to other tabs
  private _broadcastStorageSync() {
    if (typeof window !== 'undefined') {
      const storage: Record<string, string> = {};

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);

        if (key) {
          storage[key] = localStorage.getItem(key) || '';
        }
      }

      this.#storageChannel?.postMessage({
        type: 'storage-sync',
        storage,
        source: this._getTabId(),
        timestamp: Date.now(),
      });
    }
  }

  async #init() {
    const runtime = await this.#runtime;

    /* Guard against undefined runtime (SSR or failed boot) */
    if (!runtime) {
      logger.warn('Runtime not available, skipping init');

      return;
    }

    /* Guard against stale HMR-cached runtime missing expected methods */
    if (typeof runtime.onPortEvent !== 'function') {
      logger.warn(
        'Runtime missing onPortEvent — stale HMR cache? Skipping init',
        'type:',
        typeof runtime,
        'constructor:',
        runtime?.constructor?.name,
        'keys:',
        Object.keys(runtime),
        'proto:',
        Object.getOwnPropertyNames(Object.getPrototypeOf(runtime)),
      );

      return;
    }

    /*
     * Listen for port events from the runtime.
     * PortEvent.type is 'open' or 'close' — the first 'open' for a port
     * signals that the dev server is ready.
     */
    this.#disposePortEvents = runtime.onPortEvent((event: PortEvent) => {
      const { port, type, url } = event;

      if (type === 'open') {
        let previewInfo = this.#availablePreviews.get(port);
        const previews = this.previews.get();

        if (!previewInfo) {
          /* Server ready — first time this port is seen */
          previewInfo = { port, ready: true, baseUrl: url };
          this.#availablePreviews.set(port, previewInfo);
          previews.push(previewInfo);
          logger.info('Server ready on port:', port, url);

          /* Initial storage sync when preview is ready */
          this._broadcastStorageSync();

          /* Backfill version thumbnails after the iframe renders */
          setTimeout(() => versionsStore.backfillMissingThumbnails(), 2000);
        } else {
          previewInfo.ready = true;
          previewInfo.baseUrl = url;
        }

        this.previews.set([...previews]);
        this.broadcastUpdate(url);
      } else if (type === 'close') {
        const previewInfo = this.#availablePreviews.get(port);

        if (previewInfo) {
          this.#availablePreviews.delete(port);
          this.previews.set(this.previews.get().filter((preview) => preview.port !== port));
        }
      }
    });
  }

  /**
   * Extract a preview ID from a URL.
   * For local runtime, the port number serves as the preview identifier.
   */
  getPreviewId(url: string): string | null {
    try {
      const parsed = new URL(url);

      return parsed.port || null;
    } catch {
      return null;
    }
  }

  // Broadcast state change to all tabs
  broadcastStateChange(previewId: string) {
    const timestamp = Date.now();
    this.#lastUpdate.set(previewId, timestamp);

    this.#broadcastChannel?.postMessage({
      type: 'state-change',
      previewId,
      timestamp,
    });
  }

  // Broadcast file change to all tabs
  broadcastFileChange(previewId: string) {
    const timestamp = Date.now();
    this.#lastUpdate.set(previewId, timestamp);

    this.#broadcastChannel?.postMessage({
      type: 'file-change',
      previewId,
      timestamp,
    });
  }

  // Broadcast update to all tabs
  broadcastUpdate(url: string) {
    const previewId = this.getPreviewId(url);

    if (previewId) {
      const timestamp = Date.now();
      this.#lastUpdate.set(previewId, timestamp);

      this.#broadcastChannel?.postMessage({
        type: 'file-change',
        previewId,
        timestamp,
      });
    }
  }

  // Method to refresh a specific preview
  refreshPreview(previewId: string) {
    // Clear any pending refresh for this preview
    const existingTimeout = this.#refreshTimeouts.get(previewId);

    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set a new timeout for this refresh
    const timeout = setTimeout(() => {
      const previews = this.previews.get();
      const preview = previews.find((p) => this.getPreviewId(p.baseUrl) === previewId);

      if (preview) {
        preview.ready = false;
        this.previews.set([...previews]);

        requestAnimationFrame(() => {
          preview.ready = true;
          this.previews.set([...previews]);
        });
      }

      this.#refreshTimeouts.delete(previewId);
    }, this.#REFRESH_DELAY);

    this.#refreshTimeouts.set(previewId, timeout);
  }

  refreshAllPreviews() {
    const previews = this.previews.get();

    for (const preview of previews) {
      const previewId = this.getPreviewId(preview.baseUrl);

      if (previewId) {
        this.broadcastFileChange(previewId);
      }
    }

    // BroadcastChannel only delivers to OTHER tabs; use a CustomEvent for same-tab refresh
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('bolt:refresh-preview'));
    }
  }

  /**
   * Force a hard refresh of all previews with cache-busting.
   * Used when config files change and Vite's HMR cannot handle the update.
   * Config files (tailwind.config, vite.config, etc.) are cached by build tools
   * and require a full page reload for changes to take effect.
   */
  hardRefreshAllPreviews() {
    const previews = this.previews.get();

    for (const preview of previews) {
      const previewId = this.getPreviewId(preview.baseUrl);

      if (previewId) {
        const timestamp = Date.now();
        this.#lastUpdate.set(previewId, timestamp);

        this.#broadcastChannel?.postMessage({
          type: 'hard-refresh',
          previewId,
          timestamp,
        });
      }
    }

    logger.info('Broadcasted hard-refresh to all previews');
  }

  /**
   * Reset the store — clears all preview entries, disposes port-event
   * listeners, closes BroadcastChannels, cancels pending refresh timers,
   * and resets internal tracking maps.  Called on chat switch so stale
   * previews from the previous project are not displayed.
   *
   * Channels are re-created so the store remains usable after reset.
   */
  reset() {
    this.previews.set([]);
    this.#availablePreviews.clear();
    this.#disposePortEvents?.();
    this.#disposePortEvents = undefined;

    // Close existing BroadcastChannels to prevent leaks
    this.#broadcastChannel?.close();
    this.#broadcastChannel = undefined;
    this.#storageChannel?.close();
    this.#storageChannel = undefined;

    // Cancel all pending refresh timeouts
    for (const timeout of this.#refreshTimeouts.values()) {
      clearTimeout(timeout);
    }

    this.#refreshTimeouts.clear();
    this.#lastUpdate.clear();

    /*
     * Defer re-subscription so old runtime teardown completes before we
     * start listening to port events again — prevents stale port capture
     */
    clearTimeout(this.#resetTimer);
    this.#resetTimer = setTimeout(() => {
      this.#broadcastChannel = this.#maybeCreateChannel(PREVIEW_CHANNEL);
      this.#storageChannel = this.#maybeCreateChannel('storage-sync-channel');
      this.#setupChannelHandlers();
      this.#init();
    }, 150);
  }
}
