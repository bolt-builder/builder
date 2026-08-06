import type { RuntimeProvider, WatchEvent } from '~/lib/runtime/runtime-provider';
import { getEncoding } from 'istextorbinary';
import { map, type MapStore } from 'nanostores';
import { Buffer } from 'node:buffer';
import { path, toRelativePath } from '~/utils/path';
import { WORK_DIR } from '~/utils/constants';
import { computeFileModifications } from '~/utils/diff';
import { createScopedLogger } from '~/utils/logger';
import { unreachable } from '~/utils/unreachable';
import {
  addLockedFile,
  removeLockedFile,
  addLockedFolder,
  removeLockedFolder,
  getLockedItemsForChat,
  getLockedFilesForChat,
  getLockedFoldersForChat,
  isPathInLockedFolder,
  migrateLegacyLocks,
} from '~/lib/persistence/lockedFiles';
import { getCurrentChatId } from '~/utils/fileLocks';

const logger = createScopedLogger('FilesStore');

const utf8TextDecoder = new TextDecoder('utf8', { fatal: true });

/** Per-file generation status during structured streaming. */
export type FileGenerationState = 'pending' | 'generating' | 'complete' | 'error';

/**
 * Tracks the generation status of individual files during LLM streaming.
 * Key: file path, Value: current generation state.
 * Updated by the StreamEventRouter on file_open, file_close, and error events.
 */
export const fileGenerationStatus: MapStore<Record<string, FileGenerationState>> = map({});

export interface File {
  type: 'file';
  content: string;
  isBinary: boolean;
  isLocked?: boolean;
  lockedByFolder?: string; // Path of the folder that locked this file
}

export interface Folder {
  type: 'folder';
  isLocked?: boolean;
  lockedByFolder?: string; // Path of the folder that locked this folder (for nested folders)
}

type Dirent = File | Folder;

export type FileMap = Record<string, Dirent | undefined>;

/**
 * Symbol used to mark `history` as already monkey-patched.
 * Prevents listener/patch stacking across HMR reloads.
 */
const HISTORY_PATCHED = Symbol.for('FilesStore.historyPatched');

export class FilesStore {
  #runtime: Promise<RuntimeProvider>;

  /**
   * Tracks the number of files without folders.
   */
  #size = 0;

  /** AbortController for URL-change event listeners; aborted on dispose. */
  #urlListenerAbort: AbortController | null = null;

  /** Original `history.pushState` before monkey-patching, for restoration. */
  #originalPushState: History['pushState'] | null = null;

  /** Original `history.replaceState` before monkey-patching, for restoration. */
  #originalReplaceState: History['replaceState'] | null = null;

  /**
   * @note Keeps track all modified files with their original content since the last user message.
   * Needs to be reset when the user sends another message and all changes have to be submitted
   * for the model to be aware of the changes.
   */
  #modifiedFiles: Map<string, string> = import.meta.hot?.data.modifiedFiles ?? new Map();

  /**
   * Keeps track of deleted files and folders to prevent them from reappearing on reload
   */
  #deletedPaths: Set<string> = import.meta.hot?.data.deletedPaths ?? new Set();

  /**
   * Map of files that matches the state of the runtime filesystem.
   */
  files: MapStore<FileMap> = import.meta.hot?.data.files ?? map({});

  get filesCount() {
    return this.#size;
  }

  constructor(runtimePromise: Promise<RuntimeProvider>) {
    this.#runtime = runtimePromise;

    // Load deleted paths from localStorage if available
    try {
      if (typeof localStorage !== 'undefined') {
        const deletedPathsJson = localStorage.getItem('bolt-deleted-paths');

        if (deletedPathsJson) {
          const deletedPaths = JSON.parse(deletedPathsJson);

          if (Array.isArray(deletedPaths)) {
            deletedPaths.forEach((path) => this.#deletedPaths.add(path));
          }
        }
      }
    } catch (error) {
      logger.error('Failed to load deleted paths from localStorage', error);
    }

    // Load locked files from localStorage
    this.#loadLockedFiles();

    if (import.meta.hot) {
      // Dispose previous instance's listeners/patches before setting up new ones
      const prev: FilesStore | undefined = import.meta.hot.data._filesStoreInstance;

      if (prev && typeof prev.dispose === 'function') {
        prev.dispose();
      }

      // Persist our state across hot reloads
      import.meta.hot.data.files = this.files;
      import.meta.hot.data.modifiedFiles = this.#modifiedFiles;
      import.meta.hot.data.deletedPaths = this.#deletedPaths;
      import.meta.hot.data._filesStoreInstance = this;
    }

    // Listen for URL changes to detect chat ID changes
    if (typeof window !== 'undefined') {
      this.#setupUrlChangeListeners();
    }

    this.#init();
  }

  /**
   * Set up URL-change listeners (popstate, hashchange) and monkey-patch
   * `history.pushState`/`replaceState` to detect programmatic navigation.
   *
   * Guards against double-patching so HMR or multiple constructions don't
   * stack listeners or wrappers.
   */
  #setupUrlChangeListeners() {
    // Abort any previous listeners owned by this instance
    this.#urlListenerAbort?.abort();

    const abort = new AbortController();
    this.#urlListenerAbort = abort;

    let lastChatId = getCurrentChatId();

    const handleUrlChange = () => {
      const currentChatId = getCurrentChatId();

      if (currentChatId !== lastChatId) {
        logger.info(`Chat ID changed from ${lastChatId} to ${currentChatId}, reloading locks`);
        lastChatId = currentChatId;
        this.#loadLockedFiles(currentChatId);
      }
    };

    // Use popstate for browser back/forward navigation
    window.addEventListener('popstate', handleUrlChange, { signal: abort.signal });

    // Use hashchange for hash-based routing
    window.addEventListener('hashchange', handleUrlChange, { signal: abort.signal });

    // Monkey-patch history only once (guard via symbol on the history object)
    const hist = history as History & { [key: symbol]: boolean };

    if (!hist[HISTORY_PATCHED]) {
      const originalPushState = history.pushState.bind(history);
      const originalReplaceState = history.replaceState.bind(history);

      this.#originalPushState = originalPushState;
      this.#originalReplaceState = originalReplaceState;

      history.pushState = (...args: Parameters<History['pushState']>) => {
        originalPushState(...args);
        handleUrlChange();
      };

      history.replaceState = (...args: Parameters<History['replaceState']>) => {
        originalReplaceState(...args);
        handleUrlChange();
      };

      hist[HISTORY_PATCHED] = true;
    }
  }

  /**
   * Clean up URL-change listeners and restore the original `history.pushState`
   * / `replaceState` functions. Safe to call multiple times.
   */
  dispose() {
    // Remove popstate / hashchange listeners
    if (this.#urlListenerAbort) {
      this.#urlListenerAbort.abort();
      this.#urlListenerAbort = null;
    }

    // Restore original history methods if we were the ones who patched them
    if (typeof window !== 'undefined') {
      const hist = history as History & { [key: symbol]: boolean };

      if (this.#originalPushState) {
        history.pushState = this.#originalPushState;
        this.#originalPushState = null;
      }

      if (this.#originalReplaceState) {
        history.replaceState = this.#originalReplaceState;
        this.#originalReplaceState = null;
      }

      delete hist[HISTORY_PATCHED];
    }
  }

  /**
   * Load locked files and folders from localStorage and update the file objects
   * @param chatId Optional chat ID to load locks for (defaults to current chat)
   */
  #loadLockedFiles(chatId?: string) {
    try {
      const currentChatId = chatId || getCurrentChatId();
      const startTime = performance.now();

      // Migrate any legacy locks to the current chat
      migrateLegacyLocks(currentChatId);

      // Get all locked items for this chat (uses optimized cache)
      const lockedItems = getLockedItemsForChat(currentChatId);

      // Split into files and folders
      const lockedFiles = lockedItems.filter((item) => !item.isFolder);
      const lockedFolders = lockedItems.filter((item) => item.isFolder);

      if (lockedItems.length === 0) {
        logger.debug(`No locked items found for chat ID: ${currentChatId}`);
        return;
      }

      logger.info(
        `Found ${lockedFiles.length} locked files and ${lockedFolders.length} locked folders for chat ID: ${currentChatId}`,
      );

      const currentFiles = this.files.get();
      const updates: FileMap = {};

      // Process file locks
      for (const lockedFile of lockedFiles) {
        const file = currentFiles[lockedFile.path];

        if (file?.type === 'file') {
          updates[lockedFile.path] = {
            ...file,
            isLocked: true,
          };
        }
      }

      // Process folder locks
      for (const lockedFolder of lockedFolders) {
        const folder = currentFiles[lockedFolder.path];

        if (folder?.type === 'folder') {
          updates[lockedFolder.path] = {
            ...folder,
            isLocked: true,
          };

          // Also mark all files within the folder as locked
          this.#applyLockToFolderContents(currentFiles, updates, lockedFolder.path);
        }
      }

      if (Object.keys(updates).length > 0) {
        this.files.set({ ...currentFiles, ...updates });
      }

      const endTime = performance.now();
      logger.info(`Loaded locked items in ${Math.round(endTime - startTime)}ms`);
    } catch (error) {
      logger.error('Failed to load locked files from localStorage', error);
    }
  }

  /**
   * Apply a lock to all files within a folder
   * @param currentFiles Current file map
   * @param updates Updates to apply
   * @param folderPath Path of the folder to lock
   */
  #applyLockToFolderContents(currentFiles: FileMap, updates: FileMap, folderPath: string) {
    const folderPrefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;

    // Find all files that are within this folder
    Object.entries(currentFiles).forEach(([path, file]) => {
      if (path.startsWith(folderPrefix) && file) {
        if (file.type === 'file') {
          updates[path] = {
            ...file,
            isLocked: true,

            // Add a property to indicate this is locked by a parent folder
            lockedByFolder: folderPath,
          };
        } else if (file.type === 'folder') {
          updates[path] = {
            ...file,
            isLocked: true,

            // Add a property to indicate this is locked by a parent folder
            lockedByFolder: folderPath,
          };
        }
      }
    });
  }

  /**
   * Lock a file
   * @param filePath Path to the file to lock
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns True if the file was successfully locked
   */
  lockFile(filePath: string, chatId?: string) {
    const file = this.getFile(filePath);
    const currentChatId = chatId || getCurrentChatId();

    if (!file) {
      logger.error(`Cannot lock non-existent file: ${filePath}`);
      return false;
    }

    // Update the file in the store
    this.files.setKey(filePath, {
      ...file,
      isLocked: true,
    });

    // Persist to localStorage with chat ID
    addLockedFile(currentChatId, filePath);

    logger.info(`File locked: ${filePath} for chat: ${currentChatId}`);

    return true;
  }

  /**
   * Lock a folder and all its contents
   * @param folderPath Path to the folder to lock
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns True if the folder was successfully locked
   */
  lockFolder(folderPath: string, chatId?: string) {
    const folder = this.getFileOrFolder(folderPath);
    const currentFiles = this.files.get();
    const currentChatId = chatId || getCurrentChatId();

    if (!folder || folder.type !== 'folder') {
      logger.error(`Cannot lock non-existent folder: ${folderPath}`);
      return false;
    }

    const updates: FileMap = {};

    // Update the folder in the store
    updates[folderPath] = {
      type: folder.type,
      isLocked: true,
    };

    // Apply lock to all files within the folder
    this.#applyLockToFolderContents(currentFiles, updates, folderPath);

    // Update the store with all changes
    this.files.set({ ...currentFiles, ...updates });

    // Persist to localStorage with chat ID
    addLockedFolder(currentChatId, folderPath);

    logger.info(`Folder locked: ${folderPath} for chat: ${currentChatId}`);

    return true;
  }

  /**
   * Unlock a file
   * @param filePath Path to the file to unlock
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns True if the file was successfully unlocked
   */
  unlockFile(filePath: string, chatId?: string) {
    const file = this.getFile(filePath);
    const currentChatId = chatId || getCurrentChatId();

    if (!file) {
      logger.error(`Cannot unlock non-existent file: ${filePath}`);
      return false;
    }

    // Update the file in the store
    this.files.setKey(filePath, {
      ...file,
      isLocked: false,
      lockedByFolder: undefined, // Clear the parent folder lock reference if it exists
    });

    // Remove from localStorage with chat ID
    removeLockedFile(currentChatId, filePath);

    logger.info(`File unlocked: ${filePath} for chat: ${currentChatId}`);

    return true;
  }

  /**
   * Unlock a folder and all its contents
   * @param folderPath Path to the folder to unlock
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns True if the folder was successfully unlocked
   */
  unlockFolder(folderPath: string, chatId?: string) {
    const folder = this.getFileOrFolder(folderPath);
    const currentFiles = this.files.get();
    const currentChatId = chatId || getCurrentChatId();

    if (!folder || folder.type !== 'folder') {
      logger.error(`Cannot unlock non-existent folder: ${folderPath}`);
      return false;
    }

    const updates: FileMap = {};

    // Update the folder in the store
    updates[folderPath] = {
      type: folder.type,
      isLocked: false,
    };

    // Find all files that are within this folder and unlock them
    const folderPrefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;

    Object.entries(currentFiles).forEach(([path, file]) => {
      if (path.startsWith(folderPrefix) && file) {
        if (file.type === 'file' && file.lockedByFolder === folderPath) {
          updates[path] = {
            ...file,
            isLocked: false,
            lockedByFolder: undefined,
          };
        } else if (file.type === 'folder' && file.lockedByFolder === folderPath) {
          updates[path] = {
            type: file.type,
            isLocked: false,
            lockedByFolder: undefined,
          };
        }
      }
    });

    // Update the store with all changes
    this.files.set({ ...currentFiles, ...updates });

    // Remove from localStorage with chat ID
    removeLockedFolder(currentChatId, folderPath);

    logger.info(`Folder unlocked: ${folderPath} for chat: ${currentChatId}`);

    return true;
  }

  /**
   * Check if a file is locked
   * @param filePath Path to the file to check
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns Object with locked status, lock mode, and what caused the lock
   */
  isFileLocked(filePath: string, chatId?: string): { locked: boolean; lockedBy?: string } {
    const file = this.getFile(filePath);
    const currentChatId = chatId || getCurrentChatId();

    if (!file) {
      return { locked: false };
    }

    // First check the in-memory state
    if (file.isLocked) {
      // If the file is locked by a folder, include that information
      if (file.lockedByFolder) {
        return {
          locked: true,
          lockedBy: file.lockedByFolder as string,
        };
      }

      return {
        locked: true,
        lockedBy: filePath,
      };
    }

    // Then check localStorage for direct file locks
    const lockedFiles = getLockedFilesForChat(currentChatId);
    const lockedFile = lockedFiles.find((item) => item.path === filePath);

    if (lockedFile) {
      // Update the in-memory state to match localStorage
      this.files.setKey(filePath, {
        ...file,
        isLocked: true,
      });

      return { locked: true, lockedBy: filePath };
    }

    // Finally, check if the file is in a locked folder
    const folderLockResult = this.isFileInLockedFolder(filePath, currentChatId);

    if (folderLockResult.locked) {
      // Update the in-memory state to reflect the folder lock
      this.files.setKey(filePath, {
        ...file,
        isLocked: true,
        lockedByFolder: folderLockResult.lockedBy,
      });

      return folderLockResult;
    }

    return { locked: false };
  }

  /**
   * Check if a file is within a locked folder
   * @param filePath Path to the file to check
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns Object with locked status, lock mode, and the folder that caused the lock
   */
  isFileInLockedFolder(filePath: string, chatId?: string): { locked: boolean; lockedBy?: string } {
    const currentChatId = chatId || getCurrentChatId();

    // Use the optimized function from lockedFiles.ts
    return isPathInLockedFolder(currentChatId, filePath);
  }

  /**
   * Check if a folder is locked
   * @param folderPath Path to the folder to check
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns Object with locked status and lock mode
   */
  isFolderLocked(folderPath: string, chatId?: string): { isLocked: boolean; lockedBy?: string } {
    const folder = this.getFileOrFolder(folderPath);
    const currentChatId = chatId || getCurrentChatId();

    if (!folder || folder.type !== 'folder') {
      return { isLocked: false };
    }

    // First check the in-memory state
    if (folder.isLocked) {
      return {
        isLocked: true,
        lockedBy: folderPath,
      };
    }

    // Then check localStorage for this specific chat
    const lockedFolders = getLockedFoldersForChat(currentChatId);
    const lockedFolder = lockedFolders.find((item) => item.path === folderPath);

    if (lockedFolder) {
      // Update the in-memory state to match localStorage
      this.files.setKey(folderPath, {
        type: folder.type,
        isLocked: true,
      });

      return { isLocked: true, lockedBy: folderPath };
    }

    return { isLocked: false };
  }

  getFile(filePath: string) {
    const dirent = this.files.get()[filePath];

    if (!dirent) {
      return undefined;
    }

    // For backward compatibility, only return file type dirents
    if (dirent.type !== 'file') {
      return undefined;
    }

    return dirent;
  }

  /**
   * Get any file or folder from the file system
   * @param path Path to the file or folder
   * @returns The file or folder, or undefined if it doesn't exist
   */
  getFileOrFolder(path: string) {
    return this.files.get()[path];
  }

  getFileModifications() {
    return computeFileModifications(this.files.get(), this.#modifiedFiles);
  }
  getModifiedFiles() {
    let modifiedFiles: { [path: string]: File } | undefined = undefined;

    for (const [filePath, originalContent] of this.#modifiedFiles) {
      const file = this.files.get()[filePath];

      if (file?.type !== 'file') {
        continue;
      }

      if (file.content === originalContent) {
        continue;
      }

      if (!modifiedFiles) {
        modifiedFiles = {};
      }

      modifiedFiles[filePath] = file;
    }

    return modifiedFiles;
  }

  /**
   * True when the user manually edited (and saved) this file since the last
   * AI turn. Used by the action runner to route conflicting AI writes through
   * the staged-changes review flow instead of silently overwriting.
   */
  isUserModified(filePath: string): boolean {
    return this.#modifiedFiles.has(filePath);
  }

  resetFileModifications() {
    this.#modifiedFiles.clear();
  }

  async saveFile(filePath: string, content: string) {
    const runtime = await this.#runtime;

    try {
      const relativePath = toRelativePath(runtime.workdir, filePath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid file path, write '${relativePath}'`);
      }

      const oldContent = this.getFile(filePath)?.content;

      if (!oldContent && oldContent !== '') {
        unreachable('Expected content to be defined');
      }

      await runtime.fs.writeFile(relativePath, content);

      if (!this.#modifiedFiles.has(filePath)) {
        this.#modifiedFiles.set(filePath, oldContent);
      }

      // Get the current lock state before updating
      const currentFile = this.files.get()[filePath];
      const isLocked = currentFile?.type === 'file' ? currentFile.isLocked : false;

      // we immediately update the file and don't rely on the `change` event coming from the watcher
      this.files.setKey(filePath, {
        type: 'file',
        content,
        isBinary: false,
        isLocked,
      });

      logger.info('File updated');
    } catch (error) {
      logger.error('Failed to update file content\n\n', error);

      throw error;
    }
  }

  async #init() {
    const runtime = await this.#runtime;

    /* Guard against undefined runtime (SSR or failed boot) */
    if (!runtime) {
      logger.warn('Runtime not available, skipping init');

      return;
    }

    // Clean up any files that were previously deleted
    this.#cleanupDeletedFiles();

    /* Set up file watcher — the runtime watch already buffers events (100 ms). */
    runtime.fs.watch(`${WORK_DIR}/**`, (events) => void this.#processWatchEvents(events));

    // Get the current chat ID
    const currentChatId = getCurrentChatId();

    // Migrate any legacy locks to the current chat
    migrateLegacyLocks(currentChatId);

    // Load locked files immediately for the current chat
    this.#loadLockedFiles(currentChatId);

    /**
     * Also set up a timer to load locked files again after a delay.
     * This ensures that locks are applied even if files are loaded asynchronously.
     */
    setTimeout(() => {
      this.#loadLockedFiles(currentChatId);
    }, 2000);

    /*
     * No periodic setInterval needed — the storage event listener in lockedFiles.ts
     * handles cross-tab sync, and URL change listeners handle chat navigation.
     */
  }

  /**
   * Removes any deleted files/folders from the store
   */
  #cleanupDeletedFiles() {
    if (this.#deletedPaths.size === 0) {
      return;
    }

    const currentFiles = this.files.get();
    const pathsToDelete = new Set<string>();

    // Precompute prefixes for efficient checking
    const deletedPrefixes = [...this.#deletedPaths].map((p) => p + '/');

    // Iterate through all current files/folders once
    for (const [path, dirent] of Object.entries(currentFiles)) {
      // Skip if dirent is already undefined (shouldn't happen often but good practice)
      if (!dirent) {
        continue;
      }

      // Check for exact match in deleted paths
      if (this.#deletedPaths.has(path)) {
        pathsToDelete.add(path);
        continue; // No need to check prefixes if it's an exact match
      }

      // Check if the path starts with any of the deleted folder prefixes
      for (const prefix of deletedPrefixes) {
        if (path.startsWith(prefix)) {
          pathsToDelete.add(path);
          break; // Found a match, no need to check other prefixes for this path
        }
      }
    }

    // Perform the deletions and updates based on the collected paths
    if (pathsToDelete.size > 0) {
      const updates: FileMap = {};

      for (const pathToDelete of pathsToDelete) {
        const dirent = currentFiles[pathToDelete];
        updates[pathToDelete] = undefined; // Mark for deletion in the map update

        if (dirent?.type === 'file') {
          this.#size--;

          if (this.#modifiedFiles.has(pathToDelete)) {
            this.#modifiedFiles.delete(pathToDelete);
          }
        }
      }

      // Apply all deletions to the store at once for potential efficiency
      this.files.set({ ...currentFiles, ...updates });
    }
  }

  async #processWatchEvents(events: WatchEvent[]) {
    for (const event of events) {
      /* Remove any trailing slashes */
      let sanitizedPath = event.path.replace(/\/+$/g, '');

      /*
       * Ensure paths use the WORK_DIR prefix expected by the FileTree.
       * Server-side watch events emit paths relative to the project root
       * (e.g. `src/App.tsx`), but the file map and FileTree use
       * WORK_DIR-prefixed paths (e.g. `/home/project/src/App.tsx`).
       */
      if (!sanitizedPath.startsWith(WORK_DIR)) {
        sanitizedPath = `${WORK_DIR}/${sanitizedPath}`;
      }

      // Skip node_modules and .git — handled server-side too, but belt-and-suspenders
      if (sanitizedPath.includes('node_modules') || sanitizedPath.includes('.git')) {
        continue;
      }

      switch (event.type) {
        case 'addDir': {
          this.files.setKey(sanitizedPath, { type: 'folder' });
          break;
        }
        case 'unlinkDir': {
          this.files.setKey(sanitizedPath, undefined);

          for (const [direntPath] of Object.entries(this.files.get())) {
            if (direntPath.startsWith(sanitizedPath)) {
              this.files.setKey(direntPath, undefined);
            }
          }

          break;
        }
        case 'add':
        case 'change': {
          if (event.type === 'add') {
            /*
             * Only increment size if the file doesn't already exist in the map.
             * The initial walk and watcher can both emit 'add' for the same file.
             */
            const existing = this.files.get()[sanitizedPath];

            if (!existing) {
              this.#size++;
            }
          }

          await this.#readAndSetFile(sanitizedPath);

          break;
        }
        case 'unlink': {
          this.#size--;
          this.files.setKey(sanitizedPath, undefined);
          break;
        }
      }
    }
  }

  /**
   * Read a file from the runtime filesystem and update the in-memory store.
   * Used by the watch handler when file content is not provided inline.
   */
  async #readAndSetFile(filePath: string) {
    // Skip node_modules and .git — these are noisy and not user-editable
    if (filePath.includes('node_modules') || filePath.includes('/.git/') || filePath.includes('\\.git\\')) {
      return;
    }

    try {
      const runtime = await this.#runtime;
      const relativePath = toRelativePath(runtime.workdir, filePath);

      // Verify it's actually a file (not a directory) before reading
      try {
        const stat = await runtime.fs.stat(relativePath);

        if (stat.isDirectory) {
          return;
        }
      } catch {
        // stat failed — file may have been deleted between watch event and read
        return;
      }

      const buffer = await runtime.fs.readFileRaw(relativePath);

      /**
       * @note This check is purely for the editor. The way we detect this is not
       * bullet-proof and it's a best guess so there might be false-positives.
       * The reason we do this is because we don't want to display binary files
       * in the editor nor allow to edit them.
       */
      const isBinary = isBinaryFile(buffer);
      const content = isBinary ? '' : this.#decodeFileContent(buffer);

      this.files.setKey(filePath, { type: 'file', content, isBinary });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;

      // EISDIR (tried to read a directory) and ENOENT (file deleted) are expected during watch
      if (code === 'EISDIR' || code === 'ENOENT') {
        return;
      }

      logger.warn(`Failed to read file during watch: ${filePath}`, error);
    }
  }

  #decodeFileContent(buffer?: Uint8Array) {
    if (!buffer || buffer.byteLength === 0) {
      return '';
    }

    try {
      return utf8TextDecoder.decode(buffer);
    } catch (error) {
      logger.error(error);
      return '';
    }
  }

  async createFile(filePath: string, content: string | Uint8Array = '') {
    const runtime = await this.#runtime;

    try {
      const relativePath = toRelativePath(runtime.workdir, filePath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid file path, create '${relativePath}'`);
      }

      const dirPath = path.dirname(relativePath);

      if (dirPath !== '.') {
        await runtime.fs.mkdir(dirPath, { recursive: true });
      }

      const isBinary = content instanceof Uint8Array;

      if (isBinary) {
        await runtime.fs.writeFile(relativePath, content);

        const base64Content = Buffer.from(content).toString('base64');
        this.files.setKey(filePath, {
          type: 'file',
          content: base64Content,
          isBinary: true,
          isLocked: false,
        });

        this.#modifiedFiles.set(filePath, base64Content);
      } else {
        const contentToWrite = (content as string).length === 0 ? ' ' : content;
        await runtime.fs.writeFile(relativePath, contentToWrite);

        this.files.setKey(filePath, {
          type: 'file',
          content: content as string,
          isBinary: false,
          isLocked: false,
        });

        this.#modifiedFiles.set(filePath, content as string);
      }

      logger.info(`File created: ${filePath}`);

      return true;
    } catch (error) {
      logger.error('Failed to create file\n\n', error);
      throw error;
    }
  }

  async createFolder(folderPath: string) {
    const runtime = await this.#runtime;

    try {
      const relativePath = toRelativePath(runtime.workdir, folderPath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid folder path, create '${relativePath}'`);
      }

      await runtime.fs.mkdir(relativePath, { recursive: true });

      this.files.setKey(folderPath, { type: 'folder' });

      logger.info(`Folder created: ${folderPath}`);

      return true;
    } catch (error) {
      logger.error('Failed to create folder\n\n', error);
      throw error;
    }
  }

  async deleteFile(filePath: string) {
    const runtime = await this.#runtime;

    try {
      const relativePath = toRelativePath(runtime.workdir, filePath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid file path, delete '${relativePath}'`);
      }

      await runtime.fs.rm(relativePath);

      this.#deletedPaths.add(filePath);

      this.files.setKey(filePath, undefined);
      this.#size--;

      if (this.#modifiedFiles.has(filePath)) {
        this.#modifiedFiles.delete(filePath);
      }

      this.#persistDeletedPaths();

      logger.info(`File deleted: ${filePath}`);

      return true;
    } catch (error) {
      logger.error('Failed to delete file\n\n', error);
      throw error;
    }
  }

  async deleteFolder(folderPath: string) {
    const runtime = await this.#runtime;

    try {
      const relativePath = toRelativePath(runtime.workdir, folderPath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid folder path, delete '${relativePath}'`);
      }

      await runtime.fs.rm(relativePath, { recursive: true });

      this.#deletedPaths.add(folderPath);

      this.files.setKey(folderPath, undefined);

      const allFiles = this.files.get();

      for (const [path, dirent] of Object.entries(allFiles)) {
        if (path.startsWith(folderPath + '/')) {
          this.files.setKey(path, undefined);

          this.#deletedPaths.add(path);

          if (dirent?.type === 'file') {
            this.#size--;
          }

          if (dirent?.type === 'file' && this.#modifiedFiles.has(path)) {
            this.#modifiedFiles.delete(path);
          }
        }
      }

      this.#persistDeletedPaths();

      logger.info(`Folder deleted: ${folderPath}`);

      return true;
    } catch (error) {
      logger.error('Failed to delete folder\n\n', error);
      throw error;
    }
  }

  // method to persist deleted paths to localStorage
  #persistDeletedPaths() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('bolt-deleted-paths', JSON.stringify([...this.#deletedPaths]));
      }
    } catch (error) {
      logger.error('Failed to persist deleted paths to localStorage', error);
    }
  }
}

function isBinaryFile(buffer: Uint8Array | undefined) {
  if (buffer === undefined) {
    return false;
  }

  return getEncoding(convertToBuffer(buffer), { chunkLength: 100 }) === 'binary';
}

/**
 * Converts a `Uint8Array` into a Node.js `Buffer` by copying the prototype.
 * The goal is to  avoid expensive copies. It does create a new typed array
 * but that's generally cheap as long as it uses the same underlying
 * array buffer.
 */
function convertToBuffer(view: Uint8Array): Buffer {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}
