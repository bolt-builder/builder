import { getAllChats, type Chat } from './chats';
import { getSnapshot, getVersionsByChatId } from './db';
import type { Snapshot } from './types';
import type { ProjectVersion } from '~/lib/stores/versions';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('AutoBackup');

const BACKUP_KEY_PREFIX = 'bolt_backup_';
const BACKUP_META_KEY = 'bolt_backup_meta';
const MAX_BACKUPS = 3;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BACKUP_CHATS = 10;
const MAX_BACKUP_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB — safe threshold for localStorage

interface BackupMeta {
  lastBackupTime: string;
  backupKeys: string[];
  chatCount: number;
}

export interface BackupData {
  _meta: {
    version: '1.0';
    createdAt: string;
    chatCount: number;
  };
  chats: Chat[];
  snapshots: Record<string, Snapshot>;
  versions: Record<string, ProjectVersion[]>;
}

function getBackupMeta(): BackupMeta | null {
  try {
    const raw = localStorage.getItem(BACKUP_META_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setBackupMeta(meta: BackupMeta) {
  localStorage.setItem(BACKUP_META_KEY, JSON.stringify(meta));
}

/**
 * Evict ALL existing backup entries from localStorage to free space.
 * Returns the number of bytes freed (approximate).
 */
function evictAllBackups(): number {
  const meta = getBackupMeta();
  let freedBytes = 0;

  if (meta?.backupKeys.length) {
    for (const key of meta.backupKeys) {
      const raw = localStorage.getItem(key);

      if (raw) {
        freedBytes += raw.length * 2; // UTF-16 ≈ 2 bytes per char
      }

      localStorage.removeItem(key);
    }

    meta.backupKeys = [];
    setBackupMeta(meta);
  }

  return freedBytes;
}

/**
 * Remove stale non-backup keys from localStorage that are no longer needed.
 * Targets common ephemeral keys that accumulate over time.
 */
function cleanStaleLocalStorageKeys(): number {
  const STALE_PREFIXES = ['bolt_', '__remix', 'debug_', 'draft_'];
  let freedBytes = 0;

  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);

    if (!key) {
      continue;
    }

    const isStale = STALE_PREFIXES.some((p) => key.startsWith(p));

    if (isStale) {
      const raw = localStorage.getItem(key);

      if (raw) {
        freedBytes += raw.length * 2;
      }

      localStorage.removeItem(key);
    }
  }

  return freedBytes;
}

/**
 * Try to write a value to localStorage. Returns true on success, false on QuotaExceededError.
 */
function trySetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a full backup of recent chats, snapshots, and versions.
 * Stores in localStorage with rotation (keeps last MAX_BACKUPS).
 *
 * Gracefully degrades in multiple stages:
 *   1. Full backup (chats + snapshots + versions without thumbnails)
 *   2. Drop versions
 *   3. Drop snapshots
 *   4. Reduce to fewer chats (half)
 *   5. Evict old backups + clean stale keys, then retry
 *   6. Minimal backup (latest 3 chats, no snapshots/versions)
 */
export async function createBackup(db: IDBDatabase): Promise<string | null> {
  try {
    const allChats = await getAllChats(db);

    if (allChats.length === 0) {
      return null;
    }

    /* Only back up the most recent chats to keep the payload manageable */
    const sortedChats = allChats.sort((a, b) => {
      const ta = new Date(b.timestamp ?? 0).getTime();
      const tb = new Date(a.timestamp ?? 0).getTime();

      return ta - tb;
    });

    const chats = sortedChats.slice(0, MAX_BACKUP_CHATS);

    const snapshots: Record<string, Snapshot> = {};
    const versions: Record<string, ProjectVersion[]> = {};

    for (const chat of chats) {
      try {
        const snapshot = await getSnapshot(db, chat.id);

        if (snapshot) {
          snapshots[chat.id] = snapshot;
        }

        const chatVersions = await getVersionsByChatId(db, chat.id);

        if (chatVersions) {
          /*
           * Strip screenshot data URLs from versions — they dominate backup size
           * and can be recaptured. This keeps version metadata in backups while
           * staying well within the 2 MB localStorage cap.
           */
          versions[chat.id] = chatVersions.map(({ thumbnail: _thumb, ...rest }) => rest);
        }
      } catch {
        // Skip individual chat errors — partial backup is better than none
      }
    }

    const metaBlock = {
      version: '1.0' as const,
      createdAt: new Date().toISOString(),
      chatCount: chats.length,
    };

    /* ── Stage 1: Full backup ── */
    let backup: BackupData = { _meta: metaBlock, chats, snapshots, versions };
    let serialized = JSON.stringify(backup);

    /* ── Stage 2: Drop versions ── */
    if (serialized.length > MAX_BACKUP_SIZE_BYTES) {
      logger.debug('Backup too large with versions, dropping versions data');
      backup = { _meta: metaBlock, chats, snapshots, versions: {} };
      serialized = JSON.stringify(backup);
    }

    /* ── Stage 3: Drop snapshots ── */
    if (serialized.length > MAX_BACKUP_SIZE_BYTES) {
      logger.debug('Backup still too large, dropping snapshots data');
      backup = { _meta: metaBlock, chats, snapshots: {}, versions: {} };
      serialized = JSON.stringify(backup);
    }

    /* ── Stage 4: Reduce chat count ── */
    if (serialized.length > MAX_BACKUP_SIZE_BYTES) {
      const halfChats = chats.slice(0, Math.max(3, Math.floor(chats.length / 2)));
      logger.debug(`Backup still too large, reducing to ${halfChats.length} chats`);

      const reducedMeta = { ...metaBlock, chatCount: halfChats.length };
      backup = { _meta: reducedMeta, chats: halfChats, snapshots: {}, versions: {} };
      serialized = JSON.stringify(backup);
    }

    const backupKey = `${BACKUP_KEY_PREFIX}${Date.now()}`;

    /* ── Try writing to localStorage ── */
    if (trySetItem(backupKey, serialized)) {
      return finalizeBackup(backupKey, chats.length, Object.keys(snapshots).length);
    }

    /* ── Stage 5: Evict old backups + clean stale keys, then retry ── */
    logger.debug('localStorage full — evicting old backups and cleaning stale keys');
    evictAllBackups();
    cleanStaleLocalStorageKeys();

    if (trySetItem(backupKey, serialized)) {
      return finalizeBackup(backupKey, chats.length, Object.keys(snapshots).length);
    }

    /* ── Stage 6: Minimal backup (latest 3 chats, messages only) ── */
    const minChats = sortedChats.slice(0, 3);
    const minMeta = { ...metaBlock, chatCount: minChats.length };
    const minBackup: BackupData = { _meta: minMeta, chats: minChats, snapshots: {}, versions: {} };
    serialized = JSON.stringify(minBackup);

    if (trySetItem(backupKey, serialized)) {
      logger.warn(`Backup degraded to ${minChats.length} chats (localStorage nearly full)`);
      return finalizeBackup(backupKey, minChats.length, 0);
    }

    logger.error('Backup failed: localStorage full even after full eviction and degradation');

    return null;
  } catch (error) {
    logger.error('Backup failed:', error);
    return null;
  }
}

/** Finalize a successful backup: update metadata, rotate old entries, and log. */
function finalizeBackup(backupKey: string, chatCount: number, snapshotCount: number): string {
  const meta = getBackupMeta() || { lastBackupTime: '', backupKeys: [], chatCount: 0 };
  meta.backupKeys.push(backupKey);
  meta.lastBackupTime = new Date().toISOString();
  meta.chatCount = chatCount;

  while (meta.backupKeys.length > MAX_BACKUPS) {
    const oldest = meta.backupKeys.shift()!;
    localStorage.removeItem(oldest);
  }

  setBackupMeta(meta);
  logger.info(`Backup created: ${chatCount} chats, ${snapshotCount} snapshots`);

  return backupKey;
}

/**
 * Download the latest backup (or a fresh one) as a JSON file.
 */
export async function downloadBackup(db: IDBDatabase): Promise<void> {
  const chats = await getAllChats(db);

  if (chats.length === 0) {
    return;
  }

  const snapshots: Record<string, Snapshot> = {};
  const versions: Record<string, ProjectVersion[]> = {};

  for (const chat of chats) {
    try {
      const snapshot = await getSnapshot(db, chat.id);

      if (snapshot) {
        snapshots[chat.id] = snapshot;
      }

      const chatVersions = await getVersionsByChatId(db, chat.id);

      if (chatVersions) {
        versions[chat.id] = chatVersions;
      }
    } catch {
      // Skip individual errors
    }
  }

  const backup: BackupData = {
    _meta: {
      version: '1.0',
      createdAt: new Date().toISOString(),
      chatCount: chats.length,
    },
    chats,
    snapshots,
    versions,
  };

  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bolt-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * List available backups from localStorage.
 */
export function listBackups(): { key: string; createdAt: string; chatCount: number }[] {
  const meta = getBackupMeta();

  if (!meta) {
    return [];
  }

  return meta.backupKeys
    .map((key) => {
      try {
        const raw = localStorage.getItem(key);

        if (!raw) {
          return null;
        }

        const data = JSON.parse(raw) as BackupData;

        return {
          key,
          createdAt: data._meta.createdAt,
          chatCount: data._meta.chatCount,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as { key: string; createdAt: string; chatCount: number }[];
}

/**
 * Restore chats from a backup key in localStorage.
 * Returns the parsed BackupData for the caller to import.
 */
export function loadBackup(backupKey: string): BackupData | null {
  try {
    const raw = localStorage.getItem(backupKey);

    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as BackupData;
  } catch {
    logger.error(`Failed to load backup: ${backupKey}`);
    return null;
  }
}

let backupInterval: ReturnType<typeof setInterval> | null = null;
let initialBackupTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Start periodic auto-backup. Safe to call multiple times (idempotent).
 */
export function startAutoBackup(db: IDBDatabase, intervalMs = DEFAULT_INTERVAL_MS) {
  stopAutoBackup();

  // Initial backup after a short delay to avoid blocking startup
  initialBackupTimeout = setTimeout(() => {
    initialBackupTimeout = null;
    createBackup(db);
  }, 10_000);

  backupInterval = setInterval(() => createBackup(db), intervalMs);
  logger.info(`Auto-backup started (every ${Math.round(intervalMs / 60_000)}min)`);
}

/**
 * Stop periodic auto-backup.
 */
export function stopAutoBackup() {
  if (initialBackupTimeout) {
    clearTimeout(initialBackupTimeout);
    initialBackupTimeout = null;
  }

  if (backupInterval) {
    clearInterval(backupInterval);
    backupInterval = null;
  }
}
