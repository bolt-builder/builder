import type { Message } from 'ai';
import { clearProjectPlanMode } from './projectPlanMode';
import { createScopedLogger } from '~/utils/logger';
import type { ChatHistoryItem, IChatMetadata, Snapshot } from './types';
import type { ProjectVersion } from '~/lib/stores/versions';
import type { AgentCheckpoint, BranchMetadata } from '~/lib/agent/types';

export type { IChatMetadata };

/** Shared function type for importing a chat into the persistence layer. */
export type ImportChatFn = (
  description: string,
  messages: Message[],
  metadata?: IChatMetadata,
  options?: { skipRedirect?: boolean },
) => Promise<string | undefined>;

const logger = createScopedLogger('Database');

// this is used at the top level and never rejects
export async function openDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') {
    logger.debug('indexedDB is not available in this environment (expected on server).');
    return undefined;
  }

  return new Promise((resolve) => {
    const request = indexedDB.open('boltHistory', 5);

    request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        if (!db.objectStoreNames.contains('chats')) {
          const store = db.createObjectStore('chats', { keyPath: 'id' });
          store.createIndex('id', 'id', { unique: true });
          store.createIndex('urlId', 'urlId', { unique: true });
        }
      }

      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots', { keyPath: 'chatId' });
        }
      }

      if (oldVersion < 3) {
        if (!db.objectStoreNames.contains('versions')) {
          db.createObjectStore('versions', { keyPath: 'chatId' });
        }
      }

      if (oldVersion < 4) {
        if (!db.objectStoreNames.contains('branches')) {
          const branchStore = db.createObjectStore('branches', { keyPath: 'branchId' });
          branchStore.createIndex('parentChatId', 'parentChatId', { unique: false });
          branchStore.createIndex('branchPointMessageId', 'branchPointMessageId', { unique: false });
        }
      }

      if (oldVersion < 5) {
        if (!db.objectStoreNames.contains('agent_checkpoints')) {
          const checkpointStore = db.createObjectStore('agent_checkpoints', { keyPath: 'id' });
          checkpointStore.createIndex('chatId', 'chatId', { unique: false });
          checkpointStore.createIndex('phase', 'phase', { unique: false });
        }
      }
    };

    request.onblocked = () => {
      logger.warn('Database upgrade blocked — close other tabs using this app and reload.');
    };

    request.onsuccess = (event: Event) => {
      resolve((event.target as IDBOpenDBRequest).result);
    };

    request.onerror = (event: Event) => {
      resolve(undefined);
      logger.error((event.target as IDBOpenDBRequest).error);
    };
  });
}

export async function getAll(db: IDBDatabase): Promise<ChatHistoryItem[]> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('chats', 'readonly');
    const store = transaction.objectStore('chats');
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result as ChatHistoryItem[]);
    request.onerror = () => reject(request.error);
  });
}

export async function setMessages(
  db: IDBDatabase,
  id: string,
  messages: Message[],
  urlId?: string,
  description?: string,
  timestamp?: string,
  metadata?: IChatMetadata,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('chats', 'readwrite');
    const store = transaction.objectStore('chats');

    if (timestamp && isNaN(Date.parse(timestamp))) {
      reject(new Error('Invalid timestamp'));
      return;
    }

    const request = store.put({
      id,
      messages,
      urlId,
      description,
      timestamp: timestamp ?? new Date().toISOString(),
      metadata,
    });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getMessages(db: IDBDatabase, id: string): Promise<ChatHistoryItem> {
  return (await getMessagesById(db, id)) || (await getMessagesByUrlId(db, id));
}

export async function getMessagesByUrlId(db: IDBDatabase, id: string): Promise<ChatHistoryItem> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('chats', 'readonly');
    const store = transaction.objectStore('chats');
    const index = store.index('urlId');
    const request = index.get(id);

    request.onsuccess = () => resolve(request.result as ChatHistoryItem);
    request.onerror = () => reject(request.error);
  });
}

export async function getMessagesById(db: IDBDatabase, id: string): Promise<ChatHistoryItem> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('chats', 'readonly');
    const store = transaction.objectStore('chats');
    const request = store.get(id);

    request.onsuccess = () => resolve(request.result as ChatHistoryItem);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteById(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats', 'snapshots', 'versions'], 'readwrite');

    transaction.objectStore('chats').delete(id);
    transaction.objectStore('snapshots').delete(id);
    transaction.objectStore('versions').delete(id);

    transaction.oncomplete = () => {
      clearProjectPlanMode(id);
      resolve(undefined);
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function getNextId(db: IDBDatabase): Promise<string> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('chats', 'readonly');
    const store = transaction.objectStore('chats');
    const request = store.getAllKeys();

    request.onsuccess = () => {
      const highestId = request.result.reduce((cur, acc) => Math.max(+cur, +acc), 0);
      resolve(String(+highestId + 1));
    };

    request.onerror = () => reject(request.error);
  });
}

export async function getUrlId(db: IDBDatabase, id: string): Promise<string> {
  const idList = await getUrlIds(db);

  if (!idList.includes(id)) {
    return id;
  } else {
    let i = 2;

    while (idList.includes(`${id}-${i}`)) {
      i++;
    }

    return `${id}-${i}`;
  }
}

async function getUrlIds(db: IDBDatabase): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('chats', 'readonly');
    const store = transaction.objectStore('chats');
    const idList: string[] = [];

    const request = store.openCursor();

    request.onsuccess = (event: Event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

      if (cursor) {
        idList.push(cursor.value.urlId);
        cursor.continue();
      } else {
        resolve(idList);
      }
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

export async function forkChat(
  db: IDBDatabase,
  chatId: string,
  messageId: string,
  options?: { branchPointMessageId?: string },
): Promise<string> {
  const chat = await getMessages(db, chatId);

  if (!chat) {
    throw new Error('Chat not found');
  }

  // Find the index of the message to fork at
  const messageIndex = chat.messages.findIndex((msg) => msg.id === messageId);

  if (messageIndex === -1) {
    throw new Error('Message not found');
  }

  // Get messages up to and including the selected message
  const messages = chat.messages.slice(0, messageIndex + 1);

  const newUrlId = await createChatFromMessages(
    db,
    chat.description ? `${chat.description} (fork)` : 'Forked chat',
    messages,
  );

  // Create branch metadata if a branch point was specified
  if (options?.branchPointMessageId) {
    const branchMeta: BranchMetadata = {
      branchId: crypto.randomUUID(),
      parentChatId: chatId,
      branchPointMessageId: options.branchPointMessageId,
      label: chat.description ? `${chat.description} (fork)` : 'Forked chat',
      createdAt: new Date().toISOString(),
    };

    await saveBranchMetadata(db, branchMeta);
  }

  return newUrlId;
}

export async function duplicateChat(db: IDBDatabase, id: string): Promise<string> {
  const chat = await getMessages(db, id);

  if (!chat) {
    throw new Error('Chat not found');
  }

  return createChatFromMessages(db, `${chat.description || 'Chat'} (copy)`, chat.messages);
}

export async function createChatFromMessages(
  db: IDBDatabase,
  description: string,
  messages: Message[],
  metadata?: IChatMetadata,
): Promise<string> {
  const newId = await getNextId(db);
  const newUrlId = await getUrlId(db, newId); // Get a new urlId for the duplicated chat

  await setMessages(
    db,
    newId,
    messages,
    newUrlId, // Use the new urlId
    description,
    undefined, // Use the current timestamp
    metadata,
  );

  return newUrlId; // Return the urlId instead of id for navigation
}

export async function updateChatDescription(db: IDBDatabase, id: string, description: string): Promise<void> {
  const chat = await getMessages(db, id);

  if (!chat) {
    throw new Error('Chat not found');
  }

  if (!description.trim()) {
    throw new Error('Description cannot be empty');
  }

  await setMessages(db, id, chat.messages, chat.urlId, description, chat.timestamp, chat.metadata);
}

export async function updateChatMetadata(
  db: IDBDatabase,
  id: string,
  metadata: IChatMetadata | undefined,
): Promise<void> {
  const chat = await getMessages(db, id);

  if (!chat) {
    throw new Error('Chat not found');
  }

  await setMessages(db, id, chat.messages, chat.urlId, chat.description, chat.timestamp, metadata);
}

export async function getSnapshot(db: IDBDatabase, chatId: string): Promise<Snapshot | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('snapshots', 'readonly');
    const store = transaction.objectStore('snapshots');
    const request = store.get(chatId);

    request.onsuccess = () => resolve(request.result?.snapshot as Snapshot | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function setSnapshot(db: IDBDatabase, chatId: string, snapshot: Snapshot): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('snapshots', 'readwrite');
    const store = transaction.objectStore('snapshots');
    const request = store.put({ chatId, snapshot });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function deleteSnapshot(db: IDBDatabase, chatId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('snapshots', 'readwrite');
    const store = transaction.objectStore('snapshots');
    const request = store.delete(chatId);

    request.onsuccess = () => resolve();

    request.onerror = (event) => {
      if ((event.target as IDBRequest).error?.name === 'NotFoundError') {
        resolve();
      } else {
        reject(request.error);
      }
    };
  });
}

export async function saveVersions(db: IDBDatabase, chatId: string, versions: ProjectVersion[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('versions', 'readwrite');
    const store = transaction.objectStore('versions');
    const request = store.put({ chatId, versions });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getVersionsByChatId(db: IDBDatabase, chatId: string): Promise<ProjectVersion[] | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('versions', 'readonly');
    const store = transaction.objectStore('versions');
    const request = store.get(chatId);

    request.onsuccess = () => resolve(request.result?.versions as ProjectVersion[] | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function saveBranchMetadata(db: IDBDatabase, branch: BranchMetadata): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('branches', 'readwrite');
    const store = transaction.objectStore('branches');
    const request = store.put(branch);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getBranchesByParentChatId(db: IDBDatabase, parentChatId: string): Promise<BranchMetadata[]> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('branches', 'readonly');
    const store = transaction.objectStore('branches');
    const index = store.index('parentChatId');
    const request = index.getAll(parentChatId);

    request.onsuccess = () => resolve(request.result as BranchMetadata[]);
    request.onerror = () => reject(request.error);
  });
}

export async function saveAgentCheckpoint(db: IDBDatabase, checkpoint: AgentCheckpoint): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('agent_checkpoints', 'readwrite');
    const store = transaction.objectStore('agent_checkpoints');
    const request = store.put(checkpoint);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getLatestCheckpoint(db: IDBDatabase, chatId: string): Promise<AgentCheckpoint | null> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('agent_checkpoints', 'readonly');
    const store = transaction.objectStore('agent_checkpoints');
    const index = store.index('chatId');
    const request = index.getAll(chatId);

    request.onsuccess = () => {
      const checkpoints = request.result as AgentCheckpoint[];

      if (checkpoints.length === 0) {
        resolve(null);
        return;
      }

      const latest = checkpoints.reduce((a, b) => (a.timestamp > b.timestamp ? a : b));
      resolve(latest);
    };

    request.onerror = () => reject(request.error);
  });
}

export async function deleteCheckpointsForChat(db: IDBDatabase, chatId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('agent_checkpoints', 'readwrite');
    const store = transaction.objectStore('agent_checkpoints');
    const index = store.index('chatId');
    const request = index.getAllKeys(chatId);

    request.onsuccess = () => {
      const keys = request.result;

      if (keys.length === 0) {
        resolve();
        return;
      }

      let completed = 0;

      for (const key of keys) {
        const deleteRequest = store.delete(key);

        deleteRequest.onsuccess = () => {
          completed++;

          if (completed === keys.length) {
            resolve();
          }
        };

        deleteRequest.onerror = () => reject(deleteRequest.error);
      }
    };

    request.onerror = () => reject(request.error);
  });
}
