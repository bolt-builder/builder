/**
 * @module runtime-provider
 * Core interface definitions for the Bolt runtime abstraction layer.
 *
 * Defines the contract between application code and the execution backend.
 * The default implementation uses local Node.js (`child_process` + native `fs`),
 * replacing the previous WebContainer-based browser execution. The interface
 * supports future backends (Docker, cloud sandboxes) via the `RuntimeType` union.
 *
 * @see {@link ./local-runtime.ts} Server-side implementation
 * @see {@link ./runtime-client.ts} Client-side proxy over HTTP/SSE
 */

/*
 * ---------------------------------------------------------------------------
 * File System Types
 * ---------------------------------------------------------------------------
 */

/** Metadata about a file or directory entry. */
export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;

  /** File size in bytes (0 for directories). */
  size: number;

  /** Last modification time as ISO-8601 string. */
  mtime: string;
}

/** A directory entry with type information. */
export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

/** Events emitted by the file watcher. */
export type WatchEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

/** A single file-system change event. */
export interface WatchEvent {
  type: WatchEventType;

  /** Path relative to the project root. */
  path: string;
}

/** Callback signature for file watch events. */
export type WatchCallback = (events: WatchEvent[]) => void;

/** Removes a listener / cleans up a resource. */
export type Disposer = () => void;

/*
 * ---------------------------------------------------------------------------
 * Process Types
 * ---------------------------------------------------------------------------
 */

/** Options when spawning a process. */
export interface SpawnOptions {
  /** Override working directory (relative to project root or absolute within project). */
  cwd?: string;

  /** Additional environment variables merged with the default env. */
  env?: Record<string, string>;

  /** Terminal dimensions for PTY-attached processes. */
  terminal?: { cols: number; rows: number };

  /** Timeout in ms — the process is killed (SIGTERM) if it exceeds this duration. */
  timeout?: number;
}

/** Result returned after a command finishes (used by `exec`). */
export interface ProcessResult {
  /** Process exit code (0 = success). */
  exitCode: number;

  /** Combined stdout + stderr output. */
  output: string;
}

/** Handle to a long-running spawned process. */
export interface SpawnedProcess {
  /** Server-assigned session ID for this process. */
  id: string;

  /** OS-level process ID. */
  pid: number;

  /** Write data to the process stdin. */
  write(data: string): void;

  /** Send a signal to the process (default: SIGTERM). */
  kill(signal?: string): void;

  /** Resize terminal dimensions (PTY processes only). */
  resize(dimensions: { cols: number; rows: number }): void;

  /** Resolves with the exit code when the process terminates. */
  onExit: Promise<number>;

  /** Register a callback for stdout/stderr data chunks. */
  onData(callback: (data: string) => void): Disposer;
}

/*
 * ---------------------------------------------------------------------------
 * Port Events
 * ---------------------------------------------------------------------------
 */

/** Indicates a port was opened or closed by a running process. */
export interface PortEvent {
  port: number;
  type: 'open' | 'close';

  /** URL to reach the service, e.g. `http://localhost:3000`. */
  url: string;
}

/*
 * ---------------------------------------------------------------------------
 * Runtime Provider Interface
 * ---------------------------------------------------------------------------
 */

/** Supported runtime backend types. */
export type RuntimeType = 'local' | 'docker' | 'cloud';

/**
 * Abstract interface for a code execution runtime.
 *
 * Consumers (ActionRunner, stores, UI components) interact with this
 * interface without knowing whether the backend is local Node.js,
 * Docker, or a cloud sandbox.
 *
 * @example
 * ```ts
 * const runtime = getRuntime();
 * await runtime.boot('my-project-id');
 * await runtime.fs.writeFile('index.js', 'console.log("hello")');
 * const result = await runtime.exec('node index.js');
 * console.log(result.output); // "hello"
 * ```
 */
export interface RuntimeProvider {
  /** Unique identifier for this runtime type. */
  readonly type: RuntimeType;

  /** Project ID this runtime is associated with. */
  readonly projectId: string;

  /** Absolute path to the project working directory. */
  readonly workdir: string;

  /** Filesystem operations scoped to the project directory. */
  readonly fs: RuntimeFileSystem;

  /**
   * Initialize the runtime for a given project.
   * Creates the project directory if it doesn't exist.
   */
  boot(projectId: string): Promise<void>;

  /**
   * Spawn a long-running process (e.g. dev server, shell session).
   * Returns a handle for streaming I/O.
   */
  spawn(command: string, args?: string[], options?: SpawnOptions): Promise<SpawnedProcess>;

  /**
   * Execute a command and wait for it to complete.
   * Returns the combined output and exit code.
   */
  exec(command: string, options?: SpawnOptions): Promise<ProcessResult>;

  /**
   * Allocate a free TCP port for a generated project's dev server.
   * Pre-registers the port so it won't be re-allocated in the same session.
   */
  allocatePort(): Promise<number>;

  /**
   * Get the preview URL for a dev server running on the given port.
   * For local runtime this returns `http://localhost:{port}`.
   */
  getPreviewUrl(port: number): string;

  /**
   * Register a listener for port open/close events from running processes.
   * Useful for auto-detecting when a dev server starts.
   */
  onPortEvent(callback: (event: PortEvent) => void): Disposer;

  /**
   * Tear down the runtime — kills all processes, optionally removes the
   * project directory. Safe to call multiple times.
   */
  teardown(): Promise<void>;
}

/**
 * Filesystem operations scoped to a project directory.
 * All paths are **relative to the project root** unless noted otherwise.
 */
export interface RuntimeFileSystem {
  /** Read a text file. Defaults to UTF-8 encoding. */
  readFile(path: string, encoding?: BufferEncoding): Promise<string>;

  /** Read a file as raw bytes. */
  readFileRaw(path: string): Promise<Uint8Array>;

  /** Write a text or binary file. Creates parent directories as needed. */
  writeFile(path: string, content: string | Uint8Array): Promise<void>;

  /** Create a directory. With `recursive: true`, creates parent dirs too. */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;

  /** List entries in a directory. */
  readdir(path: string): Promise<DirEntry[]>;

  /** Get metadata about a file or directory. */
  stat(path: string): Promise<FileStat>;

  /** Remove a file or directory. */
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;

  /** Check whether a path exists. */
  exists(path: string): Promise<boolean>;

  /** Rename / move a file or directory within the project. */
  rename(oldPath: string, newPath: string): Promise<void>;

  /**
   * Watch for file-system changes matching a glob pattern.
   * Returns a disposer to stop watching.
   *
   * @remarks Glob pattern is evaluated relative to the project root.
   * Use `**\/*` to watch everything.
   */
  watch(glob: string, callback: WatchCallback): Disposer;
}

/*
 * ---------------------------------------------------------------------------
 * Configuration
 * ---------------------------------------------------------------------------
 */

/** Configuration for the runtime system. */
export interface RuntimeConfig {
  /**
   * Base directory for all project workspaces.
   * Default: `~/.bolt/projects`
   */
  projectsDir: string;

  /**
   * Default shell executable. Auto-detected from OS if not set.
   * Examples: `/bin/bash`, `powershell.exe`, `cmd.exe`
   */
  shell?: string;

  /** Port range for dev servers. Default: { min: 3000, max: 9000 } */
  portRange?: { min: number; max: number };

  /** Maximum concurrent terminal sessions per project. Default: 5 */
  maxTerminals?: number;
}

/*
 * ---------------------------------------------------------------------------
 * API Request / Response Types (used by routes and RuntimeClient)
 * ---------------------------------------------------------------------------
 */

/** POST body for filesystem write operations. */
export interface FsWriteRequest {
  projectId: string;
  path: string;
  content: string;

  /** If true, content is base64-encoded binary data. */
  binary?: boolean;
}

/** POST body for filesystem mkdir operations. */
export interface FsMkdirRequest {
  projectId: string;
  path: string;
  recursive?: boolean;
}

/** POST body for filesystem rm operations. */
export interface FsRmRequest {
  projectId: string;
  path: string;
  recursive?: boolean;
  force?: boolean;
}

/** POST body for filesystem rename operations. */
export interface FsRenameRequest {
  projectId: string;
  oldPath: string;
  newPath: string;
}

/** POST body for command execution. */
export interface ExecRequest {
  projectId: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

/** POST body for spawning a terminal session. */
export interface TerminalSpawnRequest {
  projectId: string;
  command?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

/** POST body for writing to a terminal session. */
export interface TerminalWriteRequest {
  sessionId: string;
  data: string;
}

/** POST body for resizing a terminal session. */
export interface TerminalResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
}

/** POST body for killing a terminal session. */
export interface TerminalKillRequest {
  sessionId: string;
  signal?: string;
}

/*
 * ---------------------------------------------------------------------------
 * Validation Helpers
 * ---------------------------------------------------------------------------
 */

/** Regex for valid project IDs: alphanumeric, hyphens, underscores, 1-64 chars. */
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Validate a project ID to prevent path traversal. */
export function isValidProjectId(id: string): boolean {
  return PROJECT_ID_PATTERN.test(id);
}

/**
 * Validate that a file path is safe (no traversal outside the project).
 * Returns `true` if the path is safe.
 */
export function isSafePath(relativePath: string): boolean {
  // Reject absolute paths
  if (relativePath.startsWith('/') || /^[a-zA-Z]:/.test(relativePath)) {
    return false;
  }

  // Reject path traversal
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');

  let depth = 0;

  for (const segment of segments) {
    if (segment === '..') {
      depth -= 1;
    } else if (segment !== '.' && segment !== '') {
      depth += 1;
    }

    if (depth < 0) {
      return false;
    }
  }

  return true;
}
