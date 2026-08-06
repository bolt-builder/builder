/**
 * Hybrid chat persistence — after migration, reads/writes route to SQLite via
 * the server API (`/api/db/chats`).  Before migration (or when the API is
 * unreachable), the original IndexedDB path is used as a fallback.
 *
 * IndexedDB data is **never** deleted — it is preserved as a read-only backup.
 */

import type { Message } from 'ai';
import type { IChatMetadata } from './types';
import { clearProjectPlanMode } from './projectPlanMode';
import { csrfFetch } from '~/lib/api/csrf-client';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ChatsDB');

const MIGRATION_FLAG_KEY = 'bolt_migration_complete';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface Chat {
  id: string;
  description?: string;
  messages: Message[];
  timestamp: string;
  urlId?: string;
  metadata?: IChatMetadata;
}

/*
 * ---------------------------------------------------------------------------
 * Hybrid routing helper
 * ---------------------------------------------------------------------------
 */

function isMigrated(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(MIGRATION_FLAG_KEY) === 'true';
  } catch {
    return false;
  }
}

/*
 * ---------------------------------------------------------------------------
 * SQLite API helpers (used post-migration)
 * ---------------------------------------------------------------------------
 */

async function sqliteGetAllChats(): Promise<Chat[]> {
  const res = await fetch('/api/db/chats?limit=100');

  if (!res.ok) {
    throw new Error(`SQLite API error: ${res.status}`);
  }

  const data = await res.json();

  return (data.chats ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    urlId: (row.urlId ?? row.url_id) as string | undefined,
    description: row.description as string | undefined,
    timestamp: (row.timestamp ?? row.created_at) as string,
    messages: [],
    metadata: row.metadata as IChatMetadata | undefined,
  }));
}

async function sqliteGetChatById(id: string): Promise<Chat | null> {
  const res = await fetch(`/api/db/chats/${encodeURIComponent(id)}`);

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    throw new Error(`SQLite API error: ${res.status}`);
  }

  const data = await res.json();
  const row = data.chat;

  if (!row) {
    return null;
  }

  return {
    id: row.id as string,
    urlId: (row.urlId ?? row.url_id) as string | undefined,
    description: row.description as string | undefined,
    timestamp: (row.timestamp ?? row.created_at) as string,
    messages: (row.messages ?? []) as Message[],
    metadata: row.metadata as IChatMetadata | undefined,
  };
}

async function sqliteDeleteChat(id: string): Promise<void> {
  const res = await csrfFetch(`/api/db/chats/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });

  if (!res.ok && res.status !== 404) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as Record<string, string>).error || `SQLite delete failed: ${res.status}`);
  }
}

async function sqliteDeleteAllChats(): Promise<void> {
  const res = await csrfFetch('/api/db/chats', {
    method: 'DELETE',
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as Record<string, string>).error || `SQLite bulk delete failed: ${res.status}`);
  }
}

async function sqliteSaveChat(chat: Chat): Promise<void> {
  const res = await csrfFetch('/api/db/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: chat.id,
      urlId: chat.urlId,
      description: chat.description,
      timestamp: chat.timestamp,
      metadata: chat.metadata,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as Record<string, string>).error || `SQLite save failed: ${res.status}`);
  }
}

/*
 * ---------------------------------------------------------------------------
 * Public API — IndexedDB functions (always available for legacy / read-only)
 * ---------------------------------------------------------------------------
 */

function idbGetAllChats(db: IDBDatabase): Promise<Chat[]> {
  logger.debug(`getAllChats: Using database '${db.name}', version ${db.version}`);

  return new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(['chats'], 'readonly');
      const store = transaction.objectStore('chats');
      const request = store.getAll();

      request.onsuccess = () => {
        const result = request.result || [];
        logger.debug(`getAllChats: Found ${result.length} chats in database '${db.name}'`);
        resolve(result);
      };

      request.onerror = () => {
        logger.error(`getAllChats: Error querying database '${db.name}':`, request.error);
        reject(request.error);
      };
    } catch (err) {
      logger.error(`getAllChats: Error creating transaction on database '${db.name}':`, err);
      reject(err);
    }
  });
}

function idbGetChatById(db: IDBDatabase, id: string): Promise<Chat | null> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readonly');
    const store = transaction.objectStore('chats');
    const request = store.get(id);

    request.onsuccess = () => {
      resolve(request.result || null);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

function idbSaveChat(db: IDBDatabase, chat: Chat): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readwrite');
    const store = transaction.objectStore('chats');
    const request = store.put(chat);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

function idbDeleteChat(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readwrite');
    const store = transaction.objectStore('chats');
    const request = store.delete(id);

    request.onsuccess = () => {
      clearProjectPlanMode(id);
      resolve();
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

function idbDeleteAllChats(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readwrite');
    const store = transaction.objectStore('chats');
    const request = store.clear();

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

/*
 * ---------------------------------------------------------------------------
 * Hybrid public API — routes to SQLite when migrated, else IndexedDB
 * ---------------------------------------------------------------------------
 */

export async function getAllChats(db: IDBDatabase): Promise<Chat[]> {
  if (isMigrated()) {
    try {
      return await sqliteGetAllChats();
    } catch (err) {
      logger.warn('SQLite getAllChats failed, falling back to IndexedDB:', err);
    }
  }

  return idbGetAllChats(db);
}

export async function getChatById(db: IDBDatabase, id: string): Promise<Chat | null> {
  if (isMigrated()) {
    try {
      return await sqliteGetChatById(id);
    } catch (err) {
      logger.warn('SQLite getChatById failed, falling back to IndexedDB:', err);
    }
  }

  return idbGetChatById(db, id);
}

export async function saveChat(db: IDBDatabase, chat: Chat): Promise<void> {
  if (isMigrated()) {
    try {
      await sqliteSaveChat(chat);
    } catch (err) {
      logger.warn('SQLite saveChat failed, falling back to IndexedDB:', err);
    }
  }

  // Always write to IndexedDB to keep the local copy current
  return idbSaveChat(db, chat);
}

export async function deleteChat(db: IDBDatabase, id: string): Promise<void> {
  if (!isMigrated()) {
    return idbDeleteChat(db, id);
  }

  // Post-migration: delete from SQLite only; IndexedDB is preserved as read-only backup
  try {
    await sqliteDeleteChat(id);
  } catch (err) {
    logger.warn('SQLite deleteChat failed:', err);
  }

  clearProjectPlanMode(id);

  return undefined;
}

export async function deleteAllChats(db: IDBDatabase): Promise<void> {
  if (!isMigrated()) {
    return idbDeleteAllChats(db);
  }

  // Post-migration: delete from SQLite only; IndexedDB is preserved as read-only backup
  try {
    await sqliteDeleteAllChats();
  } catch (err) {
    logger.warn('SQLite deleteAllChats failed:', err);
  }

  return undefined;
}
