import type { RuntimeProvider, DirEntry, ProcessResult } from './runtime-provider';
import { path as nodePath, toRelativePath } from '~/utils/path';
import { atom, map, type MapStore } from 'nanostores';
import type {
  ActionAlert,
  DevonzAction,
  DiffAction,
  DeployAlert,
  FileHistory,
  SupabaseAction,
  SupabaseAlert,
  PlanAction,
  TaskUpdateAction,
  PlanTaskData,
} from '~/types/actions';
import { applySearchReplaceDiff } from '~/lib/runtime/diff/apply-diff';
import { isFileLocked } from '~/lib/persistence/lockedFiles';
import { getCurrentChatId } from '~/utils/fileLocks';
import { createScopedLogger } from '~/utils/logger';
import { rewriteUnsupportedCommand } from '~/utils/command-rewriter';
import { repairMalformedCommand } from '~/utils/command-repair';
import { unreachable } from '~/utils/unreachable';
import type { ActionCallbackData } from './message-parser';
import type { DevonzShell } from '~/utils/shell';
import { setPlan, updateTaskStatus, type PlanTask } from '~/lib/stores/plan';
import {
  stagingStore,
  stageChange,
  matchesAutoApprovePattern,
  queueCommand,
  type ChangeType,
} from '~/lib/stores/staging';
import { workbenchStore } from '~/lib/stores/workbench';
import { getPreferredPackageVersion, SHADCN_PEER_DEPS } from '~/utils/dependencyCatalog';

const logger = createScopedLogger('ActionRunner');

/**
 * Debounced preview refresh — agent mode writes many files in rapid succession,
 * so we wait 1 second after the last write before refreshing the preview iframe.
 */
let _previewRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePreviewRefresh(): void {
  if (_previewRefreshTimer !== null) {
    clearTimeout(_previewRefreshTimer);
  }

  _previewRefreshTimer = setTimeout(() => {
    _previewRefreshTimer = null;
    workbenchStore.previewsStore?.refreshAllPreviews();
  }, 1000);
}

export type ActionStatus = 'pending' | 'running' | 'complete' | 'aborted' | 'failed';

export type BaseActionState = DevonzAction & {
  status: Exclude<ActionStatus, 'failed'>;
  abort: () => void;
  executed: boolean;
  abortSignal: AbortSignal;

  /** ID of the message that created this action - used for rewind on reject */
  messageId?: string;
};

export type FailedActionState = DevonzAction &
  Omit<BaseActionState, 'status'> & {
    status: Extract<ActionStatus, 'failed'>;
    error: string;
  };

export type ActionState = BaseActionState | FailedActionState;

/** Minimal input for internal file write operations (saveFileHistory, supabase migrations) */
type FileWriteInput = {
  type: 'file';
  filePath: string;
  content: string;
  messageId?: string;
};

type BaseActionUpdate = Partial<Pick<BaseActionState, 'status' | 'abort' | 'executed'>>;

export type ActionStateUpdate =
  BaseActionUpdate | (Omit<BaseActionUpdate, 'status'> & { status: 'failed'; error: string });

type ActionsMap = MapStore<Record<string, ActionState>>;

class ActionCommandError extends Error {
  readonly _output: string;
  readonly _header: string;

  constructor(message: string, output: string) {
    // Create a formatted message that includes both the error message and output
    const formattedMessage = `Failed To Execute Shell Command: ${message}\n\nOutput:\n${output}`;
    super(formattedMessage);

    // Set the output separately so it can be accessed programmatically
    this._header = message;
    this._output = output;

    // Maintain proper prototype chain
    Object.setPrototypeOf(this, ActionCommandError.prototype);

    // Set the name of the error for better debugging
    this.name = 'ActionCommandError';
  }

  // Optional: Add a method to get just the terminal output
  get output() {
    return this._output;
  }
  get header() {
    return this._header;
  }
}

export class ActionRunner {
  #runtime: Promise<RuntimeProvider>;
  #currentExecutionPromise: Promise<void> = Promise.resolve();
  #shellTerminal: () => DevonzShell;
  runnerId = atom<string>(`${Date.now()}`);
  actions: ActionsMap = map({});
  onAlert?: (alert: ActionAlert) => void;
  onClearAlert?: () => void;
  onSupabaseAlert?: (alert: SupabaseAlert) => void;
  onDeployAlert?: (alert: DeployAlert) => void;
  buildOutput?: { path: string; exitCode: number; output: string };

  /** Tracks npm install attempts per session — --legacy-peer-deps is only injected on retry (2nd+) */
  #npmInstallAttemptCount = 0;

  /** When true, file actions are skipped (files already on disk from server-side clone). */
  preloaded = false;

  constructor(
    runtimePromise: Promise<RuntimeProvider>,
    getShellTerminal: () => DevonzShell,
    onAlert?: (alert: ActionAlert) => void,
    onSupabaseAlert?: (alert: SupabaseAlert) => void,
    onDeployAlert?: (alert: DeployAlert) => void,
    onClearAlert?: () => void,
  ) {
    this.#runtime = runtimePromise;
    this.#shellTerminal = getShellTerminal;
    this.onAlert = onAlert;
    this.onClearAlert = onClearAlert;
    this.onSupabaseAlert = onSupabaseAlert;
    this.onDeployAlert = onDeployAlert;
  }

  addAction(data: ActionCallbackData) {
    const { actionId, messageId } = data;

    const actions = this.actions.get();
    const action = actions[actionId];

    if (action) {
      // action already added
      return;
    }

    const abortController = new AbortController();

    this.actions.setKey(actionId, {
      ...data.action,
      status: 'pending',
      executed: false,
      messageId, // Store messageId for rewind on reject
      abort: () => {
        abortController.abort();
        this.#updateAction(actionId, { status: 'aborted' });
      },
      abortSignal: abortController.signal,
    });

    this.#currentExecutionPromise.then(() => {
      this.#updateAction(actionId, { status: 'running' });
    });
  }

  /**
   * Add an action as already completed during session restore.
   * This shows the action in the UI with a completed status
   * without executing it (no file writes, no shell commands).
   */
  restoreAction(data: ActionCallbackData) {
    const { actionId, messageId } = data;

    const actions = this.actions.get();

    if (actions[actionId]) {
      return; // Already exists
    }

    this.actions.setKey(actionId, {
      ...data.action,
      status: data.action.type === 'start' ? 'running' : 'complete',
      executed: true,
      messageId,
      abort: () => {
        /* no-op: restored actions don't need abort */
      },
      abortSignal: new AbortController().signal,
    });
  }

  async runAction(data: ActionCallbackData, isStreaming: boolean = false) {
    const { actionId } = data;
    const action = this.actions.get()[actionId];

    if (!action) {
      unreachable(`Action ${actionId} not found`);
    }

    if (action.executed) {
      return; // No return value here
    }

    if (isStreaming && action.type !== 'file') {
      return; // No return value here
    }

    this.#updateAction(actionId, { ...action, ...data.action, executed: !isStreaming });

    this.#currentExecutionPromise = this.#currentExecutionPromise.then(async () => {
      try {
        await this.#executeAction(actionId, isStreaming);
      } catch (error) {
        logger.error('Action execution failed:', error);

        const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';

        this.onAlert?.({
          type: 'error',
          title: 'Action Failed',
          description: errorMessage,
          content: error instanceof ActionCommandError ? error.output : undefined,
        });
      }
    });

    await this.#currentExecutionPromise;

    return;
  }

  async #executeAction(actionId: string, isStreaming: boolean = false) {
    const action = this.actions.get()[actionId];

    this.#updateAction(actionId, { status: 'running' });

    try {
      switch (action.type) {
        case 'shell': {
          await this.#runShellAction(action);
          break;
        }
        case 'file': {
          await this.#runFileAction(action);
          break;
        }
        case 'diff': {
          await this.#runDiffAction(action as DiffAction & ActionState);
          break;
        }
        case 'supabase': {
          try {
            await this.handleSupabaseAction(action as SupabaseAction);
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Supabase action failed';

            // Update action status
            this.#updateAction(actionId, {
              status: 'failed',
              error: errorMessage,
            });

            // Alert the user about the Supabase failure
            this.onAlert?.({
              type: 'error',
              title: 'Supabase Action Failed',
              description: errorMessage,
            });

            // Return early without re-throwing
            return;
          }
          break;
        }
        case 'build': {
          const buildOutput = await this.#runBuildAction(action);

          // Store build output for deployment
          this.buildOutput = buildOutput;
          break;
        }
        case 'start': {
          // making the start app non blocking

          this.#runStartAction(action, actionId)
            .then(() => this.#updateAction(actionId, { status: 'complete' }))
            .catch((err: Error) => {
              if (action.abortSignal.aborted) {
                return;
              }

              this.#updateAction(actionId, { status: 'failed', error: err.message || 'Action failed' });
              logger.error(`[${action.type}]:Action failed\n\n`, err);

              // Always alert the user, not just for ActionCommandError
              this.onAlert?.({
                type: 'error',
                title: 'Dev Server Failed',
                description: err instanceof ActionCommandError ? err.header : err.message,
                content: err instanceof ActionCommandError ? err.output : undefined,
              });
            });

          /*
           * adding a delay to avoid any race condition between 2 start actions
           * i am up for a better approach
           */
          await new Promise((resolve) => setTimeout(resolve, 2000));

          return;
        }
        case 'plan': {
          // Handle plan action - parse and set up the plan
          await this.#runPlanAction(action as PlanAction);
          break;
        }
        case 'task-update': {
          // Handle task status update
          await this.#runTaskUpdateAction(action as TaskUpdateAction);
          break;
        }
      }

      this.#updateAction(actionId, {
        status: isStreaming ? 'running' : action.abortSignal.aborted ? 'aborted' : 'complete',
      });
    } catch (error) {
      if (action.abortSignal.aborted) {
        return;
      }

      const errorMessage = error instanceof Error ? error.message : 'Action failed';
      this.#updateAction(actionId, { status: 'failed', error: errorMessage });
      logger.error(`[${action.type}]:Action failed\n\n`, error);

      // Always alert the user with the actual error message
      this.onAlert?.({
        type: 'error',
        title: `${action.type.charAt(0).toUpperCase() + action.type.slice(1)} Action Failed`,
        description: error instanceof ActionCommandError ? error.header : errorMessage,
        content: error instanceof ActionCommandError ? error.output : undefined,
      });

      // re-throw the error to be caught in the promise chain
      throw error;
    }
  }

  async #runShellAction(action: ActionState) {
    if (action.type !== 'shell') {
      unreachable('Expected shell action');
    }

    // --- Step 1: Validate and transform command content before staging or execution ---

    // Reject obvious non-commands (error messages mistakenly generated as shell actions)
    if (!this.#isLikelyValidCommand(action.content)) {
      logger.warn(`Rejected invalid command (appears to be error message): ${action.content.substring(0, 80)}`);
      return;
    }

    // Rewrite unsupported runtime commands (e.g. Python → Node.js)
    const rewriteResult = rewriteUnsupportedCommand(action.content);

    if (rewriteResult.wasRewritten) {
      action.content = rewriteResult.command;
    }

    // Repair malformed commands (e.g. missing "npm" prefix, garbled output)
    const repairResult = repairMalformedCommand(action.content);

    if (repairResult.wasRepaired) {
      action.content = repairResult.command;
    }

    /*
     * Track npm install attempts; inject --legacy-peer-deps only on retry (2nd+ attempt)
     * This lets real peer dep conflicts surface first, with --legacy-peer-deps as fallback
     */
    if (/^npm\s+(install|ci)\b/.test(action.content.trim())) {
      this.#npmInstallAttemptCount++;

      if (this.#npmInstallAttemptCount > 1 && !action.content.includes('--legacy-peer-deps')) {
        action.content = action.content.trim().replace(/^(npm\s+(?:install|ci))/, '$1 --legacy-peer-deps');
        logger.info(
          `Injected --legacy-peer-deps into npm install/ci command (retry attempt ${this.#npmInstallAttemptCount})`,
        );
      }
    }

    // --- Step 2: Route to staging or direct execution ---

    // Check if staging is enabled - queue the validated/transformed command
    const stagingState = stagingStore.get();

    if (stagingState.settings.isEnabled) {
      const queued = queueCommand({
        type: 'shell',
        command: action.content,
        artifactId: 'pending-artifact',
        title: `Shell: ${action.content.substring(0, 40)}${action.content.length > 40 ? '...' : ''}`,
      });

      if (queued) {
        logger.info(`Queued shell command for staging: ${action.content.substring(0, 50)}...`);
      } else {
        logger.debug(`Skipped duplicate shell command: ${action.content.substring(0, 50)}...`);
      }

      return;
    }

    // --- Step 3: Direct execution (staging disabled) ---

    /*
     * Optimisation: Route `npm install` and `npm ci` commands through
     * runtime.exec() instead of the interactive terminal. This is more reliable
     * because it uses child_process.exec on the server — no marker-based
     * detection, no terminal contention with the dev server, and proper exit codes.
     */
    if (/^npm\s+(install|ci)\b/i.test(action.content.trim())) {
      let npmCommand = action.content.trim();

      // Inject --legacy-peer-deps only on retry (2nd+ attempt) to surface real conflicts first
      if (this.#npmInstallAttemptCount > 1 && !npmCommand.includes('--legacy-peer-deps')) {
        npmCommand += ' --legacy-peer-deps';
        logger.info(
          `Injected --legacy-peer-deps into exec npm install (retry attempt ${this.#npmInstallAttemptCount})`,
        );
      }

      logger.info(`Running npm install via runtime.exec: ${npmCommand.substring(0, 80)}`);

      const runtime = await this.#runtime;
      const result = await this.#execNpmInstall(runtime, npmCommand);

      if (result.exitCode !== 0) {
        const enhancedError = this.#createEnhancedShellError(action.content, result.exitCode, result.output);
        throw new ActionCommandError(enhancedError.title, enhancedError.details);
      }

      return;
    }

    const shell = this.#shellTerminal();
    await shell.ready();

    if (!shell || !shell.terminal || !shell.process) {
      unreachable('Shell terminal not found');
    }

    // Pre-validate command for common issues (file existence checks, etc.)
    const validationResult = await this.#validateShellCommand(action.content);

    if (validationResult.shouldModify && validationResult.modifiedCommand) {
      logger.debug(`Modified command: ${action.content} -> ${validationResult.modifiedCommand}`);
      action.content = validationResult.modifiedCommand;
    }

    // Clear stale terminal error alerts before running new command
    this.onClearAlert?.();

    const resp = await shell.executeCommand(this.runnerId.get(), action.content, () => {
      logger.debug(`[${action.type}]:Aborting Action\n\n`, action);
      action.abort();
    });
    logger.debug(`${action.type} Shell Response: [exit code:${resp?.exitCode}]`);

    if (resp?.exitCode !== 0) {
      const enhancedError = this.#createEnhancedShellError(action.content, resp?.exitCode, resp?.output);
      throw new ActionCommandError(enhancedError.title, enhancedError.details);
    }
  }

  async #runStartAction(action: ActionState, actionId: string) {
    if (action.type !== 'start') {
      unreachable('Expected shell action');
    }

    // Reject obvious non-commands (error messages mistakenly generated as start actions)
    if (!this.#isLikelyValidCommand(action.content)) {
      logger.warn(`Rejected invalid start command (appears to be error message): ${action.content.substring(0, 80)}`);
      this.#updateAction(actionId, { status: 'complete', executed: true });

      return undefined;
    }

    // Rewrite unsupported runtime commands
    const startRewrite = rewriteUnsupportedCommand(action.content);

    if (startRewrite.wasRewritten) {
      action.content = startRewrite.command;
    }

    // Check if staging is enabled - queue the validated/transformed command
    const stagingState = stagingStore.get();

    if (stagingState.settings.isEnabled) {
      const queued = queueCommand({
        type: 'start',
        command: action.content,
        artifactId: 'pending-artifact',
        title: `Start: ${action.content.substring(0, 40)}${action.content.length > 40 ? '...' : ''}`,
      });

      if (queued) {
        logger.info(`Queued start command for staging: ${action.content.substring(0, 50)}...`);
      } else {
        logger.debug(`Skipped duplicate start command: ${action.content.substring(0, 50)}...`);
      }

      this.#updateAction(actionId, { status: 'complete', executed: true });

      return undefined;
    }

    if (!this.#shellTerminal) {
      unreachable('Shell terminal not found');
    }

    /*
     * Pre-start dependency validation: Scan all source files for imported
     * npm packages and ensure they exist in package.json. This catches cases
     * where the LLM forgets to add a dependency (e.g. react-router-dom)
     * which would otherwise cause a Vite import resolution error.
     */
    await this.#validateAndInstallMissingDeps();

    /*
     * Pre-start import validator: Scan all .tsx/.jsx files for JSX component
     * references (e.g. <Card>) that are used but not imported. If found,
     * auto-inject the missing import from shadcn/ui component library.
     * This prevents ReferenceError crashes at runtime.
     */
    await this.#validateComponentImports();

    const shell = this.#shellTerminal();
    await shell.ready();

    if (!shell || !shell.terminal || !shell.process) {
      unreachable('Shell terminal not found');
    }

    // Allocate a free port for the dev server to avoid EADDRINUSE conflicts
    const runtime = await this.#runtime;
    const freePort = await runtime.allocatePort();
    const isWindows = typeof process !== 'undefined' && process.platform === 'win32';

    let commandWithPort: string;

    if (/^\s*flutter\s+run\b/.test(action.content)) {
      /*
       * Flutter ignores the PORT env var — the web port must be passed as a
       * CLI flag. Also ensure the web-server device is selected so the run
       * works headlessly and the URL is printed for port detection.
       */
      let flutterCommand = action.content.trim();

      if (!/\s-d\s|\s--device-id\b/.test(flutterCommand)) {
        flutterCommand += ' -d web-server';
      }

      if (!/--web-port\b/.test(flutterCommand)) {
        flutterCommand += ` --web-port ${freePort}`;
      }

      if (!/--web-hostname\b/.test(flutterCommand)) {
        flutterCommand += ' --web-hostname localhost';
      }

      commandWithPort = flutterCommand;
    } else {
      const portEnvPrefix = isWindows ? `set PORT=${freePort}&&` : `PORT=${freePort}`;
      commandWithPort = `${portEnvPrefix} ${action.content}`;
    }

    logger.info(`Starting dev server on allocated port ${freePort}: ${action.content}`);

    /*
     * Dev servers (npm run dev, vite, etc.) run indefinitely and never exit,
     * so shell.executeCommand() would never resolve. We race the execution
     * against a timeout — if the command hasn't exited after the timeout,
     * the server started successfully and we mark the action complete.
     * If the command exits quickly (e.g. port conflict), we catch the error.
     */
    const SERVER_READY_TIMEOUT = 5000;

    const execPromise = shell.executeCommand(this.runnerId.get(), commandWithPort, () => {
      logger.debug(`[${action.type}]:Aborting Action\n\n`, action);
      action.abort();
    });

    const timeoutPromise = new Promise<'server-running'>((resolve) =>
      setTimeout(() => resolve('server-running'), SERVER_READY_TIMEOUT),
    );

    const result = await Promise.race([execPromise, timeoutPromise]);

    if (result === 'server-running') {
      logger.debug(`${action.type}: Dev server is running (command did not exit within ${SERVER_READY_TIMEOUT}ms)`);
      this.#updateAction(actionId, { status: 'complete', executed: true });

      return undefined;
    }

    const resp = result;
    logger.debug(`${action.type} Shell Response: [exit code:${resp?.exitCode}]`);

    if (resp?.exitCode !== 0) {
      throw new ActionCommandError('Failed To Start Application', resp?.output || 'No Output Available');
    }

    return resp;
  }

  async #runDiffAction(action: DiffAction & ActionState) {
    const runtime = await this.#runtime;
    const relativePath = toRelativePath(runtime.workdir, action.filePath);

    // Check file locking before applying diff
    const chatId = getCurrentChatId();
    const lockStatus = isFileLocked(chatId, action.filePath);

    if (lockStatus.locked) {
      const lockedBy = lockStatus.lockedBy ? ` (locked by ${lockStatus.lockedBy})` : '';
      throw new Error(`Cannot apply diff to locked file: ${action.filePath}${lockedBy}`);
    }

    // Read current file content; treat missing file as empty
    let currentContent = '';

    try {
      currentContent = await runtime.fs.readFile(relativePath, 'utf-8');
    } catch {
      logger.info(`File ${relativePath} does not exist — treating as empty for diff application`);
    }

    // Apply search-replace diff blocks
    const { result, appliedCount, failedBlocks } = applySearchReplaceDiff(currentContent, action.diffBlocks);

    if (failedBlocks.length > 0) {
      const failedSummaries = failedBlocks.map(
        (block, i) => `  Block ${i + 1}: search starts with "${block.search.slice(0, 60)}..."`,
      );
      logger.warn(
        `Diff action on ${relativePath}: ${failedBlocks.length} block(s) failed to match:\n${failedSummaries.join('\n')}`,
      );
    }

    if (appliedCount === 0) {
      throw new Error(
        `Diff action failed: all ${action.diffBlocks.length} block(s) failed to match in ${action.filePath}. ` +
          `Failed blocks: ${failedBlocks.map((b) => `"${b.search.slice(0, 60)}..."`).join(', ')}`,
      );
    }

    // Ensure parent directory exists
    let folder = nodePath.dirname(relativePath);
    folder = folder.replace(/\/+$/g, '');

    if (folder !== '.') {
      try {
        await runtime.fs.mkdir(folder, { recursive: true });
      } catch (error) {
        logger.error('Failed to create folder for diff target\n\n', error);
        throw error;
      }
    }

    // Write the result back to the file
    await runtime.fs.writeFile(relativePath, result);
    logger.debug(
      `Diff applied to ${relativePath}: ${appliedCount}/${action.diffBlocks.length} blocks succeeded` +
        (failedBlocks.length > 0 ? `, ${failedBlocks.length} failed` : ''),
    );
  }

  async #runFileAction(action: ActionState | FileWriteInput) {
    if (action.type !== 'file') {
      unreachable('Expected file action');
    }

    /*
     * Fast-path for preloaded artifacts (e.g. server-side git clone).
     * Files are already on disk — skip the read+compare round-trip entirely.
     */
    if (this.preloaded) {
      logger.debug(`Preloaded artifact — skipping file action: ${action.filePath}`);
      return;
    }

    const runtime = await this.#runtime;

    /*
     * action.filePath from the AI can be:
     *   1. Already relative to workdir: "src/App.tsx"
     *   2. Absolute with workdir prefix: "/home/project/src/App.tsx"
     *
     * We need the path relative to workdir for FS operations.
     * Using nodePath.relative() on an already-relative path produces
     * a traversal (e.g. "../../src/App.tsx") which fails validation.
     */
    const relativePath = toRelativePath(runtime.workdir, action.filePath);

    // Check if staging is enabled and if this file should be staged
    const stagingState = stagingStore.get();
    const shouldStage = stagingState.settings.isEnabled && !this.#shouldAutoApprove(action.filePath);

    if (shouldStage) {
      // Read original content if file exists (for modify detection)
      let originalContent: string | null = null;
      let changeType: ChangeType = 'create';

      try {
        originalContent = await runtime.fs.readFile(relativePath, 'utf-8');
        changeType = 'modify';
      } catch {
        // File doesn't exist, this is a create
        changeType = 'create';
      }

      // Stage the change instead of writing directly
      stageChange({
        filePath: action.filePath,
        type: changeType,
        originalContent,
        newContent: action.content,
        actionId: `action-${Date.now()}`,
        messageId: action.messageId, // Pass messageId for rewind on reject
        description: `${changeType === 'create' ? 'Create' : 'Modify'} ${relativePath}`,
      });

      logger.debug(`File change staged: ${relativePath} (${changeType})`);

      return;
    }

    // Direct write path (staging disabled or auto-approved)
    await this.#writeFileDirect(action, runtime, relativePath);
  }

  /**
   * Check if a file should be auto-approved (bypass staging)
   */
  #shouldAutoApprove(filePath: string): boolean {
    const { settings } = stagingStore.get();

    if (!settings.autoApproveEnabled) {
      return false;
    }

    return matchesAutoApprovePattern(filePath, settings.autoApprovePatterns);
  }

  /**
   * Write file directly to the runtime (used when staging is bypassed)
   */
  async #writeFileDirect(action: ActionState | FileWriteInput, runtime: RuntimeProvider, relativePath: string) {
    if (action.type !== 'file') {
      unreachable('Expected file action');
    }

    let folder = nodePath.dirname(relativePath);

    // remove trailing slashes
    folder = folder.replace(/\/+$/g, '');

    if (folder !== '.') {
      try {
        await runtime.fs.mkdir(folder, { recursive: true });
        logger.debug('Created folder', folder);
      } catch (error) {
        logger.error('Failed to create folder\n\n', error);
        throw error; // Propagate so the file write doesn't proceed against missing directory
      }
    }

    try {
      let contentToWrite = action.content;

      /*
       * Safety net: Strip any leaked devonz XML tags from file content.
       * This can happen when the LLM omits closing tags and the parser's
       * streaming path accidentally includes artifact/action markup.
       */
      contentToWrite = contentToWrite.replace(/<\/?devonzArtifact[^>]*>/g, '').replace(/<\/?devonzAction[^>]*>/g, '');

      /*
       * Fast-path: If the file already exists with identical content
       * (e.g., preloaded by server-side git clone), skip the write.
       * This avoids redundant I/O for imported/cloned projects.
       */
      try {
        const existing = await runtime.fs.readFile(relativePath, 'utf-8');

        if (existing === contentToWrite) {
          logger.debug(`File unchanged, skipping write: ${relativePath}`);

          return;
        }
      } catch {
        /* File doesn't exist yet — proceed with write. */
      }

      /*
       * Safety net: When package.json is being overwritten, merge dependencies
       * from the existing file to prevent the LLM from accidentally dropping
       * critical deps (e.g. @radix-ui packages in shadcn templates).
       */
      let oldDepsSnapshot: Record<string, string> | null = null;

      if (relativePath === 'package.json') {
        // Snapshot existing deps BEFORE merge so we can detect new additions
        const pkgFileExists = await runtime.fs.exists(relativePath);

        if (pkgFileExists) {
          try {
            const existingContent = await runtime.fs.readFile(relativePath, 'utf-8');
            const existingPkg = JSON.parse(existingContent);
            oldDepsSnapshot = { ...(existingPkg.dependencies || {}), ...(existingPkg.devDependencies || {}) };
          } catch {
            // File exists but couldn't be read/parsed — continue without snapshot
          }
        }

        contentToWrite = await this.#mergePackageJsonDeps(runtime, relativePath, action.content);
      }

      await runtime.fs.writeFile(relativePath, contentToWrite);
      logger.debug(`File written ${relativePath}`);

      // Schedule a debounced preview refresh so the iframe picks up file changes
      schedulePreviewRefresh();

      /*
       * Auto-install: If package.json was written and dependencies changed,
       * automatically run `npm install` so new packages are actually available.
       * This prevents auto-fix loops where the LLM adds a dep to package.json
       * but the error persists because the package was never installed.
       */
      if (relativePath === 'package.json' && oldDepsSnapshot) {
        try {
          const newPkg = JSON.parse(contentToWrite);
          const newAllDeps = { ...(newPkg.dependencies || {}), ...(newPkg.devDependencies || {}) };

          const hasNewDeps = Object.keys(newAllDeps).some((pkg) => !oldDepsSnapshot![pkg]);

          if (hasNewDeps) {
            logger.info('package.json dependencies changed, running npm install via runtime.exec...');

            const installResult = await this.#execNpmInstall(runtime);

            if (installResult.exitCode === 0) {
              logger.info('npm install completed successfully after package.json update');
            } else {
              logger.warn('npm install exited with code', installResult.exitCode);
              logger.debug('npm install output:', installResult.output);

              this.onAlert?.({
                type: 'warning',
                title: 'Dependency Install Warning',
                description: `npm install finished with warnings (exit code ${installResult.exitCode}). Some packages may not have installed correctly.`,
              });
            }
          }
        } catch (installError) {
          logger.error('Failed to auto-install after package.json update:', installError);

          this.onAlert?.({
            type: 'warning',
            title: 'Dependency Install Failed',
            description: 'Auto npm install failed after package.json update. You may need to run npm install manually.',
          });
        }
      }
    } catch (error) {
      logger.error('Failed to write file\n\n', error);
      throw error; // Propagate so the action is marked as failed, not silently completed
    }
  }

  /**
   * Run an npm install command via the server-side runtime exec API.
   *
   * This bypasses the interactive terminal entirely, using `child_process.exec`
   * on the server. Much more reliable than the marker-based DevonzShell approach
   * because it doesn't contend with the dev-server shell session.
   *
   * Retries up to 3 times with exponential backoff (1s, 2s, 4s) on failure.
   *
   * @param runtime   The runtime provider (local or remote)
   * @param command   The npm install command to run (default: `npm install`; --legacy-peer-deps added on internal retry)
   * @param retries   Max retry attempts
   */
  async #execNpmInstall(runtime: RuntimeProvider, command = 'npm install', retries = 3): Promise<ProcessResult> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      // On internal retry (2nd+ attempt), add --legacy-peer-deps as fallback for peer dep conflicts
      let attemptCommand = command;

      if (attempt > 1 && !attemptCommand.includes('--legacy-peer-deps')) {
        attemptCommand += ' --legacy-peer-deps';
        logger.info(`Adding --legacy-peer-deps for internal retry attempt ${attempt}/${retries}`);
      }

      try {
        const result = await runtime.exec(attemptCommand);

        if (result.exitCode === 0 || attempt === retries) {
          return result;
        }

        // Non-zero exit — retry with backoff
        const delay = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s
        logger.warn(
          `npm install attempt ${attempt}/${retries} failed (exit ${result.exitCode}), retrying in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error) {
        if (attempt === retries) {
          logger.error(`npm install attempt ${attempt}/${retries} threw:`, error);

          return { exitCode: 1, output: String(error) };
        }

        const delay = 1000 * 2 ** (attempt - 1);
        logger.warn(`npm install attempt ${attempt}/${retries} threw, retrying in ${delay}ms...`, error);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Unreachable, but satisfies TypeScript
    return { exitCode: 1, output: 'All retry attempts exhausted' };
  }

  /**
   * Node.js built-in modules that should NOT be flagged as missing npm packages.
   */
  static #BUILTIN_MODULES = new Set([
    'assert',
    'async_hooks',
    'buffer',
    'child_process',
    'cluster',
    'console',
    'constants',
    'crypto',
    'dgram',
    'diagnostics_channel',
    'dns',
    'domain',
    'events',
    'fs',
    'http',
    'http2',
    'https',
    'inspector',
    'module',
    'net',
    'os',
    'path',
    'perf_hooks',
    'process',
    'punycode',
    'querystring',
    'readline',
    'repl',
    'stream',
    'string_decoder',
    'sys',
    'test',
    'timers',
    'tls',
    'trace_events',
    'tty',
    'url',
    'util',
    'v8',
    'vm',
    'wasi',
    'worker_threads',
    'zlib',
  ]);

  /**
   * Pre-start dependency validator.
   *
   * Scans all source files (.ts, .tsx, .js, .jsx) in the project
   * for npm package imports and cross-references them against the
   * dependencies listed in package.json. If any packages are imported
   * but NOT listed in package.json, they are injected and `npm install`
   * is run before the dev server starts.
   *
   * This is a critical safety net that catches cases where the LLM
   * forgets to add a dependency (e.g. react-router-dom, lucide-react)
   * which would otherwise cause a Vite import resolution error at runtime.
   */
  async #validateAndInstallMissingDeps(): Promise<void> {
    try {
      const runtime = await this.#runtime;

      // Step 1: Read and parse package.json (check existence first to avoid 404 console noise)
      const pkgExists = await runtime.fs.exists('package.json');

      if (!pkgExists) {
        logger.debug('No package.json found, skipping dependency validation');
        return;
      }

      let pkgContent: string;

      try {
        pkgContent = await runtime.fs.readFile('package.json', 'utf-8');
      } catch {
        logger.debug('Failed to read package.json, skipping dependency validation');
        return;
      }

      let pkgJson: Record<string, unknown>;

      try {
        pkgJson = JSON.parse(pkgContent);
      } catch {
        logger.warn('Failed to parse package.json, skipping dependency validation');
        return;
      }

      const allDeps: Record<string, string> = {
        ...((pkgJson.dependencies as Record<string, string>) || {}),
        ...((pkgJson.devDependencies as Record<string, string>) || {}),
      };

      // Step 2: Recursively scan source files for imports
      const missingPackages = new Set<string>();
      const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.svelte', '.vue', '.astro'];

      /*
       * Regex patterns for extracting npm package imports:
       * - import ... from 'package'
       * - import 'package'
       * - require('package')
       * - export ... from 'package'
       * Excludes relative (./  ../) and absolute (/) imports.
       */
      const importRegex =
        /(?:import\s+(?:[\s\S]*?\s+from\s+)?|require\s*\(\s*|export\s+[\s\S]*?\s+from\s+)['"]([^'"./][^'"]*)['"]/g;

      const scanDirectory = async (dirPath: string, depth: number = 0): Promise<void> => {
        // Safety: limit recursion depth to prevent runaway scanning
        if (depth > 8) {
          return;
        }

        let entries: DirEntry[];

        try {
          entries = await runtime.fs.readdir(dirPath);
        } catch {
          return; // Directory doesn't exist or can't be read
        }

        for (const entry of entries) {
          const fullPath = dirPath === '.' ? entry.name : `${dirPath}/${entry.name}`;

          if (entry.isDirectory) {
            // Skip directories that never contain project source
            const skipDirs = ['node_modules', '.git', 'dist', 'build', '.next', '.cache', '.vite', 'coverage'];

            if (!skipDirs.includes(entry.name)) {
              await scanDirectory(fullPath, depth + 1);
            }
          } else if (sourceExtensions.some((ext) => entry.name.endsWith(ext))) {
            try {
              const content = await runtime.fs.readFile(fullPath, 'utf-8');
              let match;

              // Reset lastIndex for each file
              importRegex.lastIndex = 0;

              while ((match = importRegex.exec(content)) !== null) {
                const importPath = match[1];

                // Skip path aliases (e.g. @/lib/utils, ~/utils, #/types)
                if (importPath.match(/^[@~#]\//)) {
                  continue;
                }

                // Skip Node.js built-in imports with node: prefix (e.g. 'node:fs')
                if (importPath.startsWith('node:')) {
                  continue;
                }

                // Extract the package name (handle scoped packages like @radix-ui/react-dialog)
                const pkgName = importPath
                  .split('/')
                  .slice(0, importPath.startsWith('@') ? 2 : 1)
                  .join('/');

                // Skip built-in Node.js modules and already-listed packages
                if (!allDeps[pkgName] && !ActionRunner.#BUILTIN_MODULES.has(pkgName)) {
                  missingPackages.add(pkgName);
                }
              }
            } catch {
              // Skip unreadable files
            }
          }
        }
      };

      // Scan common project source directories
      await scanDirectory('src');
      await scanDirectory('app');
      await scanDirectory('pages');
      await scanDirectory('components');
      await scanDirectory('lib');
      await scanDirectory('utils');
      await scanDirectory('routes');
      await scanDirectory('views');
      await scanDirectory('layouts');
      await scanDirectory('stores');

      // Also scan root-level source files (e.g. vite.config.ts, tailwind.config.ts)
      try {
        const rootEntries = await runtime.fs.readdir('.');

        for (const entry of rootEntries) {
          if (!entry.isDirectory && sourceExtensions.some((ext) => entry.name.endsWith(ext))) {
            try {
              const content = await runtime.fs.readFile(entry.name, 'utf-8');
              let match;
              importRegex.lastIndex = 0;

              while ((match = importRegex.exec(content)) !== null) {
                const importPath = match[1];

                // Skip path aliases (e.g. @/lib/utils, ~/utils, #/types)
                if (importPath.match(/^[@~#]\//)) {
                  continue;
                }

                // Skip Node.js built-in imports with node: prefix (e.g. 'node:fs')
                if (importPath.startsWith('node:')) {
                  continue;
                }

                const pkgName = importPath
                  .split('/')
                  .slice(0, importPath.startsWith('@') ? 2 : 1)
                  .join('/');

                if (!allDeps[pkgName] && !ActionRunner.#BUILTIN_MODULES.has(pkgName)) {
                  missingPackages.add(pkgName);
                }
              }
            } catch {
              // Skip unreadable files
            }
          }
        }
      } catch {
        // Root dir read failed
      }

      // Step 3: If missing packages found, categorize and selectively inject
      if (missingPackages.size > 0) {
        const missing = [...missingPackages];
        const shadcnInstallable: Array<{ name: string; version: string }> = [];
        const catalogSkipped: string[] = [];
        const unverified: string[] = [];

        for (const pkg of missing) {
          const shadcnVersion = SHADCN_PEER_DEPS[pkg];

          if (shadcnVersion) {
            // Package is in shadcn peer deps — safe to auto-inject
            shadcnInstallable.push({ name: pkg, version: shadcnVersion });
          } else if (getPreferredPackageVersion(pkg)) {
            // Package is in the catalog but NOT shadcn peer deps — warn only, don't inject
            catalogSkipped.push(pkg);
          } else {
            // Package is not in any catalog — warn only, don't inject
            unverified.push(pkg);
          }
        }

        logger.info(`Dependency validator found ${missing.length} missing package(s): ${missing.join(', ')}`);

        if (shadcnInstallable.length > 0) {
          for (const { name, version } of shadcnInstallable) {
            logger.info(`Auto-injecting shadcn peer dependency: ${name}@${version}`);
          }
        }

        if (catalogSkipped.length > 0) {
          logger.warn(
            `Found ${catalogSkipped.length} non-shadcn package(s) in imports but not in package.json: ${catalogSkipped.join(', ')}. ` +
              `Not auto-injecting — let the AI handle adding these dependencies.`,
          );
        }

        if (unverified.length > 0) {
          logger.warn(
            `Found ${unverified.length} unknown package(s) in imports: ${unverified.join(', ')}. ` +
              `Not auto-injecting — package may be hallucinated or outdated. Let the AI correct the import.`,
          );
        }

        if (shadcnInstallable.length === 0) {
          return;
        }

        const deps = (pkgJson.dependencies as Record<string, string>) || {};

        for (const { name, version } of shadcnInstallable) {
          deps[name] = version;
        }

        pkgJson.dependencies = deps;

        await runtime.fs.writeFile('package.json', JSON.stringify(pkgJson, null, 2));
        logger.info(`Updated package.json with ${shadcnInstallable.length} shadcn peer dependency/ies`);

        // Run npm install via runtime.exec — bypasses the terminal for reliability
        const installResult = await this.#execNpmInstall(runtime);

        if (installResult.exitCode === 0) {
          logger.info('npm install completed successfully after dependency validation');
        } else {
          logger.warn('npm install had non-zero exit code after dependency validation:', installResult.exitCode);
          logger.debug('npm install output:', installResult.output);
        }
      } else {
        logger.debug('Dependency validation passed: all imported packages are in package.json');
      }
    } catch (error) {
      // Non-fatal: log and continue — the dev server will surface the real error
      logger.error('Dependency validation failed (non-fatal):', error);
    }
  }

  /**
   * Pre-start import validator.
   *
   * Scans all generated .tsx files for JSX component references (e.g. <Card>)
   * that are used but NOT imported. If found, auto-injects the missing import
   * statement from the shadcn/ui component library (@/components/ui/).
   *
   * This prevents runtime ReferenceErrors like "Card is not defined" that
   * occur when the LLM forgets to import a component it uses in JSX.
   */
  async #validateComponentImports(): Promise<void> {
    try {
      const runtime = await this.#runtime;

      // Common shadcn/ui components and their import paths
      const SHADCN_COMPONENTS: Record<string, string[]> = {
        '@/components/ui/card': ['Card', 'CardHeader', 'CardTitle', 'CardDescription', 'CardContent', 'CardFooter'],
        '@/components/ui/button': ['Button'],
        '@/components/ui/input': ['Input'],
        '@/components/ui/label': ['Label'],
        '@/components/ui/badge': ['Badge'],
        '@/components/ui/select': [
          'Select',
          'SelectContent',
          'SelectItem',
          'SelectTrigger',
          'SelectValue',
          'SelectGroup',
        ],
        '@/components/ui/dialog': [
          'Dialog',
          'DialogContent',
          'DialogDescription',
          'DialogFooter',
          'DialogHeader',
          'DialogTitle',
          'DialogTrigger',
        ],
        '@/components/ui/table': ['Table', 'TableBody', 'TableCell', 'TableHead', 'TableHeader', 'TableRow'],
        '@/components/ui/tabs': ['Tabs', 'TabsContent', 'TabsList', 'TabsTrigger'],
        '@/components/ui/avatar': ['Avatar', 'AvatarFallback', 'AvatarImage'],
        '@/components/ui/dropdown-menu': [
          'DropdownMenu',
          'DropdownMenuContent',
          'DropdownMenuItem',
          'DropdownMenuTrigger',
          'DropdownMenuSeparator',
          'DropdownMenuLabel',
        ],
        '@/components/ui/sheet': [
          'Sheet',
          'SheetContent',
          'SheetDescription',
          'SheetHeader',
          'SheetTitle',
          'SheetTrigger',
        ],
        '@/components/ui/toast': ['Toast', 'ToastAction'],
        '@/components/ui/separator': ['Separator'],
        '@/components/ui/scroll-area': ['ScrollArea', 'ScrollBar'],
        '@/components/ui/skeleton': ['Skeleton'],
        '@/components/ui/switch': ['Switch'],
        '@/components/ui/textarea': ['Textarea'],
        '@/components/ui/progress': ['Progress'],
        '@/components/ui/tooltip': ['Tooltip', 'TooltipContent', 'TooltipProvider', 'TooltipTrigger'],
        '@/components/ui/chart': [
          'ChartContainer',
          'ChartTooltip',
          'ChartTooltipContent',
          'ChartLegend',
          'ChartLegendContent',
        ],
        '@/components/ui/form': [
          'Form',
          'FormControl',
          'FormDescription',
          'FormField',
          'FormItem',
          'FormLabel',
          'FormMessage',
        ],
        '@/components/ui/checkbox': ['Checkbox'],
        '@/components/ui/radio-group': ['RadioGroup', 'RadioGroupItem'],
        '@/components/ui/slider': ['Slider'],
        '@/components/ui/popover': ['Popover', 'PopoverContent', 'PopoverTrigger'],
        '@/components/ui/alert': ['Alert', 'AlertDescription', 'AlertTitle'],
        '@/components/ui/navigation-menu': [
          'NavigationMenu',
          'NavigationMenuContent',
          'NavigationMenuItem',
          'NavigationMenuLink',
          'NavigationMenuList',
          'NavigationMenuTrigger',
        ],
      };

      // Build reverse lookup: component name → import path
      const componentToPath: Record<string, string> = {};

      for (const [importPath, components] of Object.entries(SHADCN_COMPONENTS)) {
        for (const comp of components) {
          componentToPath[comp] = importPath;
        }
      }

      const sourceExtensions = ['.tsx', '.jsx'];

      const scanAndFix = async (dirPath: string, depth: number = 0): Promise<void> => {
        if (depth > 8) {
          return;
        }

        let entries: DirEntry[];

        try {
          entries = await runtime.fs.readdir(dirPath);
        } catch {
          return;
        }

        for (const entry of entries) {
          const fullPath = dirPath === '.' ? entry.name : `${dirPath}/${entry.name}`;

          if (entry.isDirectory) {
            const skipDirs = ['node_modules', '.git', 'dist', 'build', '.next', '.cache', '.vite', 'coverage'];

            if (!skipDirs.includes(entry.name)) {
              await scanAndFix(fullPath, depth + 1);
            }
          } else if (sourceExtensions.some((ext) => entry.name.endsWith(ext))) {
            try {
              let content = await runtime.fs.readFile(fullPath, 'utf-8');

              // Extract all existing imports (what's already imported)
              const importedNames = new Set<string>();
              const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g;
              const defaultImportRegex = /import\s+(\w+)\s+from\s+['"][^'"]+['"]/g;
              let m;

              while ((m = importRegex.exec(content)) !== null) {
                m[1].split(',').forEach((name) => {
                  const trimmed = name
                    .trim()
                    .split(/\s+as\s+/)[0]
                    .trim();

                  if (trimmed) {
                    importedNames.add(trimmed);
                  }
                });
              }

              while ((m = defaultImportRegex.exec(content)) !== null) {
                importedNames.add(m[1]);
              }

              // Also count function/const declarations (locally defined components)
              const declRegex = /(?:function|const|class|let|var)\s+(\w+)/g;

              while ((m = declRegex.exec(content)) !== null) {
                importedNames.add(m[1]);
              }

              // Find JSX component usage: <ComponentName or <ComponentName.Sub
              const jsxRegex = /<([A-Z][a-zA-Z0-9]*)\b/g;
              const usedComponents = new Set<string>();

              while ((m = jsxRegex.exec(content)) !== null) {
                const compName = m[1];

                if (!importedNames.has(compName) && componentToPath[compName]) {
                  usedComponents.add(compName);
                }
              }

              if (usedComponents.size > 0) {
                // Group by import path
                const importsByPath: Record<string, string[]> = {};

                for (const comp of usedComponents) {
                  const path = componentToPath[comp];

                  if (!importsByPath[path]) {
                    importsByPath[path] = [];
                  }

                  importsByPath[path].push(comp);
                }

                // Build import statements
                const newImports: string[] = [];

                for (const [path, comps] of Object.entries(importsByPath)) {
                  // Check if there's already an import from this path that we can extend
                  const existingImportRegex = new RegExp(
                    `import\\s+\\{([^}]+)\\}\\s+from\\s+['"]${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
                  );
                  const existingMatch = content.match(existingImportRegex);

                  if (existingMatch) {
                    // Extend existing import
                    const existingComps = existingMatch[1]
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean);
                    const allComps = [...new Set([...existingComps, ...comps])].sort();
                    const newImportLine = `import { ${allComps.join(', ')} } from '${path}'`;
                    content = content.replace(existingMatch[0], newImportLine);
                  } else {
                    newImports.push(`import { ${comps.sort().join(', ')} } from '${path}'`);
                  }
                }

                if (newImports.length > 0) {
                  /*
                   * Find the insertion point after the LAST import statement.
                   * Uses `from '...'` line endings to handle both single-line
                   * and multi-line imports (e.g. `import {\n  A,\n  B\n} from 'x'`).
                   */
                  const fromImportEnd = /from\s+['"][^'"]+['"]\s*;?\s*$/gm;
                  const sideEffectImport = /^import\s+['"][^'"]+['"]\s*;?\s*$/gm;
                  let lastImportEnd = -1;
                  let regMatch;

                  while ((regMatch = fromImportEnd.exec(content)) !== null) {
                    lastImportEnd = Math.max(lastImportEnd, regMatch.index + regMatch[0].length);
                  }

                  while ((regMatch = sideEffectImport.exec(content)) !== null) {
                    lastImportEnd = Math.max(lastImportEnd, regMatch.index + regMatch[0].length);
                  }

                  if (lastImportEnd > -1) {
                    content =
                      content.slice(0, lastImportEnd) + '\n' + newImports.join('\n') + content.slice(lastImportEnd);
                  } else {
                    // No existing imports — add at top
                    content = newImports.join('\n') + '\n\n' + content;
                  }
                }

                await runtime.fs.writeFile(fullPath, content);
                logger.info(
                  `Import validator: Auto-injected ${usedComponents.size} missing import(s) in ${fullPath}: ${[...usedComponents].join(', ')}`,
                );
              }
            } catch {
              // Skip unreadable files
            }
          }
        }
      };

      // Scan common project source directories
      await scanAndFix('src');
      await scanAndFix('app');
      await scanAndFix('pages');
      await scanAndFix('components');
      await scanAndFix('routes');
      await scanAndFix('lib');
      await scanAndFix('utils');

      logger.debug('Component import validation complete');
    } catch (error) {
      // Non-fatal: log and continue
      logger.error('Component import validation failed (non-fatal):', error);
    }
  }

  /**
   * Merge dependencies from an existing package.json into a new one.
   * Preserves all existing dependencies while allowing new ones to be added.
   * This prevents the LLM from accidentally dropping template dependencies
   * when it rewrites package.json from scratch.
   */
  async #mergePackageJsonDeps(runtime: RuntimeProvider, relativePath: string, newContent: string): Promise<string> {
    try {
      // Check existence first to avoid 404 console noise on first write
      const fileExists = await runtime.fs.exists(relativePath);

      if (!fileExists) {
        return newContent;
      }

      const existingContent = await runtime.fs.readFile(relativePath, 'utf-8');
      const existingPkg = JSON.parse(existingContent);
      const newPkg = JSON.parse(newContent);

      const existingDeps = existingPkg.dependencies || {};
      const existingDevDeps = existingPkg.devDependencies || {};
      const newDeps = newPkg.dependencies || {};
      const newDevDeps = newPkg.devDependencies || {};

      // Count how many existing deps are missing from the new package.json
      const missingDeps: Record<string, string> = {};

      for (const [pkg, version] of Object.entries(existingDeps)) {
        if (!newDeps[pkg]) {
          missingDeps[pkg] = version as string;
        }
      }

      const missingDevDeps: Record<string, string> = {};

      for (const [pkg, version] of Object.entries(existingDevDeps)) {
        if (!newDevDeps[pkg]) {
          missingDevDeps[pkg] = version as string;
        }
      }

      const missingCount = Object.keys(missingDeps).length;
      const missingDevCount = Object.keys(missingDevDeps).length;
      const existingCount = Object.keys(existingDeps).length;
      const existingDevCount = Object.keys(existingDevDeps).length;

      /*
       * Only merge if a majority of deps were dropped (> 50%), suggesting the AI
       * rewrote package.json from scratch (formatting issue) rather than intentionally
       * removing specific packages. If <= 50% were dropped, respect the AI's choices.
       * Apply the threshold independently to deps and devDeps.
       */
      let merged = false;

      if (existingCount > 0 && missingCount / existingCount > 0.5) {
        newPkg.dependencies = { ...missingDeps, ...newDeps };
        logger.info(
          `Merged ${missingCount} missing dependencies back into package.json (${Math.round((missingCount / existingCount) * 100)}% dropped — likely formatting issue, not intentional removal)`,
        );
        merged = true;
      } else if (missingCount > 0) {
        logger.info(
          `Respecting AI's removal of ${missingCount} dependency/ies from package.json (${Math.round((missingCount / existingCount) * 100)}% dropped — appears intentional)`,
        );
      }

      if (existingDevCount > 0 && missingDevCount / existingDevCount > 0.5) {
        newPkg.devDependencies = { ...missingDevDeps, ...newDevDeps };
        logger.info(
          `Merged ${missingDevCount} missing devDependencies back into package.json (${Math.round((missingDevCount / existingDevCount) * 100)}% dropped — likely formatting issue, not intentional removal)`,
        );
        merged = true;
      } else if (missingDevCount > 0) {
        logger.info(
          `Respecting AI's removal of ${missingDevCount} devDependency/ies from package.json (${Math.round((missingDevCount / existingDevCount) * 100)}% dropped — appears intentional)`,
        );
      }

      if (merged) {
        return JSON.stringify(newPkg, null, 2);
      }
    } catch (error) {
      /*
       * File doesn't exist yet — use new content as-is.
       * Warn if it's a parse error (not a file-not-found).
       */
      if (error instanceof SyntaxError) {
        logger.warn('Failed to parse existing package.json during merge — using new content as-is:', error.message);
      }
    }

    return newContent;
  }

  /**
   * Apply a staged change (called when user accepts)
   * This is a public method that can be called from outside
   */
  async applyAcceptedChange(filePath: string, content: string): Promise<boolean> {
    try {
      const runtime = await this.#runtime;
      const relativePath = toRelativePath(runtime.workdir, filePath);

      let folder = nodePath.dirname(relativePath);
      folder = folder.replace(/\/+$/g, '');

      if (folder !== '.') {
        await runtime.fs.mkdir(folder, { recursive: true });
      }

      await runtime.fs.writeFile(relativePath, content);
      logger.info(`Accepted change applied: ${relativePath}`);

      return true;
    } catch (error) {
      logger.error(`Failed to apply accepted change: ${filePath}`, error);

      return false;
    }
  }

  /**
   * Delete a file (for staged deletions)
   */
  async deleteFile(filePath: string): Promise<boolean> {
    try {
      const runtime = await this.#runtime;
      const relativePath = toRelativePath(runtime.workdir, filePath);

      await runtime.fs.rm(relativePath);
      logger.info(`File deleted: ${relativePath}`);

      return true;
    } catch (error) {
      logger.error(`Failed to delete file: ${filePath}`, error);

      return false;
    }
  }

  /**
   * Transition all actions still in 'running' status to 'complete'.
   * Called when the LLM response stream ends to ensure no actions are
   * stuck with a spinner (e.g. due to a truncated closing tag).
   * 'start' actions are excluded — they legitimately run indefinitely.
   */
  finalizeRunningActions(): void {
    const actions = this.actions.get();

    for (const [id, action] of Object.entries(actions)) {
      if (action.status === 'running' && action.type !== 'start') {
        logger.debug(`Finalizing stuck action: ${id} (type: ${action.type})`);
        this.actions.setKey(id, { ...action, status: 'complete', executed: true });
      }
    }
  }

  #updateAction(id: string, newState: ActionStateUpdate) {
    const actions = this.actions.get();

    this.actions.setKey(id, { ...actions[id], ...newState });
  }

  async getFileHistory(filePath: string): Promise<FileHistory | null> {
    try {
      const runtime = await this.#runtime;
      const historyPath = this.#getHistoryPath(filePath);
      const content = await runtime.fs.readFile(historyPath, 'utf-8');

      return JSON.parse(content);
    } catch (error) {
      logger.error('Failed to get file history:', error);
      return null;
    }
  }

  async saveFileHistory(filePath: string, history: FileHistory) {
    // const runtime = await this.#runtime;
    const historyPath = this.#getHistoryPath(filePath);

    await this.#runFileAction({
      type: 'file',
      filePath: historyPath,
      content: JSON.stringify(history),
    });
  }

  #getHistoryPath(filePath: string) {
    return nodePath.join('.history', filePath);
  }

  async #runBuildAction(action: ActionState) {
    if (action.type !== 'build') {
      unreachable('Expected build action');
    }

    // Trigger build started alert
    this.onDeployAlert?.({
      type: 'info',
      title: 'Building Application',
      description: 'Building your application...',
      stage: 'building',
      buildStatus: 'running',
      deployStatus: 'pending',
      source: 'netlify',
    });

    const runtime = await this.#runtime;

    /*
     * Spawn the build command via the runtime provider.
     * RuntimeProvider.spawn returns a SpawnedProcess with onData/onExit
     * instead of WebContainer's ReadableStream-based .output/.exit pattern.
     */
    const buildProcess = await runtime.spawn('npm', ['run', 'build']);

    let output = '';
    const disposeData = buildProcess.onData((data) => {
      output += data;
    });

    const exitCode = await buildProcess.onExit;
    disposeData();

    let buildDir = '';

    if (exitCode !== 0) {
      const buildResult = {
        path: buildDir,
        exitCode,
        output,
      };

      this.buildOutput = buildResult;

      // Trigger build failed alert
      this.onDeployAlert?.({
        type: 'error',
        title: 'Build Failed',
        description: 'Your application build failed',
        content: output || 'No build output available',
        stage: 'building',
        buildStatus: 'failed',
        deployStatus: 'pending',
        source: 'netlify',
      });

      throw new ActionCommandError('Build Failed', output || 'No Output Available');
    }

    // Trigger build success alert
    this.onDeployAlert?.({
      type: 'success',
      title: 'Build Completed',
      description: 'Your application was built successfully',
      stage: 'deploying',
      buildStatus: 'complete',
      deployStatus: 'running',
      source: 'netlify',
    });

    // Check for common build directories
    const commonBuildDirs = ['dist', 'build', 'out', 'output', '.next', 'public'];

    // Try to find the first existing build directory
    for (const dir of commonBuildDirs) {
      const dirPath = nodePath.join(runtime.workdir, dir);

      try {
        await runtime.fs.readdir(dirPath);
        buildDir = dirPath;
        break;
      } catch {
        continue;
      }
    }

    // If no build directory was found, use the default (dist)
    if (!buildDir) {
      buildDir = nodePath.join(runtime.workdir, 'dist');
    }

    return {
      path: buildDir,
      exitCode,
      output,
    };
  }
  async handleSupabaseAction(action: SupabaseAction) {
    const { operation, content, filePath } = action;
    logger.debug('[Supabase Action]:', { operation, filePath, content });

    switch (operation) {
      case 'migration':
        if (!filePath) {
          throw new Error('Migration requires a filePath');
        }

        // Show alert for migration action
        this.onSupabaseAlert?.({
          type: 'info',
          title: 'Supabase Migration',
          description: `Create migration file: ${filePath}`,
          content,
          source: 'supabase',
        });

        // Only create the migration file
        await this.#runFileAction({
          type: 'file',
          filePath,
          content,
        });
        return { success: true };

      case 'query': {
        // Always show the alert and let the SupabaseAlert component handle connection state
        this.onSupabaseAlert?.({
          type: 'info',
          title: 'Supabase Query',
          description: 'Execute database query',
          content,
          source: 'supabase',
        });

        // The actual execution will be triggered from SupabaseChatAlert
        return { pending: true };
      }

      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }

  // Add this method declaration to the class
  handleDeployAction(
    stage: 'building' | 'deploying' | 'complete',
    status: ActionStatus,
    details?: {
      url?: string;
      error?: string;
      source?: 'netlify' | 'vercel' | 'github' | 'gitlab';
    },
  ): void {
    if (!this.onDeployAlert) {
      logger.debug('No deploy alert handler registered');
      return;
    }

    const alertType = status === 'failed' ? 'error' : status === 'complete' ? 'success' : 'info';

    const title =
      stage === 'building'
        ? 'Building Application'
        : stage === 'deploying'
          ? 'Deploying Application'
          : 'Deployment Complete';

    const description =
      status === 'failed'
        ? `${stage === 'building' ? 'Build' : 'Deployment'} failed`
        : status === 'running'
          ? `${stage === 'building' ? 'Building' : 'Deploying'} your application...`
          : status === 'complete'
            ? `${stage === 'building' ? 'Build' : 'Deployment'} completed successfully`
            : `Preparing to ${stage === 'building' ? 'build' : 'deploy'} your application`;

    type DeployStatusValue = NonNullable<DeployAlert['buildStatus']>;

    const buildStatus: DeployStatusValue =
      stage === 'building'
        ? status === 'aborted'
          ? 'failed'
          : status
        : stage === 'deploying' || stage === 'complete'
          ? 'complete'
          : 'pending';

    const deployStatus: DeployStatusValue = stage === 'building' ? 'pending' : status === 'aborted' ? 'failed' : status;

    this.onDeployAlert({
      type: alertType,
      title,
      description,
      content: details?.error || '',
      url: details?.url,
      stage,
      buildStatus,
      deployStatus,
      source: details?.source || 'netlify',
    });
  }

  /**
   * Check if a command string looks like a valid shell command rather than
   * an error message or arbitrary text that was mistakenly generated as a shell action.
   * This prevents error messages from being queued/executed as commands.
   */
  #isLikelyValidCommand(command: string): boolean {
    const trimmed = command.trim();

    if (!trimmed) {
      return false;
    }

    // Get the first word (before any space, semicolon, pipe, or ampersand)
    const firstWord = trimmed.split(/[\s;|&]/)[0].toLowerCase();

    // Common error message starters that are NOT valid shell commands
    const errorIndicators = [
      'cannot',
      'error',
      'failed',
      'unable',
      'could',
      'module',
      'import',
      'warning',
      'the',
      'an',
      'no',
      'this',
      'it',
      'there',
      'note',
      'does',
      'is',
      'was',
      'are',
      'has',
      'have',
      'not',
      'undefined',
      'null',
      'expected',
      'unexpected',
      'missing',
      'invalid',
      'unknown',
      'uncaught',
      'typeerror',
      'syntaxerror',
      'referenceerror',
      'rangeerror',
    ];

    if (errorIndicators.includes(firstWord)) {
      return false;
    }

    // Reject if the text starts with common error bracket patterns
    if (/^\[(?:error|warn|plugin|vite|hmr)\b/i.test(trimmed)) {
      return false;
    }

    return true;
  }

  async #validateShellCommand(command: string): Promise<{
    shouldModify: boolean;
    modifiedCommand?: string;
    warning?: string;
  }> {
    const trimmedCommand = command.trim();

    // Handle rm commands that might fail due to missing files
    if (trimmedCommand.startsWith('rm ') && !trimmedCommand.includes(' -f')) {
      const rmMatch = trimmedCommand.match(/^rm\s+(.+)$/);

      if (rmMatch) {
        const filePaths = rmMatch[1].split(/\s+/);

        // Check if any of the files exist using the runtime
        try {
          const runtime = await this.#runtime;
          const existingFiles = [];

          for (const filePath of filePaths) {
            if (filePath.startsWith('-')) {
              continue;
            } // Skip flags

            try {
              await runtime.fs.readFile(filePath);
              existingFiles.push(filePath);
            } catch {
              // File doesn't exist, skip it
            }
          }

          if (existingFiles.length === 0) {
            // No files exist, modify command to use -f flag to avoid error
            return {
              shouldModify: true,
              modifiedCommand: `rm -f ${filePaths.join(' ')}`,
              warning: 'Added -f flag to rm command as target files do not exist',
            };
          } else if (existingFiles.length < filePaths.length) {
            // Some files don't exist, modify to only remove existing ones with -f for safety
            return {
              shouldModify: true,
              modifiedCommand: `rm -f ${filePaths.join(' ')}`,
              warning: 'Added -f flag to rm command as some target files do not exist',
            };
          }
        } catch (error) {
          logger.debug('Could not validate rm command files:', error);
        }
      }
    }

    // Handle cd commands to non-existent directories
    if (trimmedCommand.startsWith('cd ')) {
      const cdMatch = trimmedCommand.match(/^cd\s+(.+)$/);

      if (cdMatch) {
        const targetDir = cdMatch[1].trim();

        try {
          const runtime = await this.#runtime;
          await runtime.fs.readdir(targetDir);
        } catch {
          return {
            shouldModify: true,
            modifiedCommand: `mkdir -p ${targetDir} && cd ${targetDir}`,
            warning: 'Directory does not exist, created it first',
          };
        }
      }
    }

    // Handle cp/mv commands with missing source files
    if (trimmedCommand.match(/^(cp|mv)\s+/)) {
      const parts = trimmedCommand.split(/\s+/);

      if (parts.length >= 3) {
        const sourceFile = parts[1];

        try {
          const runtime = await this.#runtime;
          await runtime.fs.readFile(sourceFile);
        } catch {
          return {
            shouldModify: false,
            warning: `Source file '${sourceFile}' does not exist`,
          };
        }
      }
    }

    return { shouldModify: false };
  }

  #createEnhancedShellError(
    command: string,
    exitCode: number | undefined,
    output: string | undefined,
  ): {
    title: string;
    details: string;
  } {
    const trimmedCommand = command.trim();
    const firstWord = trimmedCommand.split(/\s+/)[0];

    // Common error patterns and their explanations
    const errorPatterns = [
      {
        pattern: /cannot remove.*No such file or directory/,
        title: 'File Not Found',
        getMessage: () => {
          const fileMatch = output?.match(/'([^']+)'/);
          const fileName = fileMatch ? fileMatch[1] : 'file';

          return `The file '${fileName}' does not exist and cannot be removed.\n\nSuggestion: Use 'ls' to check what files exist, or use 'rm -f' to ignore missing files.`;
        },
      },
      {
        pattern: /No such file or directory/,
        title: 'File or Directory Not Found',
        getMessage: () => {
          if (trimmedCommand.startsWith('cd ')) {
            const dirMatch = trimmedCommand.match(/cd\s+(.+)/);
            const dirName = dirMatch ? dirMatch[1] : 'directory';

            return `The directory '${dirName}' does not exist.\n\nSuggestion: Use 'mkdir -p ${dirName}' to create it first, or check available directories with 'ls'.`;
          }

          return `The specified file or directory does not exist.\n\nSuggestion: Check the path and use 'ls' to see available files.`;
        },
      },
      {
        pattern: /Permission denied/,
        title: 'Permission Denied',
        getMessage: () =>
          `Permission denied for '${firstWord}'.\n\nSuggestion: The file may not be executable. Try 'chmod +x filename' first.`,
      },
      {
        pattern: /command not found/,
        title: 'Command Not Found',
        getMessage: () =>
          `The command '${firstWord}' is not available.\n\nSuggestion: Check available commands or use a package manager to install it.`,
      },
      {
        pattern: /Is a directory/,
        title: 'Target is a Directory',
        getMessage: () =>
          `Cannot perform this operation - target is a directory.\n\nSuggestion: Use 'ls' to list directory contents or add appropriate flags.`,
      },
      {
        pattern: /File exists/,
        title: 'File Already Exists',
        getMessage: () => `File already exists.\n\nSuggestion: Use a different name or add '-f' flag to overwrite.`,
      },
    ];

    // Try to match known error patterns
    for (const errorPattern of errorPatterns) {
      if (output && errorPattern.pattern.test(output)) {
        return {
          title: errorPattern.title,
          details: errorPattern.getMessage(),
        };
      }
    }

    // Generic error with suggestions based on command type
    let suggestion = '';

    if (trimmedCommand.startsWith('npm ')) {
      suggestion = '\n\nSuggestion: Try running "npm install" first or check package.json.';
    } else if (trimmedCommand.startsWith('git ')) {
      suggestion = "\n\nSuggestion: Check if you're in a git repository or if remote is configured.";
    } else if (trimmedCommand.match(/^(ls|cat|rm|cp|mv)/)) {
      suggestion = '\n\nSuggestion: Check file paths and use "ls" to see available files.';
    }

    return {
      title: `Command Failed (exit code: ${exitCode})`,
      details: `Command: ${trimmedCommand}\n\nOutput: ${output || 'No output available'}${suggestion}`,
    };
  }

  /**
   * Handle plan action - parse JSON task list and populate the plan store
   */
  async #runPlanAction(action: PlanAction): Promise<void> {
    try {
      const content = action.content.trim();

      // Parse the JSON task list from the action content
      const planData = JSON.parse(content) as { tasks: PlanTaskData[]; title?: string };

      if (!planData.tasks || !Array.isArray(planData.tasks)) {
        logger.error('[Plan] Invalid plan data: tasks array is required');
        return;
      }

      // Convert to PlanTask format and set in store
      const tasks: PlanTask[] = planData.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        status: 'not-started' as const,
        fileActions: task.fileActions,
      }));

      // Set the plan in the store
      setPlan(tasks, action.planTitle || planData.title);

      logger.info(`[Plan] Created plan with ${tasks.length} tasks`);
    } catch (error) {
      logger.error('[Plan] Failed to parse plan action:', error);
      throw error; // Propagate so the action is marked as failed
    }
  }

  /**
   * Handle task update action - update task status in the plan store
   */
  async #runTaskUpdateAction(action: TaskUpdateAction): Promise<void> {
    try {
      const { taskId, taskStatus } = action;

      if (!taskId || !taskStatus) {
        logger.error('[TaskUpdate] Missing taskId or taskStatus');
        return;
      }

      // Update the task status in the store
      updateTaskStatus(taskId, taskStatus);

      logger.info(`[TaskUpdate] Updated task ${taskId} to status: ${taskStatus}`);
    } catch (error) {
      logger.error(`[TaskUpdate] Failed to update task ${action.taskId} to ${action.taskStatus}:`, error);
      throw error; // Propagate so the action is marked as failed
    }
  }
}
