import { atom, computed, map, type MapStore, type ReadableAtom, type WritableAtom } from 'nanostores';
import type { EditorDocument, ScrollPosition } from '~/components/editor/codemirror/CodeMirrorEditor';
import { ActionRunner } from '~/lib/runtime/action-runner';
import type { ActionCallbackData, ArtifactCallbackData } from '~/lib/runtime/message-parser';
import { runtime } from '~/lib/runtime';
import type { ITerminal } from '~/types/terminal';
import { unreachable } from '~/utils/unreachable';
import { EditorStore } from './editor';
import { FilesStore, type FileMap } from './files';
import { PreviewsStore } from './previews';
import { TerminalStore } from './terminal';
import { autoSwitchToFileStore } from './settings';
import { stagingStore } from './staging';
import { path } from '~/utils/path';
import { createSampler } from '~/utils/sampler';
import type { ActionAlert, DeployAlert, SupabaseAlert } from '~/types/actions';
import { createScopedLogger } from '~/utils/logger';
import { pushToRepository } from '~/lib/services/repositoryPushService';
import { downloadFilesAsZip, syncFilesToDirectory } from '~/lib/utils/exportUtils';
import { streamingEventSchema } from '~/types/streaming-events';
import { processStreamEvent } from './stream-event-router';
import { structuredStreamingActive, structuredEventProcessor } from './streaming';

const logger = createScopedLogger('WorkbenchStore');

const ACTION_STREAM_SAMPLE_MS = 100;

export interface ArtifactState {
  id: string;
  title: string;
  type?: string;
  closed: boolean;
  runner: ActionRunner;

  /** When true, files are already on disk — file actions can be skipped. */
  preloaded?: boolean;
}

export type ArtifactUpdateState = Pick<ArtifactState, 'title' | 'closed'>;

type Artifacts = MapStore<Record<string, ArtifactState>>;

export type WorkbenchViewType = 'code' | 'diff' | 'preview' | 'browser' | 'versions';

export class WorkbenchStore {
  #previewsStore = new PreviewsStore(runtime);
  #filesStore = new FilesStore(runtime);
  #editorStore = new EditorStore(this.#filesStore);
  #terminalStore = new TerminalStore(runtime);

  #reloadedMessages = new Set<string>();

  artifacts: Artifacts = import.meta.hot?.data.artifacts ?? map({});

  showWorkbench: WritableAtom<boolean> = import.meta.hot?.data.showWorkbench ?? atom(false);
  currentView: WritableAtom<WorkbenchViewType> = import.meta.hot?.data.currentView ?? atom('code');
  unsavedFiles: WritableAtom<Set<string>> = import.meta.hot?.data.unsavedFiles ?? atom(new Set<string>());

  /** The width of the workbench panel in pixels. Default is 70% of viewport for more code space. */
  workbenchWidth: WritableAtom<number> =
    import.meta.hot?.data.workbenchWidth ?? atom(typeof window !== 'undefined' ? window.innerWidth * 0.7 : 1100);

  actionAlert: WritableAtom<ActionAlert | undefined> =
    import.meta.hot?.data.actionAlert ?? atom<ActionAlert | undefined>(undefined);
  supabaseAlert: WritableAtom<SupabaseAlert | undefined> =
    import.meta.hot?.data.supabaseAlert ?? atom<SupabaseAlert | undefined>(undefined);
  deployAlert: WritableAtom<DeployAlert | undefined> =
    import.meta.hot?.data.deployAlert ?? atom<DeployAlert | undefined>(undefined);

  /** Flag to indicate if we're restoring a session from snapshot */
  isRestoringSession: WritableAtom<boolean> = import.meta.hot?.data.isRestoringSession ?? atom(false);

  modifiedFiles = new Set<string>();
  artifactIdList: string[] = [];
  #globalExecutionQueue = Promise.resolve();

  /**
   * Batch counter to reduce per-action debug log spam.
   * Only the first action and every Nth action are logged individually;
   * a summary is logged when the batch flushes.
   */
  #actionLogCounter = 0;
  #actionLogBatchSize = 25;

  /**
   * Tracks the index of the last data-stream item processed by
   * processDataStreamItems() so we only handle new items on each call.
   */
  #lastProcessedDataIndex = 0;

  constructor() {
    if (import.meta.hot) {
      import.meta.hot.data.artifacts = this.artifacts;
      import.meta.hot.data.unsavedFiles = this.unsavedFiles;
      import.meta.hot.data.showWorkbench = this.showWorkbench;
      import.meta.hot.data.currentView = this.currentView;
      import.meta.hot.data.workbenchWidth = this.workbenchWidth;
      import.meta.hot.data.actionAlert = this.actionAlert;
      import.meta.hot.data.supabaseAlert = this.supabaseAlert;
      import.meta.hot.data.deployAlert = this.deployAlert;
      import.meta.hot.data.isRestoringSession = this.isRestoringSession;

      // Ensure binary files are properly preserved across hot reloads
      const filesMap = this.files.get();

      for (const [path, dirent] of Object.entries(filesMap)) {
        if (dirent?.type === 'file' && dirent.isBinary && dirent.content) {
          // Make sure binary content is preserved
          this.files.setKey(path, { ...dirent });
        }
      }
    }
  }

  addToExecutionQueue(callback: () => Promise<void>) {
    this.#globalExecutionQueue = this.#globalExecutionQueue
      .then(() => callback())
      .catch((error) => {
        // Log the error but don't break the queue - allow subsequent operations to continue
        logger.error('Execution queue error:', error);
      });
  }

  get previews() {
    return this.#previewsStore.previews;
  }

  get previewsStore(): PreviewsStore {
    return this.#previewsStore;
  }

  resetPreviews() {
    this.#previewsStore.reset();
  }

  resetArtifacts() {
    this.artifacts.set({});
    this.artifactIdList = [];
    this.#reloadedMessages.clear();
  }

  get files() {
    return this.#filesStore.files;
  }

  get currentDocument(): ReadableAtom<EditorDocument | undefined> {
    return this.#editorStore.currentDocument;
  }

  get selectedFile(): ReadableAtom<string | undefined> {
    return this.#editorStore.selectedFile;
  }

  get firstArtifact(): ArtifactState | undefined {
    return this.#getArtifact(this.artifactIdList[0]);
  }

  get filesCount(): number {
    return this.#filesStore.filesCount;
  }

  /**
   * Computed atom that only changes when the set of file paths changes,
   * not on content edits. Use this instead of subscribing to `files`
   * when you only need to know which files exist.
   */
  get fileKeys(): ReadableAtom<string[]> {
    return computed(this.files, (files) => Object.keys(files).sort());
  }

  /**
   * Whether any files exist in the project. Cheaper than subscribing
   * to the full files MapStore.
   */
  get hasFiles(): ReadableAtom<boolean> {
    return computed(this.files, (files) => Object.keys(files).length > 0);
  }

  get showTerminal() {
    return this.#terminalStore.showTerminal;
  }
  get devonzTerminal() {
    return this.#terminalStore.devonzTerminal;
  }
  get alert() {
    return this.actionAlert;
  }
  clearAlert() {
    this.actionAlert.set(undefined);
  }

  /**
   * Interrupt any running terminal process (sends Ctrl+C)
   * Useful before sending a fix request so the terminal is ready for new commands
   */
  interruptTerminal() {
    this.#terminalStore.devonzTerminal.interruptExecution();
  }

  get SupabaseAlert() {
    return this.supabaseAlert;
  }

  clearSupabaseAlert() {
    this.supabaseAlert.set(undefined);
  }

  get DeployAlert() {
    return this.deployAlert;
  }

  clearDeployAlert() {
    this.deployAlert.set(undefined);
  }

  toggleTerminal(value?: boolean) {
    this.#terminalStore.toggleTerminal(value);
  }

  attachTerminal(terminal: ITerminal) {
    this.#terminalStore.attachTerminal(terminal);
  }
  attachDevonzTerminal(terminal: ITerminal) {
    this.#terminalStore.attachDevonzTerminal(terminal);
  }

  detachTerminal(terminal: ITerminal) {
    this.#terminalStore.detachTerminal(terminal);
  }

  onTerminalResize(cols: number, rows: number) {
    this.#terminalStore.onTerminalResize(cols, rows);
  }

  setDocuments(files: FileMap) {
    this.#editorStore.setDocuments(files);

    if (this.#filesStore.filesCount > 0 && this.currentDocument.get() === undefined) {
      // we find the first file and select it
      for (const [filePath, dirent] of Object.entries(files)) {
        if (dirent?.type === 'file') {
          this.setSelectedFile(filePath);
          break;
        }
      }
    }
  }

  setShowWorkbench(show: boolean) {
    this.showWorkbench.set(show);
  }

  setWorkbenchWidth(width: number) {
    // Clamp width between min and max values (300px to 80% of viewport)
    const minWidth = 300;
    const maxWidth = typeof window !== 'undefined' ? window.innerWidth * 0.8 : 1200;
    const clampedWidth = Math.max(minWidth, Math.min(maxWidth, width));
    this.workbenchWidth.set(clampedWidth);
  }

  setCurrentDocumentContent(newContent: string) {
    const filePath = this.currentDocument.get()?.filePath;

    if (!filePath) {
      return;
    }

    const originalContent = this.#filesStore.getFile(filePath)?.content;
    const unsavedChanges = originalContent !== undefined && originalContent !== newContent;

    this.#editorStore.updateFile(filePath, newContent);

    const currentDocument = this.currentDocument.get();

    if (currentDocument) {
      const previousUnsavedFiles = this.unsavedFiles.get();

      if (unsavedChanges && previousUnsavedFiles.has(currentDocument.filePath)) {
        return;
      }

      const newUnsavedFiles = new Set(previousUnsavedFiles);

      if (unsavedChanges) {
        newUnsavedFiles.add(currentDocument.filePath);
      } else {
        newUnsavedFiles.delete(currentDocument.filePath);
      }

      this.unsavedFiles.set(newUnsavedFiles);
    }
  }

  setCurrentDocumentScrollPosition(position: ScrollPosition) {
    const editorDocument = this.currentDocument.get();

    if (!editorDocument) {
      return;
    }

    const { filePath } = editorDocument;

    this.#editorStore.updateScrollPosition(filePath, position);
  }

  setSelectedFile(filePath: string | undefined) {
    this.#editorStore.setSelectedFile(filePath);
  }

  async saveFile(filePath: string) {
    const documents = this.#editorStore.documents.get();
    const document = documents[filePath];

    if (document === undefined) {
      return;
    }

    /*
     * For scoped locks, we would need to implement diff checking here
     * to determine if the user is modifying existing code or just adding new code
     * This is a more complex feature that would be implemented in a future update
     */

    await this.#filesStore.saveFile(filePath, document.value);

    const newUnsavedFiles = new Set(this.unsavedFiles.get());
    newUnsavedFiles.delete(filePath);

    this.unsavedFiles.set(newUnsavedFiles);
  }

  async saveCurrentDocument() {
    const currentDocument = this.currentDocument.get();

    if (currentDocument === undefined) {
      return;
    }

    await this.saveFile(currentDocument.filePath);
  }

  resetCurrentDocument() {
    const currentDocument = this.currentDocument.get();

    if (currentDocument === undefined) {
      return;
    }

    const { filePath } = currentDocument;
    const file = this.#filesStore.getFile(filePath);

    if (!file) {
      return;
    }

    this.setCurrentDocumentContent(file.content);
  }

  async saveAllFiles() {
    for (const filePath of this.unsavedFiles.get()) {
      await this.saveFile(filePath);
    }
  }

  getFileModifications() {
    return this.#filesStore.getFileModifications();
  }

  getModifiedFiles() {
    return this.#filesStore.getModifiedFiles();
  }

  resetAllFileModifications() {
    this.#filesStore.resetFileModifications();
  }

  /**
   * Lock a file to prevent edits
   * @param filePath Path to the file to lock
   * @returns True if the file was successfully locked
   */
  lockFile(filePath: string) {
    return this.#filesStore.lockFile(filePath);
  }

  /**
   * Lock a folder and all its contents to prevent edits
   * @param folderPath Path to the folder to lock
   * @returns True if the folder was successfully locked
   */
  lockFolder(folderPath: string) {
    return this.#filesStore.lockFolder(folderPath);
  }

  /**
   * Unlock a file to allow edits
   * @param filePath Path to the file to unlock
   * @returns True if the file was successfully unlocked
   */
  unlockFile(filePath: string) {
    return this.#filesStore.unlockFile(filePath);
  }

  /**
   * Unlock a folder and all its contents to allow edits
   * @param folderPath Path to the folder to unlock
   * @returns True if the folder was successfully unlocked
   */
  unlockFolder(folderPath: string) {
    return this.#filesStore.unlockFolder(folderPath);
  }

  /**
   * Check if a file is locked
   * @param filePath Path to the file to check
   * @returns Object with locked status, lock mode, and what caused the lock
   */
  isFileLocked(filePath: string) {
    return this.#filesStore.isFileLocked(filePath);
  }

  /**
   * Check if a folder is locked
   * @param folderPath Path to the folder to check
   * @returns Object with locked status, lock mode, and what caused the lock
   */
  isFolderLocked(folderPath: string) {
    return this.#filesStore.isFolderLocked(folderPath);
  }

  async createFile(filePath: string, content: string | Uint8Array = '') {
    try {
      const success = await this.#filesStore.createFile(filePath, content);

      if (success) {
        this.setSelectedFile(filePath);

        /*
         * For empty files, we need to ensure they're not marked as unsaved
         * Only check for empty string, not empty Uint8Array
         */
        if (typeof content === 'string' && content === '') {
          const newUnsavedFiles = new Set(this.unsavedFiles.get());
          newUnsavedFiles.delete(filePath);
          this.unsavedFiles.set(newUnsavedFiles);
        }
      }

      return success;
    } catch (error) {
      logger.error('Failed to create file:', error);
      throw error;
    }
  }

  async createFolder(folderPath: string) {
    try {
      return await this.#filesStore.createFolder(folderPath);
    } catch (error) {
      logger.error('Failed to create folder:', error);
      throw error;
    }
  }

  async deleteFile(filePath: string) {
    try {
      const currentDocument = this.currentDocument.get();
      const isCurrentFile = currentDocument?.filePath === filePath;

      const success = await this.#filesStore.deleteFile(filePath);

      if (success) {
        const newUnsavedFiles = new Set(this.unsavedFiles.get());

        if (newUnsavedFiles.has(filePath)) {
          newUnsavedFiles.delete(filePath);
          this.unsavedFiles.set(newUnsavedFiles);
        }

        if (isCurrentFile) {
          const files = this.files.get();
          let nextFile: string | undefined = undefined;

          for (const [path, dirent] of Object.entries(files)) {
            if (dirent?.type === 'file') {
              nextFile = path;
              break;
            }
          }

          this.setSelectedFile(nextFile);
        }
      }

      return success;
    } catch (error) {
      logger.error('Failed to delete file:', error);
      throw error;
    }
  }

  async deleteFolder(folderPath: string) {
    try {
      const currentDocument = this.currentDocument.get();
      const isInCurrentFolder = currentDocument?.filePath?.startsWith(folderPath + '/');

      const success = await this.#filesStore.deleteFolder(folderPath);

      if (success) {
        const unsavedFiles = this.unsavedFiles.get();
        const newUnsavedFiles = new Set<string>();

        for (const file of unsavedFiles) {
          if (!file.startsWith(folderPath + '/')) {
            newUnsavedFiles.add(file);
          }
        }

        if (newUnsavedFiles.size !== unsavedFiles.size) {
          this.unsavedFiles.set(newUnsavedFiles);
        }

        if (isInCurrentFolder) {
          const files = this.files.get();
          let nextFile: string | undefined = undefined;

          for (const [path, dirent] of Object.entries(files)) {
            if (dirent?.type === 'file') {
              nextFile = path;
              break;
            }
          }

          this.setSelectedFile(nextFile);
        }
      }

      return success;
    } catch (error) {
      logger.error('Failed to delete folder:', error);
      throw error;
    }
  }

  abortAllActions() {
    for (const [, artifact] of Object.entries(this.artifacts.get())) {
      const actions = artifact.runner.actions.get();

      for (const [, action] of Object.entries(actions)) {
        if (action.status === 'running' || action.status === 'pending') {
          action.abort();
        }
      }
    }

    logger.info('Aborted all running/pending actions');
  }

  setReloadedMessages(messages: string[]) {
    this.#reloadedMessages = new Set(messages);
    logger.debug('Set reloaded messages:', messages.length, 'message IDs');
  }

  /**
   * Clear the reloaded messages set.
   * This should be called after initial session restore is complete
   * to ensure new messages are not treated as historical reloaded messages.
   */
  clearReloadedMessages() {
    logger.debug('Clearing reloaded messages set, was:', this.#reloadedMessages.size, 'messages');
    this.#reloadedMessages.clear();
  }

  /**
   * Check if a message ID is from the initial session restore.
   * Used to determine if actions should be skipped during restore.
   */
  isReloadedMessage(messageId: string): boolean {
    const isReloaded = this.#reloadedMessages.has(messageId);
    logger.trace('isReloadedMessage check:', messageId, '->', isReloaded);

    return isReloaded;
  }

  addArtifact({ messageId, title, id, type, preloaded }: ArtifactCallbackData) {
    logger.debug('addArtifact:', { messageId, id, title, type, preloaded });

    const artifact = this.#getArtifact(id);

    if (artifact) {
      logger.debug('Artifact already exists, skipping:', id);

      return;
    }

    if (!this.artifactIdList.includes(id)) {
      this.artifactIdList.push(id);
    }

    const runner = new ActionRunner(
      runtime,
      () => this.devonzTerminal,
      (alert) => {
        if (this.#reloadedMessages.has(messageId)) {
          return;
        }

        this.actionAlert.set(alert);
      },
      (alert) => {
        if (this.#reloadedMessages.has(messageId)) {
          return;
        }

        this.supabaseAlert.set(alert);
      },
      (alert) => {
        if (this.#reloadedMessages.has(messageId)) {
          return;
        }

        this.deployAlert.set(alert);
      },
      () => {
        this.clearAlert();
      },
      (filePath) => this.#filesStore.isUserModified(filePath),
    );

    if (preloaded) {
      runner.preloaded = true;
    }

    this.artifacts.setKey(id, {
      id,
      title,
      closed: false,
      type,
      preloaded,
      runner,
    });
  }

  updateArtifact({ artifactId }: ArtifactCallbackData, state: Partial<ArtifactUpdateState>) {
    if (!artifactId) {
      return;
    }

    const artifact = this.#getArtifact(artifactId);

    if (!artifact) {
      return;
    }

    this.artifacts.setKey(artifactId, { ...artifact, ...state });
  }

  /**
   * Finalize any actions still stuck in 'running' status across all artifacts.
   * Called when the LLM response stream ends to prevent stuck spinners.
   */
  finalizeRunningActions(): void {
    if (this.#actionLogCounter > 0) {
      logger.debug(`Batch summary: ${this.#actionLogCounter} actions processed`);
      this.#actionLogCounter = 0;
    }

    const artifacts = this.artifacts.get();

    for (const artifact of Object.values(artifacts)) {
      artifact.runner.finalizeRunningActions();
    }
  }

  addAction(data: ActionCallbackData) {
    this.#actionLogCounter++;

    // Log only the first action and every Nth to reduce console spam
    if (this.#actionLogCounter === 1 || this.#actionLogCounter % this.#actionLogBatchSize === 0) {
      logger.debug(`addAction queued (#${this.#actionLogCounter}):`, data.actionId, 'type:', data.action.type);
    }

    this.addToExecutionQueue(() => this._addAction(data));
  }

  /**
   * Restore an action from a previous session.
   * Adds it as completed for display without executing it.
   */
  restoreAction(data: ActionCallbackData) {
    const { artifactId } = data;
    const artifact = this.#getArtifact(artifactId);

    if (!artifact) {
      logger.warn('restoreAction: Artifact not found:', artifactId);
      return;
    }

    artifact.runner.restoreAction(data);
  }

  async _addAction(data: ActionCallbackData) {
    const { artifactId } = data;

    const artifact = this.#getArtifact(artifactId);

    if (!artifact) {
      logger.error('_addAction: Artifact not found:', artifactId);
      unreachable('Artifact not found');
    }

    // Only log non-file actions individually to avoid console spam
    if (data.action.type !== 'file') {
      logger.debug('_addAction:', data.actionId, 'type:', data.action.type);
    }

    return artifact.runner.addAction(data);
  }

  runAction(data: ActionCallbackData, isStreaming: boolean = false) {
    // Only log non-file actions individually to avoid console spam
    if (data.action.type !== 'file') {
      logger.debug('runAction:', {
        artifactId: data.artifactId,
        actionId: data.actionId,
        actionType: data.action.type,
        isStreaming,
      });
    }

    if (isStreaming) {
      this.actionStreamSampler(data, isStreaming);
    } else {
      this.addToExecutionQueue(() => this._runAction(data, isStreaming));
    }
  }

  async _runAction(data: ActionCallbackData, isStreaming: boolean = false) {
    const { artifactId } = data;

    const artifact = this.#getArtifact(artifactId);

    if (!artifact) {
      unreachable('Artifact not found');
    }

    const action = artifact.runner.actions.get()[data.actionId];

    if (!action || action.executed) {
      return;
    }

    if (data.action.type === 'file') {
      const rt = await runtime;
      const fullPath = path.join(rt.workdir, data.action.filePath);

      /*
       * For scoped locks, we would need to implement diff checking here
       * to determine if the AI is modifying existing code or just adding new code
       * This is a more complex feature that would be implemented in a future update
       */

      // Only auto-switch to file view if the setting is enabled
      if (autoSwitchToFileStore.get()) {
        if (this.selectedFile.value !== fullPath) {
          this.setSelectedFile(fullPath);
        }

        if (this.currentView.value !== 'code') {
          this.currentView.set('code');
        }
      }

      const doc = this.#editorStore.documents.get()[fullPath];

      if (!doc) {
        await artifact.runner.runAction(data, isStreaming);
      }

      /*
       * When staging is enabled, run the action BEFORE updating the editor so
       * that action-runner reads the true original content from the runtime
       * for accurate diffs. Updating the editor first would cause the staging
       * system to capture already-modified content as "original".
       */
      const stagingState = stagingStore.get();
      const isStagingEnabled = stagingState.settings.isEnabled;

      if (!isStreaming) {
        await artifact.runner.runAction(data);

        if (data.action.content && !isStagingEnabled) {
          this.#editorStore.updateFile(fullPath, data.action.content);
          await this.saveFile(fullPath);
        } else {
          this.#editorStore.updateFile(fullPath, data.action.content);
        }

        this.resetAllFileModifications();
      } else {
        this.#editorStore.updateFile(fullPath, data.action.content);
      }
    } else {
      await artifact.runner.runAction(data);
    }
  }

  actionStreamSampler = createSampler(async (data: ActionCallbackData, isStreaming: boolean = false) => {
    return await this._runAction(data, isStreaming);
  }, ACTION_STREAM_SAMPLE_MS);

  #getArtifact(id: string) {
    const artifacts = this.artifacts.get();
    return artifacts[id];
  }

  async downloadZip() {
    const files = this.files.get();
    await downloadFilesAsZip(files);
  }

  async syncFiles(targetHandle: FileSystemDirectoryHandle) {
    const files = this.files.get();
    return syncFilesToDirectory(files, targetHandle);
  }

  async pushToRepository(
    provider: 'github' | 'gitlab',
    repoName: string,
    commitMessage?: string,
    username?: string,
    token?: string,
    isPrivate: boolean = false,
    branchName: string = 'main',
  ) {
    const files = this.files.get();

    return pushToRepository(files, {
      provider,
      repoName,
      commitMessage,
      username,
      token,
      isPrivate,
      branchName,
    });
  }

  /**
   * Process new items from useChat's `data` channel.
   *
   * Call this whenever the `data` array from `useChat()` changes. It tracks
   * the last processed index internally so duplicate processing is avoided.
   * Each item is checked for a `devonz_event` wrapper key, validated against
   * the streamingEventSchema Zod union, and dispatched to the
   * StreamEventRouter on success.
   *
   * Invalid or unrecognized items are logged and skipped without breaking
   * the stream.
   *
   * @param data - The full `data` array returned by `useChat()`.
   */
  processDataStreamItems(data: unknown[] | undefined): void {
    if (!data || data.length === 0) {
      return;
    }

    // Only process items we haven't seen yet
    const startIndex = this.#lastProcessedDataIndex;

    if (startIndex >= data.length) {
      return;
    }

    for (let i = startIndex; i < data.length; i++) {
      const item = data[i];

      // Filter for objects containing the devonz_event wrapper key
      if (typeof item !== 'object' || item === null || !('devonz_event' in item)) {
        continue;
      }

      const wrapper = item as Record<string, unknown>;
      const rawEvent = wrapper.devonz_event;

      // Validate the event payload against the Zod schema
      const result = streamingEventSchema.safeParse(rawEvent);

      if (!result.success) {
        logger.warn('Invalid streaming event received, skipping:', result.error.message);
        continue;
      }

      processStreamEvent(result.data);

      /*
       * Forward the validated event to the message parser for Action creation.
       * The parser's processStructuredEvent handles stream_start (mode switch)
       * and file_close (Action dispatch via callbacks). The reference is held
       * in a nanostore atom to avoid a circular import with useMessageParser.
       */
      const processor = structuredEventProcessor.get();

      if (processor) {
        processor(result.data);
      }
    }

    this.#lastProcessedDataIndex = data.length;
  }

  /**
   * Reset the data stream processing index.
   * Call this when starting a new chat message / streaming session so that
   * previously processed items don't carry over.
   */
  resetDataStreamProcessing(): void {
    this.#lastProcessedDataIndex = 0;
    structuredStreamingActive.set(false);
  }
}

export const workbenchStore = new WorkbenchStore();
