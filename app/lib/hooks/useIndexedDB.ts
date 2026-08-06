import { useState, useEffect, useRef } from 'react';

/**
 * Hook to initialize and provide access to the IndexedDB database
 */
export function useIndexedDB() {
  const [db, setDb] = useState<IDBDatabase | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  /*
   * Ref keeps track of the database instance so the cleanup function
   * always has the current value (avoids stale-closure over `db` state).
   */
  const dbRef = useRef<IDBDatabase | null>(null);

  useEffect(() => {
    const initDB = async () => {
      try {
        setIsLoading(true);

        const request = indexedDB.open('boltDB', 1);

        request.onupgradeneeded = (event) => {
          const database = (event.target as IDBOpenDBRequest).result;

          // Create object stores if they don't exist
          if (!database.objectStoreNames.contains('chats')) {
            const chatStore = database.createObjectStore('chats', { keyPath: 'id' });
            chatStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          }

          if (!database.objectStoreNames.contains('settings')) {
            database.createObjectStore('settings', { keyPath: 'key' });
          }
        };

        request.onsuccess = (event) => {
          const database = (event.target as IDBOpenDBRequest).result;
          dbRef.current = database;
          setDb(database);
          setIsLoading(false);
        };

        request.onerror = (event) => {
          setError(new Error(`Database error: ${(event.target as IDBOpenDBRequest).error?.message}`));
          setIsLoading(false);
        };
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Unknown error initializing database'));
        setIsLoading(false);
      }
    };

    initDB();

    return () => {
      if (dbRef.current) {
        dbRef.current.close();
        dbRef.current = null;
      }
    };
  }, []);

  return { db, isLoading, error };
}
