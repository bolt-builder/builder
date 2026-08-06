import { atom, map, type MapStore, type WritableAtom } from 'nanostores';
import { createScopedLogger } from '~/utils/logger';
import { saveVersions as saveVersionsToDB, getVersionsByChatId } from '~/lib/persistence/db';

const logger = createScopedLogger('VersionsStore');

export interface ProjectVersion {
  id: string;
  messageId: string;
  title: string;
  description: string;
  timestamp: number;
  files: Record<string, { content: string; type: string }>;
  thumbnail?: string; // Base64 preview image (optional, for future)
  commitSha?: string; // Git commit SHA, set after auto-commit completes
  totalTokens?: number;
  chatSummary?: string;
  isLatest: boolean;
}

class VersionsStore {
  versions: MapStore<Record<string, ProjectVersion>> =
    import.meta.hot?.data.versions ?? map<Record<string, ProjectVersion>>({});

  currentVersionId: WritableAtom<string | null> = import.meta.hot?.data.currentVersionId ?? atom<string | null>(null);

  /** Bumped after a git commit SHA is stored — lets Versions.tsx auto-refresh. */
  lastCommitTimestamp: WritableAtom<number> = import.meta.hot?.data.lastCommitTimestamp ?? atom<number>(0);

  private _db: IDBDatabase | undefined;
  private _chatId: string | undefined;
  private _pendingMeta: { totalTokens?: number; chatSummary?: string } | null = null;

  constructor() {
    if (import.meta.hot) {
      import.meta.hot.data.versions = this.versions;
      import.meta.hot.data.currentVersionId = this.currentVersionId;
      import.meta.hot.data.lastCommitTimestamp = this.lastCommitTimestamp;
    }
  }

  /**
   * Set the database context for version persistence.
   * Called by useChatHistory when a chat is loaded or created.
   */
  setDBContext(db: IDBDatabase | undefined, chatIdVal: string | undefined) {
    const contextChanged = this._chatId !== chatIdVal;
    this._db = db;
    this._chatId = chatIdVal;

    // Auto-persist any in-memory versions when context is first established
    if (contextChanged && db && chatIdVal && Object.keys(this.versions.get()).length > 0) {
      this._persistToDB();
    }
  }

  /**
   * Persist all current versions to IndexedDB (fire-and-forget).
   */
  private _persistToDB() {
    if (!this._db || !this._chatId) {
      return;
    }

    const allVersions = Object.values(this.versions.get());

    saveVersionsToDB(this._db, this._chatId, allVersions).catch((error) => {
      logger.warn('Failed to persist versions to IndexedDB:', error);
    });
  }

  /**
   * Load versions from IndexedDB, falling back to message sync for legacy chats.
   */
  async loadFromDB(
    db: IDBDatabase,
    chatIdVal: string,
    messages: { id: string; role: string; content: string; createdAt?: Date }[],
  ) {
    this._db = db;
    this._chatId = chatIdVal;

    try {
      const stored = await getVersionsByChatId(db, chatIdVal);

      if (stored && stored.length > 0) {
        this.versions.set({});
        this.currentVersionId.set(null);

        let latestId: string | null = null;

        for (const v of stored) {
          this.versions.setKey(v.id, v);

          if (v.isLatest) {
            latestId = v.id;
          }
        }

        if (latestId) {
          this.currentVersionId.set(latestId);
        }

        logger.trace(`Loaded ${stored.length} versions from IndexedDB for chat ${chatIdVal}`);

        return;
      }
    } catch (error) {
      logger.warn('Failed to load versions from IndexedDB, falling back to sync:', error);
    }

    // Fallback: reconstruct from messages (legacy chats without persisted versions)
    this.syncFromMessages(messages);

    // Persist the reconstructed versions so next reload uses the DB path
    this._persistToDB();
  }

  /**
   * Create a new version snapshot
   */
  createVersion(
    messageId: string,
    title: string,
    description: string,
    files: Record<string, { content: string; type: string }>,
    thumbnail?: string,
  ): ProjectVersion {
    const id = `ver-${this._generateShortId()}`;
    const timestamp = Date.now();

    // Mark all existing versions as not latest
    const currentVersions = this.versions.get();

    for (const [verId, ver] of Object.entries(currentVersions)) {
      if (ver.isLatest) {
        this.versions.setKey(verId, { ...ver, isLatest: false });
      }
    }

    const newVersion: ProjectVersion = {
      id,
      messageId,
      title,
      description,
      timestamp,
      files,
      thumbnail,
      isLatest: true,
    };

    // Apply any pending metadata queued before the version was created
    if (this._pendingMeta) {
      newVersion.totalTokens = this._pendingMeta.totalTokens;
      newVersion.chatSummary = this._pendingMeta.chatSummary;
      this._pendingMeta = null;
    }

    this.versions.setKey(id, newVersion);
    this.currentVersionId.set(id);

    // Persist to IndexedDB
    this._persistToDB();

    return newVersion;
  }

  /**
   * Get all versions sorted by timestamp (newest first)
   */
  getAllVersions(): ProjectVersion[] {
    const versions = Object.values(this.versions.get());
    return versions.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get a specific version by ID
   */
  getVersion(id: string): ProjectVersion | undefined {
    return this.versions.get()[id];
  }

  /**
   * Get the latest version
   */
  getLatestVersion(): ProjectVersion | undefined {
    const versions = this.getAllVersions();
    return versions.find((v) => v.isLatest) || versions[0];
  }

  /**
   * Restore to a specific version
   */
  restoreVersion(id: string): ProjectVersion | undefined {
    const version = this.getVersion(id);

    if (version) {
      this.currentVersionId.set(id);
      return version;
    }

    return undefined;
  }

  /**
   * Generate a short random ID (like Blink's ver-k8m80qdi)
   */
  private _generateShortId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';

    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return result;
  }

  /**
   * Format timestamp to relative time
   */
  formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    const months = Math.floor(diff / 2592000000);

    if (minutes < 1) {
      return 'Just now';
    }

    if (minutes < 60) {
      return `${minutes}m ago`;
    }

    if (hours < 24) {
      return `${hours}h ago`;
    }

    if (days < 30) {
      return `${days}d ago`;
    }

    return `${months}mo ago`;
  }

  /**
   * Update version metadata (tokens, summary) and persist the change.
   */
  updateVersionMeta(versionId: string, meta: { totalTokens?: number; chatSummary?: string }) {
    const version = this.versions.get()[versionId];

    if (version) {
      this.versions.setKey(versionId, { ...version, ...meta });
      this._persistToDB();
    }
  }

  /**
   * Queue metadata to be applied to the next version created.
   * Used when annotations arrive before the version is created (timing gap).
   */
  setPendingMeta(meta: { totalTokens?: number; chatSummary?: string }) {
    this._pendingMeta = meta;
  }

  /** Max number of versions to keep screenshots for (oldest are pruned). */
  private static readonly _maxScreenshots = 20;

  /**
   * Update a version's thumbnail, enforce retention limit, and persist.
   */
  updateThumbnail(versionId: string, thumbnail: string) {
    const version = this.versions.get()[versionId];

    if (version) {
      this.versions.setKey(versionId, { ...version, thumbnail });
      this._pruneOldScreenshots();
      this._persistToDB();
    }
  }

  /**
   * Keep screenshots only on the newest _maxScreenshots versions.
   * Older versions retain all metadata but have their thumbnail cleared.
   */
  private _pruneOldScreenshots() {
    const allVersions = Object.values(this.versions.get())
      .filter((v) => v.thumbnail)
      .sort((a, b) => b.timestamp - a.timestamp);

    if (allVersions.length <= VersionsStore._maxScreenshots) {
      return;
    }

    const toPrune = allVersions.slice(VersionsStore._maxScreenshots);

    for (const v of toPrune) {
      this.versions.setKey(v.id, { ...v, thumbnail: undefined });
    }

    logger.trace(`Pruned screenshots from ${toPrune.length} old versions`);
  }

  /**
   * Store the git commit SHA on a version so Versions.tsx can match
   * git commits to their thumbnails.
   */
  updateCommitSha(versionId: string, sha: string) {
    const version = this.versions.get()[versionId];

    if (version) {
      this.versions.setKey(versionId, { ...version, commitSha: sha });
      this._persistToDB();
      this.lastCommitTimestamp.set(Date.now());
    }
  }

  /**
   * Build a lookup map from commit SHA → thumbnail data URL.
   * Used by the Git History panel to display thumbnails on commit cards.
   */
  getThumbnailsBySha(): Map<string, string> {
    const map = new Map<string, string>();

    for (const version of Object.values(this.versions.get())) {
      if (version.commitSha && version.thumbnail) {
        map.set(version.commitSha, version.thumbnail);
      }
    }

    return map;
  }

  /**
   * Attempt a single screenshot capture from the preview iframe.
   * Returns the data URL or undefined if the iframe isn't available / capture fails.
   */
  private async _tryCapture(): Promise<string | undefined> {
    const { requestPreviewScreenshot } = await import('~/components/workbench/Preview');
    const screenshot = await requestPreviewScreenshot({ width: 960, height: 600 }, 8000);

    return screenshot || undefined;
  }

  /**
   * Check whether a screenshot result is a real capture (not a fallback placeholder).
   * Fallback placeholders are PNGs from generateFallbackScreenshot().
   * Real captures are JPEGs from html2canvas in the preview iframe.
   * Even simple apps produce JPEGs of at least ~500 chars.
   */
  private _isRealScreenshot(dataUrl: string): boolean {
    return dataUrl.length > 500 && (dataUrl.startsWith('data:image/webp') || dataUrl.startsWith('data:image/jpeg'));
  }

  /**
   * Capture a thumbnail from the preview iframe with retry logic.
   * The preview often isn't loaded yet when artifacts finish (npm install / dev
   * server are still running), so we retry with increasing delays.
   *
   * @param maxRetries  How many additional attempts after the first
   * @param retryDelays Delay in ms before each retry (index = retry number)
   */
  async capturePreviewThumbnail(maxRetries = 4, retryDelays = [3000, 6000, 10000, 15000]): Promise<string | undefined> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this._tryCapture();

        if (result && this._isRealScreenshot(result)) {
          return result;
        }

        logger.trace(`Capture attempt ${attempt + 1} returned placeholder, will retry...`);
      } catch (error) {
        logger.trace(`Capture attempt ${attempt + 1} failed:`, error);
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryDelays[attempt] ?? 5000));
      }
    }

    logger.warn('All capture attempts returned placeholders — giving up');

    return undefined;
  }

  /**
   * Schedule a deferred thumbnail capture for a version.
   * Creates the version immediately (so it shows up in the UI right away)
   * then captures the thumbnail in the background and updates the version.
   */
  scheduleThumbnailCapture(versionId: string) {
    this.capturePreviewThumbnail()
      .then((thumbnail) => {
        if (thumbnail) {
          this.updateThumbnail(versionId, thumbnail);
          logger.trace(`Thumbnail captured for version ${versionId}`);
        }
      })
      .catch((error) => {
        logger.warn(`Failed to capture thumbnail for version ${versionId}:`, error);
      });
  }

  /**
   * Backfill missing thumbnails for versions that don't have one.
   * Called when the Versions panel is opened or the preview becomes available.
   * Captures once and applies the current preview state to all versions without
   * thumbnails (the preview always shows the latest code, so every version gets
   * the same screenshot -- but a real screenshot is far better than a placeholder).
   */
  async backfillMissingThumbnails(): Promise<void> {
    const allVersions = this.getAllVersions();
    const missing = allVersions.filter((v) => !v.thumbnail);

    if (missing.length === 0) {
      return;
    }

    logger.trace(`Backfilling thumbnails for ${missing.length} version(s)`);

    try {
      const result = await this._tryCapture();

      if (result && this._isRealScreenshot(result)) {
        for (const version of missing) {
          this.updateThumbnail(version.id, result);
        }

        logger.trace(`Backfill succeeded for ${missing.length} version(s)`);
      }
    } catch {
      // Silently ignore — the placeholder icon is fine as a fallback
    }
  }

  /**
   * Sync versions from chat messages on load.
   * This creates version entries from messages that have artifacts.
   */
  syncFromMessages(messages: { id: string; role: string; content: string; createdAt?: Date }[]): void {
    // Clear existing versions since we're syncing from chat
    this.versions.set({});
    this.currentVersionId.set(null);

    const artifactRegex = /<boltArtifact[^>]*title="([^"]*)"[^>]*>/gi;

    let latestVersionId: string | null = null;

    for (const message of messages) {
      // Only process assistant messages
      if (message.role !== 'assistant') {
        continue;
      }

      const content = typeof message.content === 'string' ? message.content : '';

      // Find all artifacts in this message
      const matches = [...content.matchAll(artifactRegex)];

      if (matches.length === 0) {
        continue;
      }

      // Use the first artifact's title for the version
      const title = matches[0][1] || 'Project Update';

      /*
       * Create version entry (files will be empty since we don't have full snapshot).
       * The revert functionality will use messageId to rewind, not the files.
       */
      const id = `ver-${this._generateShortId()}`;
      const timestamp = message.createdAt ? new Date(message.createdAt).getTime() : Date.now();

      const version: ProjectVersion = {
        id,
        messageId: message.id,
        title,
        description: `From message: ${message.id.substring(0, 8)}...`,
        timestamp,
        files: {}, // Empty - revert uses chat rewind, not file restore
        isLatest: false,
      };

      this.versions.setKey(id, version);
      latestVersionId = id;
    }

    // Mark the last one as latest
    if (latestVersionId) {
      const latest = this.versions.get()[latestVersionId];

      if (latest) {
        this.versions.setKey(latestVersionId, { ...latest, isLatest: true });
        this.currentVersionId.set(latestVersionId);
      }
    }
  }
}

export const versionsStore = new VersionsStore();
