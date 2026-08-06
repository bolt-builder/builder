import { useState, useEffect, useCallback } from 'react';
import { openDatabase, getAll, getSnapshot } from '~/lib/persistence/db';
import { createScopedLogger } from '~/utils/logger';
import { toast } from 'sonner';
import { csrfFetch } from '~/lib/api/csrf-client';

const logger = createScopedLogger('MigrationBanner');

const MIGRATION_FLAG_KEY = 'bolt_migration_complete';

type MigrationState = 'idle' | 'checking' | 'ready' | 'migrating' | 'done' | 'error';

interface MigrationProgress {
  current: number;
  total: number;
}

export function MigrationBanner() {
  const [state, setState] = useState<MigrationState>('checking');
  const [progress, setProgress] = useState<MigrationProgress>({ current: 0, total: 0 });
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [unmigratedCount, setUnmigratedCount] = useState(0);

  // Check for unmigrated IndexedDB data on mount
  useEffect(() => {
    let cancelled = false;

    async function checkMigration() {
      // Already migrated — nothing to do
      if (localStorage.getItem(MIGRATION_FLAG_KEY) === 'true') {
        setState('done');
        return;
      }

      try {
        const idb = await openDatabase();

        if (!idb) {
          setState('done');
          return;
        }

        const chats = await getAll(idb);

        if (!cancelled) {
          if (chats.length === 0) {
            // No IndexedDB data to migrate — mark as done
            localStorage.setItem(MIGRATION_FLAG_KEY, 'true');
            setState('done');
          } else {
            setUnmigratedCount(chats.length);
            setState('ready');
          }
        }
      } catch (err) {
        logger.error('Failed to check IndexedDB for migration:', err);

        if (!cancelled) {
          setState('done'); // Don't block UI if detection fails
        }
      }
    }

    checkMigration();

    return () => {
      cancelled = true;
    };
  }, []);

  const runMigration = useCallback(async () => {
    setState('migrating');
    setErrorMessage('');
    setProgress({ current: 0, total: 0 });

    try {
      const idb = await openDatabase();

      if (!idb) {
        throw new Error('Could not open IndexedDB');
      }

      // Export all chats
      const chats = await getAll(idb);
      const total = chats.length;
      setProgress({ current: 0, total });

      if (total === 0) {
        localStorage.setItem(MIGRATION_FLAG_KEY, 'true');
        setState('done');

        return;
      }

      // Export snapshots for each chat
      const snapshots: Array<{ chatId: string; snapshot: unknown }> = [];

      for (const chat of chats) {
        try {
          const snap = await getSnapshot(idb, chat.id);

          if (snap) {
            snapshots.push({ chatId: chat.id, snapshot: snap });
          }
        } catch {
          // Snapshot export failure is non-fatal
          logger.warn(`Could not export snapshot for chat ${chat.id}`);
        }
      }

      // Send to server in batches of 50 chats
      const BATCH_SIZE = 50;
      const totalBatches = Math.ceil(total / BATCH_SIZE);
      let totalMigrated = 0;

      for (let i = 0; i < totalBatches; i++) {
        const chatBatch = chats.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
        const chatIds = new Set(chatBatch.map((c) => c.id));
        const snapshotBatch = snapshots.filter((s) => chatIds.has(s.chatId));

        const response = await csrfFetch('/api/db/migrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chats: chatBatch,
            snapshots: snapshotBatch,
          }),
        });

        if (!response.ok) {
          const errBody = await response.json().catch(() => ({ error: 'Migration request failed' }));
          throw new Error(errBody.error || `Server responded with ${response.status}`);
        }

        const result = await response.json();
        totalMigrated += result.migrated?.chats ?? 0;
        setProgress({ current: totalMigrated, total });
      }

      // Mark migration as complete (IndexedDB data is preserved — never deleted)
      localStorage.setItem(MIGRATION_FLAG_KEY, 'true');
      setState('done');
      toast.success(`Migrated ${totalMigrated} chat${totalMigrated !== 1 ? 's' : ''} to the new database.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Migration failed unexpectedly';
      logger.error('Migration failed:', err);
      setErrorMessage(msg);
      setState('error');
    }
  }, []);

  // Don't render anything when idle, checking, or already done
  if (state === 'done' || state === 'idle' || state === 'checking') {
    return null;
  }

  return (
    <div
      role="alert"
      className="flex items-center gap-3 px-4 py-3 border-b border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary text-sm"
    >
      {state === 'ready' && (
        <>
          <div className="i-ph:database text-lg text-bolt-elements-item-contentAccent" />
          <span className="flex-1">
            Found <strong>{unmigratedCount}</strong> chat{unmigratedCount !== 1 ? 's' : ''} in your browser storage.
            Migrate to the new database for faster performance and sync support.
          </span>
          <button
            onClick={runMigration}
            className="px-3 py-1.5 rounded-md bg-bolt-elements-item-backgroundAccent text-white font-medium hover:brightness-110 transition-all text-xs"
          >
            Migrate Now
          </button>
        </>
      )}

      {state === 'migrating' && (
        <>
          <div className="i-svg-spinners:90-ring-with-bg text-lg text-bolt-elements-item-contentAccent" />
          <span className="flex-1">
            Migrating chat {progress.current} of {progress.total}...
          </span>
          <div className="w-32 h-2 bg-bolt-elements-background-depth-3 rounded-full overflow-hidden">
            <div
              className="h-full bg-bolt-elements-item-backgroundAccent transition-all duration-300"
              style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
            />
          </div>
        </>
      )}

      {state === 'error' && (
        <>
          <div className="i-ph:warning-circle text-lg text-red-500" />
          <span className="flex-1 text-red-400">Migration failed: {errorMessage}</span>
          <button
            onClick={runMigration}
            className="px-3 py-1.5 rounded-md bg-red-600 text-white font-medium hover:brightness-110 transition-all text-xs"
          >
            Retry
          </button>
        </>
      )}
    </div>
  );
}
