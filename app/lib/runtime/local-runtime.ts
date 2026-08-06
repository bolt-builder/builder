/**
 * @module local-runtime
 * Server-side runtime implementation using Node.js `child_process` and native `fs`.
 *
 * This is the core execution engine that replaces WebContainer. It manages:
 * - A project working directory on the local filesystem
 * - Shell process spawning via `child_process.spawn`
 * - Terminal session lifecycle (create, write, resize, kill)
 * - Port detection from process stdout
 *
 * @remarks SERVER-ONLY — imports `node:child_process`, `node:os`, etc.
 */

import { spawn, exec, execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { initGitRepo } from './git-manager';
import { randomUUID } from 'node:crypto';
import type {
  RuntimeProvider,
  RuntimeType,
  RuntimeFileSystem,
  ProcessResult,
  SpawnedProcess,
  SpawnOptions,
  PortEvent,
  Disposer,
} from './runtime-provider';
import { isValidProjectId } from './runtime-provider';
import { LocalFileSystem } from './local-filesystem';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('LocalRuntime');

/** Default base directory for project workspaces. */
const DEFAULT_PROJECTS_DIR = nodePath.join(os.homedir(), '.bolt', 'projects');

/**
 * Detect the default shell for the current OS.
 * Returns `bash` on Unix, `powershell.exe` on Windows.
 */
function detectShell(): string {
  if (os.platform() === 'win32') {
    return process.env.COMSPEC ?? 'cmd.exe';
  }

  return process.env.SHELL ?? '/bin/bash';
}

/**
 * Kill an entire process tree.
 * On Windows, `process.kill()` only terminates the shell — child processes
 * (like `next dev`) keep running. We use `taskkill /T /F` to kill the tree.
 */
function killProcessTree(proc: ChildProcess): void {
  const pid = proc.pid;

  if (!pid) {
    return;
  }

  if (os.platform() === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
    } catch {
      // Process may have already exited
    }
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may have already exited
      }
    }
  }
}

/**
 * Kill any process listening on a given TCP port (Windows only).
 * Uses `netstat` to find the PID and `taskkill` to force-kill it.
 * This catches orphaned dev-server processes that `taskkill /T` missed
 * (e.g. when `next dev` spawns detached child processes).
 */
function killPortHolder(port: number): void {
  if (os.platform() !== 'win32') {
    return;
  }

  try {
    const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 3_000,
    });

    const pids = new Set<number>();

    for (const line of output.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);

      if (pid > 0 && !isNaN(pid)) {
        pids.add(pid);
      }
    }

    for (const pid of pids) {
      try {
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
        logger.debug(`Killed port ${port} holder (PID ${pid})`);
      } catch {
        // Process may have already exited
      }
    }
  } catch {
    // No process found on the port — nothing to kill
  }
}

/**
 * Wait until a TCP port is free, retrying `killPortHolder` if it remains
 * occupied.  Returns `true` once the port is free, `false` on timeout.
 */
async function waitForPortFree(port: number, timeoutMs = 3_000): Promise<boolean> {
  const start = Date.now();
  const POLL_INTERVAL_MS = 250;

  while (Date.now() - start < timeoutMs) {
    const isFree = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });

    if (isFree) {
      return true;
    }

    // Port still occupied — kill the holder again and wait before retrying
    killPortHolder(port);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  logger.warn(`Port ${port} still occupied after ${timeoutMs}ms — new server may pick a different port`);

  return false;
}

/**
 * Find a free TCP port in the given range.
 * Skips the host app's own port to avoid preview conflicts.
 */
async function findFreePort(startPort = 3000, endPort = 9000): Promise<number> {
  const hostPort = parseInt(process.env.PORT || '5173', 10);

  for (let port = startPort; port <= endPort; port++) {
    if (port === hostPort) {
      continue;
    }

    const isFree = await new Promise<boolean>((resolve) => {
      const server = net.createServer();

      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });

    if (isFree) {
      return port;
    }
  }

  throw new Error(`No free port found in range ${startPort}-${endPort}`);
}

/** Regex patterns to detect port announcements in process output. */
const PORT_PATTERNS = [
  /(?:Local|Server|App|http):?\s*(?:running\s+(?:at|on)\s+)?https?:\/\/[^:/\s]+:(\d+)/i,
  /(?:listening|started|running)\s+(?:at|on)\s+(?:port\s+)?(\d+)/i,

  /*
   * localhost / 0.0.0.0 / 127.0.0.1 patterns — use negative lookahead to
   * skip "in use" / "already" messages (e.g. "localhost:3000 is already in use").
   */
  /localhost:(\d+)(?!\s+is\b)(?!.*(?:in use|already))/i,
  /0\.0\.0\.0:(\d+)(?!\s+is\b)(?!.*(?:in use|already))/i,
  /127\.0\.0\.1:(\d+)(?!\s+is\b)(?!.*(?:in use|already))/i,

  /*
   * Broad "port XXXX" pattern — uses \b after the digits to prevent
   * regex backtracking, and a negative lookahead to skip messages
   * like "Port 5173 is in use" which are NOT server announcements.
   */
  /port\s+(\d+)\b(?!\s+is\b)/i,
];

/** Internal representation of a terminal session on the server. */
interface TerminalSession {
  id: string;
  projectId: string;

  /** Callbacks listening for data from this session. */
  dataListeners: Array<(data: string) => void>;

  /** Resolves when the process exits. */
  exitPromise: Promise<number>;

  /** True once the underlying process has exited. */
  exited: boolean;

  /** Write data to the process stdin / PTY. */
  write(data: string): void;

  /** Resize the terminal (PTY sessions only; no-op for pipes). */
  resize(cols: number, rows: number): void;

  /** Kill the whole process tree behind this session. */
  killTree(): void;

  /** Underlying child process when spawned without a PTY (pipes fallback). */
  process?: ChildProcess;
}

/*
 * ---------------------------------------------------------------------------
 * Optional node-pty support
 * ---------------------------------------------------------------------------
 * `node-pty` is an optionalDependency (native module). When it is present,
 * interactive terminal sessions get a real PTY, which enables keystroke
 * echo, line editing, and full-screen TUI programs (Claude Code, Codex,
 * Aider, vim, htop, ...). When the install failed or the platform is
 * unsupported we silently fall back to the historical pipe-based spawn.
 */

interface PtyProcessLike {
  pid: number;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface PtyModuleLike {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string | undefined> },
  ): PtyProcessLike;
}

let ptyModuleCache: PtyModuleLike | null | undefined;

function loadNodePty(): PtyModuleLike | null {
  if (ptyModuleCache !== undefined) {
    return ptyModuleCache;
  }

  try {
    const require = createRequire(import.meta.url);
    ptyModuleCache = require('node-pty') as PtyModuleLike;
    logger.info('node-pty loaded — interactive terminals use a real PTY');
  } catch (error) {
    ptyModuleCache = null;
    logger.warn(
      `node-pty unavailable — terminals fall back to pipes (no TUI support): ${
        error instanceof Error ? error.message.split('\n')[0] : error
      }`,
    );
  }

  return ptyModuleCache;
}

/*
 * ---------------------------------------------------------------------------
 * LocalRuntime
 * ---------------------------------------------------------------------------
 */

/**
 * Local Node.js runtime — executes code directly on the host machine.
 *
 * Designed as a singleton-per-project on the server side. The `RuntimeManager`
 * maps project IDs to `LocalRuntime` instances.
 */
export class LocalRuntime implements RuntimeProvider {
  readonly type: RuntimeType = 'local';
  readonly fs: RuntimeFileSystem;

  #projectId = '';
  #workdir = '';
  #shell: string;
  #projectsDir: string;
  #sessions = new Map<string, TerminalSession>();
  #portListeners: Array<(event: PortEvent) => void> = [];
  #detectedPorts = new Set<number>();

  constructor(options?: { projectsDir?: string; shell?: string }) {
    this.#projectsDir = options?.projectsDir ?? DEFAULT_PROJECTS_DIR;
    this.#shell = options?.shell ?? detectShell();

    /*
     * Filesystem is initialized with a temporary root;
     * replaced on boot() with the actual project directory.
     */
    this.fs = new LocalFileSystem(this.#projectsDir);
  }

  get projectId(): string {
    return this.#projectId;
  }

  get workdir(): string {
    return this.#workdir;
  }

  async boot(projectId: string): Promise<void> {
    if (!isValidProjectId(projectId)) {
      throw new Error(`Invalid project ID: "${projectId}". Must be alphanumeric with hyphens/underscores, 1-64 chars.`);
    }

    this.#projectId = projectId;
    this.#workdir = nodePath.join(this.#projectsDir, projectId);

    // Ensure project directory exists
    await fs.mkdir(this.#workdir, { recursive: true });

    // Replace filesystem with one scoped to the project
    const projectFs = new LocalFileSystem(this.#workdir);
    (this as { fs: RuntimeFileSystem }).fs = projectFs;

    /*
     * Ensure inspector / capture scripts are written for this project
     * (handles restored projects that skip the writeFile injection path).
     */
    await projectFs.ensureInspectorReady();

    // Initialize git repo for version history (non-blocking, best-effort)
    try {
      initGitRepo(this.#workdir);
    } catch {
      logger.debug('Git init skipped (git may not be installed)');
    }

    logger.info(`Runtime booted for project "${projectId}" at ${this.#workdir}`);
  }

  async spawn(command: string, args: string[] = [], options: SpawnOptions = {}): Promise<SpawnedProcess> {
    this.#ensureBooted();

    const sessionId = randomUUID();
    const cwd = options.cwd ? nodePath.resolve(this.#workdir, options.cwd) : this.#workdir;

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...options.env,
      FORCE_COLOR: '1',
      TERM: 'xterm-256color',
    };

    /*
     * A host NO_COLOR would conflict with FORCE_COLOR and make Node/Bun-based
     * CLIs (e.g. coding agents) print a warning with a stack trace at startup.
     * Only an explicit NO_COLOR from the caller survives.
     */
    if (!('NO_COLOR' in (options.env ?? {}))) {
      delete env.NO_COLOR;
    }

    const isWindows = os.platform() === 'win32';
    const dataListeners: Array<(data: string) => void> = [];

    /*
     * Interactive terminal sessions get a real PTY when node-pty is
     * available (POSIX only for now). This enables keystroke echo, line
     * editing, and full-screen TUIs like CLI coding agents.
     */
    const ptyModule = options.terminal && !isWindows ? loadNodePty() : null;

    if (ptyModule && options.terminal) {
      const ptyProc = ptyModule.spawn(this.#shell, ['-c', [command, ...args].join(' ')], {
        name: 'xterm-256color',
        cols: options.terminal.cols ?? 80,
        rows: options.terminal.rows ?? 24,
        cwd,
        env,
      });

      const session: TerminalSession = {
        id: sessionId,
        projectId: this.#projectId,
        dataListeners,
        exited: false,
        exitPromise: new Promise<number>((resolve) => {
          ptyProc.onExit(({ exitCode }) => {
            session.exited = true;
            this.#sessions.delete(sessionId);
            resolve(exitCode);
          });
        }),
        write: (data) => ptyProc.write(data),
        resize: (cols, rows) => {
          try {
            ptyProc.resize(cols, rows);
          } catch {
            // PTY may have exited
          }
        },
        killTree: () => {
          try {
            // The PTY child is a session leader; signal its process group
            process.kill(-ptyProc.pid, 'SIGTERM');
          } catch {
            try {
              ptyProc.kill();
            } catch {
              // Already exited
            }
          }
        },
      };

      ptyProc.onData((text) => {
        this.#detectPorts(text);

        for (const listener of dataListeners) {
          listener(text);
        }
      });

      this.#sessions.set(sessionId, session);
      logger.debug(`Spawned PTY process [${sessionId}]: ${command} ${args.join(' ')}`);

      return {
        id: sessionId,
        pid: ptyProc.pid,
        write: session.write,
        kill: (signal?: string) => {
          try {
            ptyProc.kill(signal);
          } catch {
            // Already exited
          }
        },
        resize: (dimensions: { cols: number; rows: number }) => session.resize(dimensions.cols, dimensions.rows),
        onExit: session.exitPromise,
        onData(callback: (data: string) => void): Disposer {
          dataListeners.push(callback);

          return () => {
            const idx = dataListeners.indexOf(callback);

            if (idx !== -1) {
              dataListeners.splice(idx, 1);
            }
          };
        },
      };
    }

    const proc = spawn(command, args, {
      cwd,
      env,
      shell: this.#shell,
      stdio: ['pipe', 'pipe', 'pipe'],

      /*
       * On Unix, `detached: true` creates a new process group so we can
       * kill the entire tree with `process.kill(-pid)`.
       * On Windows we use `taskkill /T` instead, so detached isn't needed.
       */
      ...(isWindows ? {} : { detached: true }),
    });

    const session: TerminalSession = {
      id: sessionId,
      process: proc,
      projectId: this.#projectId,
      dataListeners,
      exited: false,
      exitPromise: new Promise<number>((resolve) => {
        proc.on('exit', (code) => {
          session.exited = true;
          this.#sessions.delete(sessionId);
          resolve(code ?? 1);
        });

        proc.on('error', (err) => {
          logger.error(`Process error [${sessionId}]:`, err);
          session.exited = true;
          this.#sessions.delete(sessionId);
          resolve(1);
        });
      }),
      write: (data) => {
        proc.stdin?.write(data);
      },
      resize: () => {
        // Pipe-based sessions cannot resize
      },
      killTree: () => killProcessTree(proc),
    };

    // Pipe stdout
    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      this.#detectPorts(text);

      for (const listener of dataListeners) {
        listener(text);
      }
    });

    // Pipe stderr
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      this.#detectPorts(text);

      for (const listener of dataListeners) {
        listener(text);
      }
    });

    this.#sessions.set(sessionId, session);

    logger.debug(`Spawned process [${sessionId}]: ${command} ${args.join(' ')}`);

    return {
      id: sessionId,
      pid: proc.pid ?? 0,

      write(data: string) {
        proc.stdin?.write(data);
      },

      kill(signal?: string) {
        try {
          proc.kill(signal as NodeJS.Signals | undefined);
        } catch {
          // Process may have already exited
        }
      },

      resize(_dimensions: { cols: number; rows: number }) {
        // Pipe-based sessions cannot resize
      },

      onExit: session.exitPromise,

      onData(callback: (data: string) => void): Disposer {
        dataListeners.push(callback);

        return () => {
          const idx = dataListeners.indexOf(callback);

          if (idx !== -1) {
            dataListeners.splice(idx, 1);
          }
        };
      },
    };
  }

  async exec(command: string, options: SpawnOptions = {}): Promise<ProcessResult> {
    this.#ensureBooted();

    const cwd = options.cwd ? nodePath.resolve(this.#workdir, options.cwd) : this.#workdir;

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...options.env,
    };

    // See spawn(): avoid the Node/Bun NO_COLOR + FORCE_COLOR conflict warning.
    if (!('NO_COLOR' in (options.env ?? {}))) {
      delete env.NO_COLOR;
    }

    return new Promise<ProcessResult>((resolve) => {
      exec(
        command,
        {
          cwd,
          env,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
          shell: this.#shell,
          ...(options.timeout ? { timeout: options.timeout } : {}),
        },
        (error, stdout, stderr) => {
          const killed = error && 'killed' in error && (error as { killed?: boolean }).killed;

          resolve({
            exitCode: killed ? 124 : (error?.code ?? (error ? 1 : 0)),
            output: killed
              ? `${stdout}${stderr}\n[Process killed: exceeded ${Math.round((options.timeout ?? 0) / 1000)}s timeout]`
              : stdout + stderr,
          });
        },
      );
    });
  }

  /**
   * Allocate a free port for a generated project's dev server.
   * Pre-registers the port in `#detectedPorts` so it won't be re-allocated
   * to another project in the same session.
   */
  async allocatePort(): Promise<number> {
    const port = await findFreePort();
    this.#detectedPorts.add(port);
    logger.info(`Allocated port ${port} for project "${this.#projectId}"`);

    return port;
  }

  getPreviewUrl(port: number): string {
    return `http://localhost:${port}`;
  }

  onPortEvent(callback: (event: PortEvent) => void): Disposer {
    this.#portListeners.push(callback);

    return () => {
      const idx = this.#portListeners.indexOf(callback);

      if (idx !== -1) {
        this.#portListeners.splice(idx, 1);
      }
    };
  }

  /**
   * Kill all terminal sessions and reset port detection.
   * Used on client reconnect to clean up orphaned processes from previous page loads.
   *
   * Waits for each process to fully exit so that ports are released
   * before the caller spawns new sessions.
   */
  async cleanSessions(): Promise<void> {
    if (this.#sessions.size === 0) {
      return;
    }

    logger.info(`Cleaning ${this.#sessions.size} orphaned session(s) for "${this.#projectId}"`);

    const EXIT_TIMEOUT_MS = 5_000;
    const exitPromises: Array<Promise<void>> = [];

    for (const [id, session] of this.#sessions) {
      /*
       * Build a promise that resolves once the process has fully exited
       * (stdio closed, ports released). If exit already happened, resolve
       * immediately. A timeout prevents blocking forever.
       */
      const exitPromise = new Promise<void>((resolve) => {
        if (session.exited) {
          resolve();

          return;
        }

        let done = false;

        const finish = () => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve();
          }
        };

        void session.exitPromise.then(finish);

        const timer = setTimeout(() => {
          logger.warn(`Session ${id} did not exit within ${EXIT_TIMEOUT_MS}ms — proceeding`);
          finish();
        }, EXIT_TIMEOUT_MS);
      });

      exitPromises.push(exitPromise);
      session.killTree();
      logger.debug(`Killed orphaned session ${id}`);
    }

    // Wait for all processes to exit so ports are released
    const exitResults = await Promise.allSettled(exitPromises);

    for (const result of exitResults) {
      if (result.status === 'rejected') {
        logger.warn('Session cleanup promise rejected:', result.reason);
      }
    }

    /*
     * On Windows, `taskkill /T /F` may not kill detached child processes
     * (e.g. `next dev` spawning separate Node workers). As a fallback,
     * find and kill any process still holding a previously-detected port.
     */
    for (const port of this.#detectedPorts) {
      killPortHolder(port);
    }

    this.#sessions.clear();
    this.#detectedPorts.clear();

    // Remove stale lock files that dev servers may leave behind (e.g. .next/dev/lock)
    await this.#cleanLockFiles();
  }

  async teardown(): Promise<void> {
    logger.info(`Tearing down runtime for project "${this.#projectId}"`);

    const EXIT_TIMEOUT_MS = 5_000;
    const exitPromises: Array<Promise<void>> = [];
    const portsToFree = new Set(this.#detectedPorts);

    // Kill all sessions and wait for processes to fully exit so ports are released
    for (const [id, session] of this.#sessions) {
      const exitPromise = new Promise<void>((resolve) => {
        if (session.exited) {
          resolve();

          return;
        }

        let done = false;

        const finish = () => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve();
          }
        };

        void session.exitPromise.then(finish);

        const timer = setTimeout(() => {
          logger.warn(`Session ${id} did not exit within ${EXIT_TIMEOUT_MS}ms during teardown — proceeding`);
          finish();
        }, EXIT_TIMEOUT_MS);
      });

      exitPromises.push(exitPromise);
      session.killTree();
      logger.debug(`Killed session ${id}`);
    }

    // Wait for all processes to fully exit so ports are released
    const exitResults = await Promise.allSettled(exitPromises);

    for (const result of exitResults) {
      if (result.status === 'rejected') {
        logger.warn('Teardown cleanup promise rejected:', result.reason);
      }
    }

    this.#sessions.clear();
    this.#portListeners = [];

    // Force-kill any orphaned processes still holding detected ports
    for (const port of portsToFree) {
      killPortHolder(port);
    }

    // Verify ports are actually free — retry killing if still occupied
    for (const port of portsToFree) {
      await waitForPortFree(port);
    }

    this.#detectedPorts.clear();

    // Remove stale lock files that dev servers may leave behind
    await this.#cleanLockFiles();
  }

  /*
   * -------------------------------------------------------------------------
   * Terminal Session Management (used by API routes)
   * -------------------------------------------------------------------------
   */

  /** Get a terminal session by ID. */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.#sessions.get(sessionId);
  }

  /** List all active session IDs for this runtime. */
  listSessions(): string[] {
    return Array.from(this.#sessions.keys());
  }

  /** Write data to a terminal session's stdin / PTY. */
  writeToSession(sessionId: string, data: string): void {
    const session = this.#sessions.get(sessionId);

    if (!session) {
      throw new Error(`Terminal session not found: ${sessionId}`);
    }

    session.write(data);
  }

  /** Resize a terminal session (PTY sessions only; no-op for pipes). */
  resizeSession(sessionId: string, cols: number, rows: number): void {
    const session = this.#sessions.get(sessionId);

    if (!session) {
      throw new Error(`Terminal session not found: ${sessionId}`);
    }

    session.resize(cols, rows);
  }

  /** Kill a terminal session. */
  killSession(sessionId: string, _signal = 'SIGTERM'): void {
    const session = this.#sessions.get(sessionId);

    if (!session) {
      throw new Error(`Terminal session not found: ${sessionId}`);
    }

    session.killTree();
  }

  /*
   * -------------------------------------------------------------------------
   * Private Helpers
   * -------------------------------------------------------------------------
   */

  #ensureBooted(): void {
    if (!this.#projectId) {
      throw new Error('Runtime not booted. Call boot(projectId) first.');
    }
  }

  /**
   * Remove stale lock files left behind by dev servers (e.g. `.next/dev/lock`).
   * Without this, a refreshed page can't restart `next dev` because the
   * previous (now-killed) process left the lock file on disk.
   */
  async #cleanLockFiles(): Promise<void> {
    const lockPaths = [nodePath.join(this.#workdir, '.next', 'dev', 'lock')];

    for (const lockPath of lockPaths) {
      try {
        await fs.unlink(lockPath);
        logger.debug(`Removed stale lock file: ${lockPath}`);
      } catch {
        // Lock file doesn't exist — nothing to clean
      }
    }
  }

  /** Detect port numbers from process output and fire port events. */
  #detectPorts(output: string): void {
    /*
     * Strip ANSI escape codes so color sequences don't break regex matching.
     * Vite (and other tools) wrap URLs in color codes like \x1b[36m...\x1b[0m
     * which can insert non-digit characters between "localhost:" and the port number.
     */
    const cleaned = output.replace(/\x1b\[[0-9;]*m/g, '');

    /*
     * Process line-by-line to prevent false positives from cross-line matches.
     * For example, a tool may print "localhost:5173" on one line and
     * "is in use" on the next — the negative lookaheads in PORT_PATTERNS
     * wouldn't catch that if the whole chunk is matched as one string.
     */
    const lines = cleaned.split(/\r?\n/);

    for (const line of lines) {
      /*
       * Skip lines that indicate a port is NOT available / NOT a server announcement.
       * This provides a robust first-pass filter regardless of regex lookaheads.
       */
      if (/\b(?:in use|already|occupied|EADDRINUSE|address already|taken)\b/i.test(line)) {
        continue;
      }

      for (const pattern of PORT_PATTERNS) {
        const match = line.match(pattern);

        if (match?.[1]) {
          const port = parseInt(match[1], 10);

          if (port > 0 && port < 65536 && !this.#detectedPorts.has(port) && !this.#isExcludedPort(port)) {
            this.#detectedPorts.add(port);

            const event: PortEvent = {
              port,
              type: 'open',
              url: `http://localhost:${port}`,
            };

            logger.info(`Detected port open: ${port}`);

            for (const listener of this.#portListeners) {
              try {
                listener(event);
              } catch (err) {
                logger.error('Port event listener error:', err);
              }
            }
          }

          break; // Only match the first pattern per line
        }
      }
    }
  }

  /**
   * Check if a port should be excluded from detection.
   * The host app's own port (Bolt dev server) must not be treated as a
   * project preview server.
   */
  #isExcludedPort(port: number): boolean {
    /*
     * The Bolt app runs on PORT env var (default 5173 in dev, set explicitly
     * in Dockerfile). Exclude it so the preview iframe never shows the host app.
     */
    const hostPort = parseInt(process.env.PORT || '5173', 10);

    return port === hostPort;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Runtime Manager (Singleton)
 * ---------------------------------------------------------------------------
 */

/**
 * Server-side singleton that manages `LocalRuntime` instances per project.
 *
 * API routes use `RuntimeManager.get(projectId)` to obtain a runtime,
 * creating one on demand if it doesn't exist.
 *
 * Features:
 * - Deduplicates concurrent boot requests for the same project
 * - Tracks last-activity per project for idle cleanup
 * - Auto-tears down runtimes idle for > IDLE_TIMEOUT_MS (10 minutes)
 */
export class RuntimeManager {
  static #instance: RuntimeManager | null = null;

  /** 10 minutes of inactivity before auto-teardown */
  static readonly IDLE_TIMEOUT_MS = 10 * 60 * 1000;

  /** How often to check for idle runtimes (every 60 seconds) */
  static readonly IDLE_CHECK_INTERVAL_MS = 60 * 1000;

  #runtimes = new Map<string, LocalRuntime>();

  /**
   * In-flight boot promises keyed by project ID.
   *
   * Prevents a race condition where two concurrent requests both see
   * `#runtimes.get(id) === undefined`, each creates a new LocalRuntime,
   * and the second overwrites the first — orphaning its sessions/processes.
   *
   * By caching the boot Promise itself, the second caller awaits the same
   * Promise and receives the same runtime instance.
   */
  #bootingProjects = new Map<string, Promise<LocalRuntime>>();

  /** Tracks last activity timestamp per project for idle timeout */
  #lastActivity = new Map<string, number>();

  /** Interval timer for idle cleanup */
  #idleTimer: ReturnType<typeof setInterval> | null = null;

  #projectsDir: string;
  #shell: string;

  private constructor(options?: { projectsDir?: string; shell?: string }) {
    this.#projectsDir = options?.projectsDir ?? process.env.BOLT_PROJECTS_DIR ?? DEFAULT_PROJECTS_DIR;
    this.#shell = options?.shell ?? detectShell();
    this.#startIdleTimer();
  }

  /** Get the singleton instance. */
  static getInstance(): RuntimeManager {
    if (!RuntimeManager.#instance) {
      RuntimeManager.#instance = new RuntimeManager();
    }

    return RuntimeManager.#instance;
  }

  /** Record activity for a project (prevents idle teardown). */
  touchActivity(projectId: string): void {
    this.#lastActivity.set(projectId, Date.now());
  }

  /**
   * Get or create a runtime for the given project ID.
   * Automatically boots the runtime if it's new.
   *
   * Safe for concurrent access: if two requests arrive simultaneously
   * for the same project ID, both will receive the same runtime instance.
   */
  async getRuntime(projectId: string): Promise<LocalRuntime> {
    this.touchActivity(projectId);

    // Fast path: runtime already exists
    const existing = this.#runtimes.get(projectId);

    if (existing) {
      return existing;
    }

    // Check if another request is already booting this project
    const inflight = this.#bootingProjects.get(projectId);

    if (inflight) {
      return inflight;
    }

    // Create and cache the boot promise to prevent duplicate boots
    const bootPromise = (async () => {
      const runtime = new LocalRuntime({
        projectsDir: this.#projectsDir,
        shell: this.#shell,
      });
      await runtime.boot(projectId);
      this.#runtimes.set(projectId, runtime);
      this.#bootingProjects.delete(projectId);
      logger.info(`Created runtime for project "${projectId}"`);

      return runtime;
    })();

    this.#bootingProjects.set(projectId, bootPromise);

    try {
      return await bootPromise;
    } catch (error) {
      // Clean up on boot failure so retries can try again
      this.#bootingProjects.delete(projectId);
      throw error;
    }
  }

  /** Tear down and remove a runtime. */
  async removeRuntime(projectId: string): Promise<void> {
    const runtime = this.#runtimes.get(projectId);

    if (runtime) {
      await runtime.teardown();
      this.#runtimes.delete(projectId);
      this.#lastActivity.delete(projectId);
    }
  }

  /** Tear down all runtimes. Called on server shutdown. */
  async teardownAll(): Promise<void> {
    if (this.#idleTimer) {
      clearInterval(this.#idleTimer);
      this.#idleTimer = null;
    }

    const teardownPromises = Array.from(this.#runtimes.values()).map((rt) => rt.teardown());
    await Promise.allSettled(teardownPromises);
    this.#runtimes.clear();
    this.#bootingProjects.clear();
    this.#lastActivity.clear();
    logger.info('All runtimes torn down');
  }

  /** Get the projects directory path. */
  get projectsDir(): string {
    return this.#projectsDir;
  }

  /** List all active project IDs. */
  listProjects(): string[] {
    return Array.from(this.#runtimes.keys());
  }

  /** Start the periodic idle cleanup timer. */
  #startIdleTimer(): void {
    this.#idleTimer = setInterval(() => {
      this.#cleanIdleRuntimes();
    }, RuntimeManager.IDLE_CHECK_INTERVAL_MS);

    // Don't prevent Node.js from exiting
    if (this.#idleTimer && typeof this.#idleTimer === 'object' && 'unref' in this.#idleTimer) {
      this.#idleTimer.unref();
    }
  }

  /** Tear down runtimes that haven't had activity within IDLE_TIMEOUT_MS. */
  #cleanIdleRuntimes(): void {
    const now = Date.now();

    for (const [projectId] of this.#runtimes) {
      const lastActive = this.#lastActivity.get(projectId) ?? 0;

      if (now - lastActive > RuntimeManager.IDLE_TIMEOUT_MS) {
        logger.info(
          `Idle timeout: tearing down runtime for "${projectId}" (inactive for ${Math.round((now - lastActive) / 1000)}s)`,
        );

        this.removeRuntime(projectId).catch((err) => {
          logger.error(`Failed to teardown idle runtime "${projectId}":`, err);
        });
      }
    }
  }
}
