import { useLoaderData, useNavigate, useSearchParams } from 'react-router';
import { useState, useEffect, useCallback, useRef } from 'react';
import { atom } from 'nanostores';
import { type JSONValue, type Message } from 'ai';
import { toast } from 'sonner';
import { workbenchStore } from '~/lib/stores/workbench';
import { versionsStore } from '~/lib/stores/versions';
import { logStore } from '~/lib/stores/logs';
import { MODEL_REGEX, PROVIDER_REGEX } from '~/utils/constants';
import {
  getMessages,
  getNextId,
  getUrlId,
  openDatabase,
  setMessages,
  duplicateChat,
  createChatFromMessages,
  getSnapshot,
  setSnapshot,
} from './db';
import type { FileMap } from '~/lib/stores/files';
import type { IChatMetadata, Snapshot } from './types';
import { runtime } from '~/lib/runtime';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ChatHistory');

/**
 * Module-level guard to prevent multiple auto-rebuild invocations.
 * React strict mode (dev) double-mounts components, causing restoreSnapshot
 * to fire multiple times. Each executeCommand sends Ctrl+C first, which
 * would interrupt the previous npm install. This flag ensures only the
 * first invocation proceeds.
 */
let autoRebuildScheduled = false;

export type { ChatHistoryItem } from './types';

const persistenceEnabled = !import.meta.env.VITE_DISABLE_PERSISTENCE;

export const db = persistenceEnabled ? await openDatabase() : undefined;

// Start auto-backup once the database is available
if (db) {
  import('./autoBackup')
    .then(({ startAutoBackup }) => startAutoBackup(db!))
    .catch((err) => logger.error('Failed to start auto-backup:', err));
}

export const chatId = atom<string | undefined>(undefined);
export const description = atom<string | undefined>(undefined);
export const chatMetadata = atom<IChatMetadata | undefined>(undefined);
export function useChatHistory() {
  const navigate = useNavigate();
  const { id: mixedId } = useLoaderData<{ id?: string }>();
  const [searchParams] = useSearchParams();

  const [archivedMessages, setArchivedMessages] = useState<Message[]>([]);
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [ready, setReady] = useState<boolean>(false);
  const [urlId, setUrlId] = useState<string | undefined>();

  // Track last snapshot parameters so debounced file-change saves use the same message ID
  const lastSnapshotParamsRef = useRef<{ chatIdx: string; chatSummary?: string } | null>(null);

  /* Serialization lock to prevent concurrent storeMessageHistory calls which cause 'urlId' uniqueness constraint errors in IndexedDB */
  const isStoringRef = useRef(false);
  const pendingMessagesRef = useRef<Message[] | null>(null);

  useEffect(() => {
    if (!db) {
      setReady(true);

      if (persistenceEnabled) {
        const error = new Error('Chat persistence is unavailable');
        logStore.logError('Chat persistence initialization failed', error);
        toast.error('Chat persistence is unavailable');
      }

      return;
    }

    if (mixedId) {
      // First get messages to find the actual internal chatId, then get snapshot with correct ID
      getMessages(db, mixedId)
        .then(async (storedMessages) => {
          if (!storedMessages || storedMessages.messages.length === 0) {
            navigate('/', { replace: true });
            setReady(true);

            return;
          }

          // Use the internal chatId (like "2") not the URL id (like "2-1768949555849-0")
          const internalChatId = storedMessages.id;
          const snapshot = await getSnapshot(db, internalChatId);

          /*
           * const snapshotStr = localStorage.getItem(`snapshot:${mixedId}`); // Remove localStorage usage
           * const snapshot: Snapshot = snapshotStr ? JSON.parse(snapshotStr) : { chatIndex: 0, files: {} }; // Use snapshot from DB
           */
          const validSnapshot = snapshot || { chatIndex: '', files: {} }; // Ensure snapshot is not undefined

          const rewindId = searchParams.get('rewindTo');
          const endingIdx = rewindId
            ? storedMessages.messages.findIndex((m) => m.id === rewindId) + 1
            : storedMessages.messages.length;

          /*
           * SKIP SNAPSHOT MODE: Always load full message history
           * This avoids the "Bolt Restored your chat" message that requires manual "Revert" click
           * and prevents jsh command not found errors since we don't intercept command execution
           */
          const filteredMessages = storedMessages.messages.slice(0, endingIdx);

          // No archived messages needed when loading full history
          setArchivedMessages([]);

          /*
           * Still restore files from snapshot for instant load (if snapshot exists).
           * SKIP this during a rewind: handleRewind has just checked out the
           * checkpoint commit for the target message, and the latest snapshot
           * would overwrite that restored working tree with newer files. The
           * runtime's initial walk populates the store from the actual
           * (checked-out) tree instead.
           */
          if (!rewindId && validSnapshot?.files && Object.keys(validSnapshot.files).length > 0) {
            /*
             * For normal reloads (not rewind), still restore from snapshot for instant load
             * Set flag SYNCHRONOUSLY before setInitialMessages triggers message parsing
             */
            workbenchStore.isRestoringSession.set(true);
            restoreSnapshot(mixedId, validSnapshot);
          }

          setInitialMessages(filteredMessages);

          setUrlId(storedMessages.urlId);
          description.set(storedMessages.description);
          chatId.set(storedMessages.id);
          chatMetadata.set(storedMessages.metadata);

          // Load versions from IndexedDB (with fallback to message sync for legacy chats)
          await versionsStore.loadFromDB(db, internalChatId, storedMessages.messages);

          setReady(true);
        })
        .catch((error) => {
          logger.error(error);

          logStore.logError('Failed to load chat messages or snapshot', error); // Updated error message
          toast.error('Failed to load chat: ' + error.message); // More specific error
        });
    } else {
      /*
       * Home page (no mixedId) — reset global atoms so stale values from a
       * previous chat don't leak into a fresh session.  Without this,
       * chatId retains the old value after navigating back to "/", which
       * breaks the wasNewChat detection in Chat.client.tsx and causes
       * plan-mode carry-over to fail for new chats.
       */
      chatId.set(undefined);
      description.set(undefined);
      chatMetadata.set(undefined);
      setReady(true);
    }
  }, [mixedId, db, navigate, searchParams]); // Added db, navigate, searchParams dependencies

  const takeSnapshot = useCallback(
    async (chatIdx: string, files: FileMap, _chatId?: string | undefined, chatSummary?: string) => {
      const id = chatId.get();

      if (!id || !db) {
        return;
      }

      const snapshot: Snapshot = {
        chatIndex: chatIdx,
        files,
        summary: chatSummary,
      };

      // localStorage.setItem(`snapshot:${id}`, JSON.stringify(snapshot)); // Remove localStorage usage
      try {
        await setSnapshot(db, id, snapshot);
      } catch (error) {
        logger.error('Failed to save snapshot:', error);
        toast.error('Failed to save chat snapshot.');
      }
    },
    [db],
  );

  /*
   * Debounced file-change subscriber: re-saves the snapshot after file writes settle.
   * The normal snapshot fires 50ms after the last message change, but file actions
   * may still be in the async execution queue or watcher buffer at that point.
   * This subscriber ensures a final snapshot is taken once all files are written.
   */
  useEffect(() => {
    if (!db) {
      return undefined;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = workbenchStore.files.subscribe(() => {
      const id = chatId.get();
      const params = lastSnapshotParamsRef.current;

      if (!id || !params) {
        return;
      }

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        const files = workbenchStore.files.get();

        if (Object.keys(files).length > 0) {
          logger.debug('Debounced file-change snapshot save');
          takeSnapshot(params.chatIdx, files, undefined, params.chatSummary);
        }
      }, 500);
    });

    return () => {
      unsubscribe();

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, [db, takeSnapshot]);

  const restoreSnapshot = useCallback(async (_id: string, snapshot?: Snapshot) => {
    const container = await runtime;

    const validSnapshot = snapshot || { chatIndex: '', files: {} };

    if (!validSnapshot?.files || Object.keys(validSnapshot.files).length === 0) {
      return;
    }

    // Set the restoring flag BEFORE any file operations
    workbenchStore.isRestoringSession.set(true);

    // Sync files directly to workbench store for instant UI update
    const currentFiles = workbenchStore.files.get();
    const mergedFiles = { ...currentFiles, ...validSnapshot.files };
    workbenchStore.files.set(mergedFiles);
    workbenchStore.setDocuments(mergedFiles);

    /*
     * Guard: skip filesystem writes if the runtime is not yet booted
     * (projectId is empty). The workbench store is already updated above
     * so the UI will display files correctly. bootRuntime() will handle
     * the filesystem once boot completes, and the next user action
     * (e.g. sending a prompt) will re-sync files via action-runner.
     */
    if (!container.projectId) {
      logger.debug('Runtime not yet booted — skipping filesystem writes (workbench store already updated)');
      workbenchStore.isRestoringSession.set(false);

      return;
    }

    /* Write files to runtime filesystem in parallel */
    const dirPromises: Promise<void>[] = [];
    const filePromises: Promise<void>[] = [];

    Object.entries(validSnapshot.files).forEach(([key, value]) => {
      let adjustedKey = key;

      if (adjustedKey.startsWith(container.workdir)) {
        adjustedKey = adjustedKey.replace(container.workdir, '');
      }

      /*
       * Strip leading slashes from legacy snapshots that stored absolute paths
       * (e.g. "/src/App.tsx" → "src/App.tsx") to prevent isSafePath rejection.
       */
      adjustedKey = adjustedKey.replace(/^\/+/, '');

      if (!adjustedKey) {
        return;
      }

      if (value?.type === 'folder') {
        dirPromises.push(container.fs.mkdir(adjustedKey, { recursive: true }));
      } else if (value?.type === 'file') {
        filePromises.push(container.fs.writeFile(adjustedKey, value.content));
      }
    });

    // Create dirs first, then files — catch errors to prevent unhandled rejections
    try {
      await Promise.all(dirPromises);
      await Promise.all(filePromises);
    } catch (error) {
      logger.error('Failed to write snapshot files to runtime filesystem:', error);

      return;
    }

    /*
     * Auto-rebuild: After restoring files from snapshot, detect package.json
     * and automatically run install + dev server so the preview works immediately.
     * This is fire-and-forget — it waits for the terminal to be ready, then runs.
     */
    const packageJsonEntry = Object.entries(validSnapshot.files).find(
      ([key]) => key.endsWith('/package.json') || key === '/package.json',
    );

    if (packageJsonEntry && !autoRebuildScheduled) {
      autoRebuildScheduled = true;

      const [, packageJsonFile] = packageJsonEntry;

      // Parse package.json to detect the correct dev command
      let devCommand = 'npm run dev';

      if (packageJsonFile?.type === 'file' && packageJsonFile.content) {
        try {
          const pkg = JSON.parse(packageJsonFile.content);

          if (pkg.scripts) {
            if (pkg.scripts.dev) {
              devCommand = 'npm run dev';
            } else if (pkg.scripts.start) {
              devCommand = 'npm start';
            } else if (pkg.scripts.serve) {
              devCommand = 'npm run serve';
            }
          }
        } catch {
          // Use default dev command if parsing fails
        }
      }

      // Fire-and-forget: wait for terminal → install → start dev server
      (async () => {
        try {
          const shell = workbenchStore.boltTerminal;
          await shell.ready();

          logger.info('Auto-rebuild: Installing dependencies...');

          const installResult = await shell.executeCommand('auto-rebuild-install', 'npm install --legacy-peer-deps');

          if (installResult && installResult.exitCode !== 0) {
            logger.error('Auto-rebuild: npm install failed with exit code', installResult.exitCode);
            autoRebuildScheduled = false;

            return;
          }

          logger.info('Auto-rebuild: Starting dev server...');

          // Don't await dev server — it's a long-running process
          shell.executeCommand('auto-rebuild-dev', devCommand);

          // Reset flag after a delay so future restores can trigger rebuild
          setTimeout(() => {
            autoRebuildScheduled = false;
          }, 5000);
        } catch (error) {
          logger.error('Auto-rebuild failed:', error);
          autoRebuildScheduled = false;
        }
      })();
    }
  }, []);

  return {
    ready: !mixedId || ready,
    initialMessages,
    updateChatMetaData: async (metadata: IChatMetadata) => {
      const id = chatId.get();

      if (!db || !id) {
        return;
      }

      try {
        await setMessages(db, id, initialMessages, urlId, description.get(), undefined, metadata);
        chatMetadata.set(metadata);
      } catch (error) {
        toast.error('Failed to update chat metadata');
        logger.error(error);
      }
    },
    storeMessageHistory: async function storeMessageHistory(messages: Message[]) {
      if (!db || messages.length === 0) {
        return;
      }

      /*
       * If a save is already in-flight, stash the latest messages so they
       * are saved once the current write completes. This prevents data loss
       * when storeMessageHistory is called rapidly during streaming.
       */
      if (isStoringRef.current) {
        pendingMessagesRef.current = messages;

        return;
      }

      isStoringRef.current = true;

      try {
        messages = messages.filter((m) => !m.annotations?.includes('no-store'));

        if (initialMessages.length === 0 && !chatId.get()) {
          const nextId = await getNextId(db);
          chatId.set(nextId);
          versionsStore.setDBContext(db, nextId);
        }

        let resolvedUrlId = urlId;

        if (!resolvedUrlId) {
          const id = chatId.get()!;
          resolvedUrlId = await getUrlId(db, id);
          setUrlId(resolvedUrlId);
          navigateChat(resolvedUrlId);
        }

        let chatSummary: string | undefined = undefined;
        const lastMessage = messages[messages.length - 1];

        if (lastMessage.role === 'assistant') {
          const annotations = lastMessage.annotations as JSONValue[];
          const filteredAnnotations = (annotations?.filter(
            (annotation: JSONValue) =>
              annotation && typeof annotation === 'object' && Object.keys(annotation).includes('type'),
          ) || []) as (Record<string, unknown> & { type: string })[];

          if (filteredAnnotations.find((annotation) => annotation.type === 'chatSummary')) {
            chatSummary = filteredAnnotations.find((annotation) => annotation.type === 'chatSummary')?.summary as
              string | undefined;
          }

          // Extract token usage from annotations
          const usageAnnotation = filteredAnnotations.find((annotation) => annotation.type === 'usage');
          const usage = usageAnnotation?.value as { totalTokens?: number } | undefined;

          /*
           * Queue metadata for the version that will be created shortly.
           * Version creation is debounced ~500ms after artifact close,
           * so we store the meta as "pending" and it gets applied in createVersion().
           */
          versionsStore.setPendingMeta({
            totalTokens: usage?.totalTokens,
            chatSummary,
          });

          // Also try updating if the version already exists (e.g. page reload)
          const latestVersion = versionsStore.getLatestVersion();

          if (latestVersion && latestVersion.messageId === lastMessage.id) {
            versionsStore.updateVersionMeta(latestVersion.id, {
              totalTokens: usage?.totalTokens,
              chatSummary,
            });
          }

          /*
           * Schedule retries to cover the timing gap between annotation
           * extraction and version creation (createVersion uses 500ms debounce)
           */
          const retryMeta = { totalTokens: usage?.totalTokens, chatSummary };
          const retryMessageId = lastMessage.id;

          const attemptMetaUpdate = () => {
            const latest = versionsStore.getLatestVersion();

            if (latest && latest.messageId === retryMessageId && !latest.totalTokens && retryMeta.totalTokens) {
              versionsStore.updateVersionMeta(latest.id, retryMeta);
            }
          };

          // Retry at 1.5s and 4s to cover version creation timing
          setTimeout(attemptMetaUpdate, 1500);
          setTimeout(attemptMetaUpdate, 4000);
        }

        lastSnapshotParamsRef.current = { chatIdx: messages[messages.length - 1].id, chatSummary };

        takeSnapshot(messages[messages.length - 1].id, workbenchStore.files.get(), resolvedUrlId, chatSummary);

        /*
         * Search ALL artifacts for one with a meaningful title.
         * The structured mode creates a "Code Changes" placeholder BEFORE the XML parser
         * extracts the real title from <boltArtifact title="...">, so firstArtifact
         * always has "Code Changes". We iterate through all artifacts to find the real one.
         * Also filter out file-name-style titles (e.g., "index.css", "App.tsx") since
         * those are not descriptive project names.
         */
        const FILE_NAME_RE = /^[\w.-]+\.\w{1,5}$/;
        const SKIP_TITLES = new Set(['Code Changes', 'code changes']);
        const allArtifactEntries = Object.values(workbenchStore.artifacts.get() ?? {});
        const meaningfulArtifact = allArtifactEntries.find(
          (a) => a?.title && !SKIP_TITLES.has(a.title) && !FILE_NAME_RE.test(a.title),
        );
        const artifactTitle = meaningfulArtifact?.title ?? '';

        if (artifactTitle) {
          description.set(artifactTitle);
        } else if (!description.get()) {
          const firstUserMsg = messages.find((m) => m.role === 'user');

          if (firstUserMsg) {
            let text =
              typeof firstUserMsg.content === 'string'
                ? firstUserMsg.content
                : ((firstUserMsg.parts?.find((p: Record<string, unknown>) => p.type === 'text') as { text?: string })
                    ?.text ?? '');

            // Strip [Model: ...] and [Provider: ...] metadata prefixes
            text = text.replace(MODEL_REGEX, '').replace(PROVIDER_REGEX, '').trim();

            if (text) {
              const truncated = text.slice(0, 60).trim();
              description.set(truncated.length < text.length ? `${truncated}…` : truncated);
            }
          }
        }

        const finalChatId = chatId.get();

        if (!finalChatId) {
          logger.error('Cannot save messages, chat ID is not set.');
          toast.error('Failed to save chat messages: Chat ID missing.');

          return;
        }

        await setMessages(
          db,
          finalChatId,
          [...archivedMessages, ...messages],
          resolvedUrlId,
          description.get(),
          undefined,
          chatMetadata.get(),
        );
      } finally {
        isStoringRef.current = false;

        const pending = pendingMessagesRef.current;

        if (pending) {
          pendingMessagesRef.current = null;
          storeMessageHistory(pending);
        }
      }
    },
    duplicateCurrentChat: async (listItemId: string) => {
      if (!db || (!mixedId && !listItemId)) {
        return;
      }

      try {
        const newId = await duplicateChat(db, mixedId || listItemId);
        navigate(`/chat/${newId}`);
        toast.success('Chat duplicated successfully');
      } catch (error) {
        toast.error('Failed to duplicate chat');
        logger.error(error);
      }
    },
    importChat: async (
      description: string,
      messages: Message[],
      metadata?: IChatMetadata,
      options?: { skipRedirect?: boolean },
    ): Promise<string | undefined> => {
      if (!db) {
        return undefined;
      }

      try {
        const newId = await createChatFromMessages(db, description, messages, metadata);

        if (!options?.skipRedirect) {
          window.location.href = `/chat/${newId}`;
        }

        toast.success('Chat imported successfully');

        return newId;
      } catch (error) {
        if (error instanceof Error) {
          toast.error('Failed to import chat: ' + error.message);
        } else {
          toast.error('Failed to import chat');
        }

        return undefined;
      }
    },
    exportChat: async (id = urlId) => {
      if (!db || !id) {
        return;
      }

      try {
        const chat = await getMessages(db, id);

        if (!chat) {
          toast.error('Chat not found');
          return;
        }

        const chatData = {
          messages: chat.messages,
          description: chat.description,
          exportDate: new Date().toISOString(),
        };

        const blob = new Blob([JSON.stringify(chatData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat-${new Date().toISOString()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (error) {
        toast.error('Failed to export chat');
        logger.error('Failed to export chat:', error);
      }
    },
  };
}

function navigateChat(nextId: string) {
  /**
   * Updates the URL to the new chat ID without triggering a full Remix re-render.
   *
   * We use window.history.replaceState instead of Remix's navigate() because
   * navigate() causes a re-render of <Chat /> that breaks the app's state.
   * This approach updates the URL silently while preserving component state.
   */
  const url = new URL(window.location.href);
  url.pathname = `/chat/${nextId}`;

  window.history.replaceState({ idx: window.history.state?.idx ?? 0 }, '', url);
}
