import type { RuntimeProvider, SpawnedProcess } from '~/lib/runtime/runtime-provider';
import type { ITerminal } from '~/types/terminal';
import { withResolvers } from './promises';
import { atom } from 'nanostores';
import { expoUrlAtom } from '~/lib/stores/qrCode';
import { detectTerminalErrors } from './terminalErrorDetector';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('Shell');

/**
 * Unique marker prefix used to detect command completion in terminal output.
 * The full marker format is `__BOLT_CMD_DONE__<id>_<exitCode>`.
 */
const MARKER_PREFIX = '__BOLT_CMD_DONE__';

/** Regex that matches the marker in terminal output. */
const MARKER_REGEX = new RegExp(`${MARKER_PREFIX}_(\\w+)_(\\d+)`);

/**
 * Detect the user's default shell command and args.
 * Falls back to bash on Linux/Mac and cmd on Windows.
 */
function getDefaultShell(): { command: string; args: string[] } {
  const isWindows = typeof process !== 'undefined' && process.platform === 'win32';

  if (isWindows) {
    return { command: 'powershell.exe', args: ['-NoLogo', '-NoExit'] };
  }

  const userShell = typeof process !== 'undefined' ? process.env.SHELL : undefined;

  if (userShell) {
    return { command: userShell, args: ['--login', '-i'] };
  }

  return { command: '/bin/bash', args: ['--login', '-i'] };
}

/**
 * Spawn a new interactive shell process attached to a terminal.
 * This creates a simple, user-facing terminal tab (not the AI-command executor).
 */
export async function newShellProcess(runtime: RuntimeProvider, terminal: ITerminal): Promise<SpawnedProcess> {
  const { command, args } = getDefaultShell();

  const shellProcess = await runtime.spawn(command, args, {
    terminal: {
      cols: terminal.cols ?? 80,
      rows: terminal.rows ?? 15,
    },
  });

  /* Forward process output → terminal */
  shellProcess.onData((data) => {
    terminal.write(data);

    /* Detect actionable errors in terminal output */
    try {
      detectTerminalErrors(data);
    } catch {
      /* Ignore errors in error detection */
    }

    /* Capture terminal output for debugging */
    try {
      import('~/utils/debugLogger')
        .then(({ captureTerminalLog }) => {
          const cleanData = data.replace(/\x1b\[[0-9;]*[mG]/g, '').trim();

          if (cleanData) {
            captureTerminalLog(cleanData, 'output');
          }
        })
        .catch(() => {
          /* Ignore if debug logger is not available */
        });
    } catch {
      /* Ignore errors in debug logging */
    }
  });

  /* Forward terminal input → process stdin */
  terminal.onData((data) => {
    shellProcess.write(data);

    /* Capture terminal input for debugging */
    try {
      import('~/utils/debugLogger')
        .then(({ captureTerminalLog }) => {
          const cleanData = data.replace(/\x1b\[[0-9;]*[A-Z]/g, '').trim();

          if (cleanData && cleanData !== '\r' && cleanData !== '\n') {
            captureTerminalLog(cleanData, 'input');
          }
        })
        .catch(() => {
          /* Ignore if debug logger is not available */
        });
    } catch {
      /* Ignore errors in debug logging */
    }
  });

  return shellProcess;
}

export type ExecutionResult = { output: string; exitCode: number } | undefined;

/**
 * AI-command executor shell.
 *
 * Maintains a persistent shell session where commands are sent one-at-a-time,
 * and command completion + exit codes are detected via echo markers.
 *
 * Replaces the previous WebContainer jsh+OSC-based approach with a marker pattern
 * that works with any real shell (bash, zsh, powershell, cmd).
 */
export class BoltShell {
  #initialized: (() => void) | undefined;
  #readyPromise: Promise<void>;
  #terminal: ITerminal | undefined;
  #process: SpawnedProcess | undefined;

  executionState = atom<
    { sessionId: string; active: boolean; executionPrms?: Promise<unknown>; abort?: () => void } | undefined
  >();

  /**
   * Buffer for accumulating output when waiting for marker detection.
   * Only populated during active command execution.
   */
  #outputBuffer = '';

  /** Resolver for the currently awaited command marker. */
  #markerResolver: ((result: { output: string; exitCode: number }) => void) | undefined;

  /** The marker ID we are currently waiting for. */
  #pendingMarkerId: string | undefined;

  /** Resolver for shell readiness detection. */
  #readyResolver: (() => void) | undefined;

  /** Buffer for accumulating output during readiness detection. */
  #readyBuffer = '';

  /** The readiness marker string to look for. */
  #readyMarker = '';

  /** Regex for detecting Expo URLs in terminal output. */
  readonly #expoUrlRegex = /(exp:\/\/[^\s]+)/;

  constructor() {
    this.#readyPromise = new Promise((resolve) => {
      this.#initialized = resolve;
    });
  }

  ready() {
    return this.#readyPromise;
  }

  /**
   * Initialize the shell with a runtime provider and terminal.
   * Spawns a real OS shell and waits for it to become interactive.
   */
  async init(runtime: RuntimeProvider, terminal: ITerminal) {
    this.#terminal = terminal;

    const { command, args } = getDefaultShell();

    this.#process = await runtime.spawn(command, args, {
      terminal: {
        cols: terminal.cols ?? 80,
        rows: terminal.rows ?? 15,
      },
    });

    /* Forward output to terminal + internal handler */
    this.#process.onData((data) => {
      /*
       * Filter internal markers before displaying to user.
       * The raw data still goes to the internal handler for marker detection.
       */
      const filtered = this.#filterInternalNoise(data);

      if (filtered) {
        terminal.write(filtered);
      }

      this.#handleOutputData(data);
    });

    /* Forward terminal input → process stdin */
    terminal.onData((data) => {
      this.#process?.write(data);
    });

    /*
     * Wait for the shell to become interactive by sending a readiness marker.
     * The shell will echo the marker once it has finished its login scripts.
     */
    const readyPromise = withResolvers<void>();
    this.#readyMarker = `${MARKER_PREFIX}_READY`;
    this.#readyBuffer = '';
    this.#readyResolver = () => readyPromise.resolve();

    this.#process.write(`echo "${this.#readyMarker}"\n`);

    await readyPromise.promise;

    /* Clear readiness detection state */
    this.#readyResolver = undefined;
    this.#readyMarker = '';
    this.#readyBuffer = '';

    /*
     * Reset terminal to clear shell startup noise:
     * - "bash: cannot set terminal process group" warnings
     * - "bash: no job control in this shell" messages
     * - The readiness marker echo command and its output
     * Users see a clean terminal from this point forward.
     */
    terminal.reset();

    this.#initialized?.();
  }

  /**
   * Internal handler for all output data from the shell process.
   * Scans for command-completion markers, Expo URLs, and terminal errors.
   */
  #handleOutputData(data: string) {
    /* Detect actionable errors */
    try {
      detectTerminalErrors(data);
    } catch {
      /* Ignore */
    }

    /* Shell readiness detection (during init) */
    if (this.#readyResolver && this.#readyMarker) {
      this.#readyBuffer += data;

      if (this.#readyBuffer.includes(this.#readyMarker)) {
        this.#readyResolver();
      }
    }

    /* Expo URL detection */
    const expoMatch = data.match(this.#expoUrlRegex);

    if (expoMatch) {
      const cleanUrl = expoMatch[1]
        .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
        .replace(/[^\x20-\x7E]+$/g, '');
      expoUrlAtom.set(cleanUrl);
    }

    /* If we're waiting for a command marker, accumulate output */
    if (this.#pendingMarkerId) {
      this.#outputBuffer += data;

      const markerMatch = this.#outputBuffer.match(MARKER_REGEX);

      if (markerMatch && markerMatch[1] === this.#pendingMarkerId) {
        const exitCode = parseInt(markerMatch[2], 10);

        /*
         * Extract the output between command echo and marker.
         * Strip the marker line itself from the captured output.
         */
        const markerIndex = this.#outputBuffer.indexOf(`${MARKER_PREFIX}_${this.#pendingMarkerId}`);
        const commandOutput = this.#outputBuffer.slice(0, markerIndex);

        this.#markerResolver?.({ output: commandOutput, exitCode });
        this.#markerResolver = undefined;
        this.#pendingMarkerId = undefined;
        this.#outputBuffer = '';
      }
    }
  }

  /**
   * Interrupt any running process in the terminal by sending Ctrl+C.
   * Useful when user wants to fix an error and terminal needs to be free.
   */
  interruptExecution(): void {
    if (this.#process) {
      this.#process.write('\x03');
    }
  }

  /**
   * Strip internal shell mechanics from terminal output so users
   * only see meaningful command output. Removes:
   * - Marker echo suffixes from command lines (e.g. `; echo "__BOLT_CMD_DONE__..."`).
   * - Standalone echo commands for markers (e.g. `$ echo "__BOLT_CMD_DONE___READY"`).
   * - Standalone marker output lines.
   * - Common bash startup noise (ioctl warnings, no job control).
   */
  #filterInternalNoise(data: string): string {
    const hasMarker = data.includes(MARKER_PREFIX);
    const hasBashNoise =
      data.includes('bash: cannot set terminal process group') || data.includes('bash: no job control');

    if (!hasMarker && !hasBashNoise) {
      return data;
    }

    let filtered = data;

    if (hasMarker) {
      /* Strip the marker echo suffix appended to commands (e.g. `; echo "marker"`) */
      filtered = filtered.replace(/;\s*echo\s+"[^"]*__BOLT_CMD_DONE__[^"]*"\s*/g, '');

      /*
       * Remove ALL lines containing the marker prefix.
       * Covers: standalone echo commands (`$ echo "marker"`),
       * bare marker output (`__BOLT_CMD_DONE___READY`),
       * and command-completion markers (`__BOLT_CMD_DONE__abc_0`).
       */
      filtered = filtered.replace(/^.*__BOLT_CMD_DONE__.*$/gm, '');
    }

    if (hasBashNoise) {
      filtered = filtered.replace(/^.*bash: cannot set terminal process group.*$/gm, '');
      filtered = filtered.replace(/^.*bash: no job control.*$/gm, '');
    }

    /* Collapse excessive blank lines left by removals */
    filtered = filtered.replace(/\n{3,}/g, '\n\n');

    return filtered;
  }

  get terminal() {
    return this.#terminal;
  }

  get process() {
    return this.#process;
  }

  /**
   * Execute a command in the shell and wait for it to complete.
   * Uses echo markers to detect command completion and capture exit code.
   */
  async executeCommand(sessionId: string, command: string, abort?: () => void): Promise<ExecutionResult> {
    if (!this.#process || !this.#terminal) {
      return undefined;
    }

    const state = this.executionState.get();

    if (state?.active) {
      if (state.abort) {
        state.abort();
      }

      /* Interrupt the running command with Ctrl+C only if something is active */
      this.#process.write('\x03');

      /* Wait briefly for prompt to settle */
      await new Promise((resolve) => setTimeout(resolve, 100));

      if (state.executionPrms) {
        await state.executionPrms;
      }
    }

    /* Generate unique marker ID for this command */
    const markerId = Date.now().toString(36);

    /* Prepare the execution promise */
    const executionPromise = new Promise<{ output: string; exitCode: number }>((resolve) => {
      this.#markerResolver = resolve;
      this.#pendingMarkerId = markerId;
      this.#outputBuffer = '';
    });

    this.executionState.set({ sessionId, active: true, executionPrms: executionPromise, abort });

    /*
     * Send the command followed by a marker echo.
     * The marker includes the exit code of the preceding command ($?).
     * Use a semicolon-based chain that works in both bash and powershell.
     */
    const markerCommand = `${command.trim()}; echo "${MARKER_PREFIX}_${markerId}_$?"`;
    this.#process.write(markerCommand + '\n');

    const resp = await executionPromise;
    this.executionState.set({ sessionId, active: false });

    if (resp) {
      try {
        resp.output = cleanTerminalOutput(resp.output);
      } catch (error) {
        logger.error('Failed to format terminal output', error);
      }
    }

    return resp;
  }
}

/**
 * Cleans and formats terminal output while preserving structure and paths.
 * Handles ANSI, OSC, and various terminal control sequences.
 */
export function cleanTerminalOutput(input: string): string {
  /* Step 1: Remove OSC sequences (including those with parameters) */
  const removeOsc = input
    .replace(/\x1b\](\d+;[^\x07\x1b]*|\d+[^\x07\x1b]*)\x07/g, '')
    .replace(/\](\d+;[^\n]*|\d+[^\n]*)/g, '');

  /* Step 2: Remove ANSI escape sequences and color codes */
  const removeAnsi = removeOsc
    .replace(/\u001b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\u001b/g, '')
    .replace(/\x1b/g, '');

  /* Step 3: Clean up carriage returns and newlines */
  const cleanNewlines = removeAnsi
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  /* Step 4: Add newlines at key breakpoints while preserving paths */
  const formatOutput = cleanNewlines
    .replace(/^([~\/][^\n❯]+)❯/m, '$1\n❯')
    .replace(/(?<!^|\n)>/g, '\n>')
    .replace(/(?<!^|\n|\w)(error|failed|warning|Error|Failed|Warning):/g, '\n$1:')
    .replace(/(?<!^|\n|\/)(at\s+(?!async|sync))/g, '\nat ')
    .replace(/\bat\s+async/g, 'at async')
    .replace(/(?<!^|\n)(npm ERR!)/g, '\n$1');

  /* Step 5: Clean up whitespace while preserving intentional spacing */
  const cleanSpaces = formatOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

  /* Step 6: Final cleanup */
  return cleanSpaces
    .replace(/\n{3,}/g, '\n\n')
    .replace(/:\s+/g, ': ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\u0000/g, '');
}

/**
 * Create a new BoltShell instance.
 * Factory function for consistent construction.
 */
export function newBoltShellProcess() {
  return new BoltShell();
}
