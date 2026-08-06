/**
 * @module container-runtime
 * Docker container-based runtime implementation.
 *
 * Executes user code inside ephemeral Docker containers with:
 * - Volume-mounted workspace (project directory)
 * - Resource limits (CPU, memory, no network by default)
 * - Auto-cleanup on session end or 30-minute timeout
 * - Graceful fallback to LocalRuntime when Docker is unavailable
 *
 * Uses Docker CLI via `child_process.execFile` — no dockerode dependency.
 *
 * @remarks SERVER-ONLY — imports `node:child_process`, `node:fs`, etc.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
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
import { validateCommand, auditCommand } from './command-safety';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ContainerRuntime');

const execFileAsync = promisify(execFile);

/** Default base directory for project workspaces. */
const DEFAULT_PROJECTS_DIR = nodePath.join(os.homedir(), '.bolt', 'projects');

/** Default container image — configurable via BOLT_CONTAINER_IMAGE env var. */
const DEFAULT_CONTAINER_IMAGE = 'node:20-slim';

/** Container timeout: 30 minutes. */
const CONTAINER_TIMEOUT_MS = 30 * 60 * 1000;

/** How often to check for expired containers (every 60 seconds). */
const CLEANUP_INTERVAL_MS = 60 * 1000;

/** Resource limits for containers. */
interface ContainerResourceLimits {
  /** CPU quota (e.g., '1.0' = 1 core). */
  cpus: string;

  /** Memory limit (e.g., '512m'). */
  memory: string;

  /** Whether to allow network access. */
  networkEnabled: boolean;
}

const DEFAULT_RESOURCE_LIMITS: ContainerResourceLimits = {
  cpus: '1.0',
  memory: '512m',
  networkEnabled: false,
};

/** Tracked container info for lifecycle management. */
interface TrackedContainer {
  containerId: string;
  sessionId: string;
  projectId: string;
  createdAt: number;
  process: ChildProcess | null;
}

/**
 * Check whether the Docker daemon is reachable.
 * Returns `true` if `docker info` succeeds, `false` otherwise.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info'], {
      timeout: 5_000,
      windowsHide: true,
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Docker container-based runtime.
 *
 * Executes commands inside ephemeral containers with the project directory
 * volume-mounted. Falls back to `LocalRuntime` when Docker is unavailable.
 */
export class ContainerRuntime implements RuntimeProvider {
  readonly type: RuntimeType = 'docker';
  readonly fs: RuntimeFileSystem;

  #projectId = '';
  #workdir = '';
  #projectsDir: string;
  #containerImage: string;
  #resourceLimits: ContainerResourceLimits;
  #containers = new Map<string, TrackedContainer>();
  #portListeners: Array<(event: PortEvent) => void> = [];
  #detectedPorts = new Set<number>();
  #cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: {
    projectsDir?: string;
    containerImage?: string;
    resourceLimits?: Partial<ContainerResourceLimits>;
  }) {
    this.#projectsDir = options?.projectsDir ?? DEFAULT_PROJECTS_DIR;
    this.#containerImage = options?.containerImage ?? process.env.BOLT_CONTAINER_IMAGE ?? DEFAULT_CONTAINER_IMAGE;
    this.#resourceLimits = { ...DEFAULT_RESOURCE_LIMITS, ...options?.resourceLimits };
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

    await fs.mkdir(this.#workdir, { recursive: true });

    const projectFs = new LocalFileSystem(this.#workdir);
    (this as { fs: RuntimeFileSystem }).fs = projectFs;

    this.#startCleanupTimer();

    logger.info(`ContainerRuntime booted for project "${projectId}" at ${this.#workdir}`);
  }

  async spawn(command: string, args: string[] = [], options: SpawnOptions = {}): Promise<SpawnedProcess> {
    this.#ensureBooted();

    const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;

    const validation = validateCommand(fullCommand);

    if (!validation.allowed) {
      throw new Error(`Command blocked by safety check: ${validation.reason}`);
    }

    auditCommand(this.#projectId, fullCommand, 'spawn');

    const sessionId = randomUUID();
    const containerName = `bolt-${this.#projectId}-${sessionId.slice(0, 8)}`;
    const cwd = options.cwd ?? '/workspace';

    const dockerArgs = this.#buildDockerRunArgs({
      containerName,
      cwd,
      env: options.env,
      interactive: true,
    });

    dockerArgs.push(this.#containerImage, 'sh', '-c', fullCommand);

    const proc = spawn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const dataListeners: Array<(data: string) => void> = [];

    const exitPromise = new Promise<number>((resolve) => {
      proc.on('exit', (code) => {
        this.#removeContainer(sessionId);
        resolve(code ?? 1);
      });

      proc.on('error', (err) => {
        logger.error(`Container process error [${sessionId}]:`, err);
        this.#removeContainer(sessionId);
        resolve(1);
      });
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      this.#detectPorts(text);

      for (const listener of dataListeners) {
        listener(text);
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      this.#detectPorts(text);

      for (const listener of dataListeners) {
        listener(text);
      }
    });

    this.#containers.set(sessionId, {
      containerId: containerName,
      sessionId,
      projectId: this.#projectId,
      createdAt: Date.now(),
      process: proc,
    });

    logger.debug(`Spawned container [${containerName}]: ${fullCommand}`);

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

        execFile('docker', ['rm', '-f', containerName], { windowsHide: true }, () => {
          /* best-effort cleanup */
        });
      },

      resize(_dimensions: { cols: number; rows: number }) {
        /* Docker CLI doesn't support resize on non-TTY containers */
      },

      onExit: exitPromise,

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

    const validation = validateCommand(command);

    if (!validation.allowed) {
      return {
        exitCode: 126,
        output: `Command blocked by safety check: ${validation.reason}`,
      };
    }

    auditCommand(this.#projectId, command, 'exec');

    const containerName = `bolt-exec-${this.#projectId}-${randomUUID().slice(0, 8)}`;
    const cwd = options.cwd ?? '/workspace';
    const timeout = options.timeout ?? 5 * 60 * 1000;

    const dockerArgs = this.#buildDockerRunArgs({
      containerName,
      cwd,
      env: options.env,
      interactive: false,
    });

    dockerArgs.push(this.#containerImage, 'sh', '-c', command);

    try {
      const { stdout, stderr } = await execFileAsync('docker', dockerArgs, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });

      return {
        exitCode: 0,
        output: stdout + stderr,
      };
    } catch (err: unknown) {
      const error = err as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      const killed = error.killed === true;

      return {
        exitCode: killed ? 124 : typeof error.code === 'number' ? error.code : 1,
        output: killed
          ? `${error.stdout ?? ''}${error.stderr ?? ''}\n[Process killed: exceeded ${Math.round(timeout / 1000)}s timeout]`
          : `${error.stdout ?? ''}${error.stderr ?? ''}`,
      };
    } finally {
      execFile('docker', ['rm', '-f', containerName], { windowsHide: true }, () => {
        /* best-effort cleanup */
      });
    }
  }

  async allocatePort(): Promise<number> {
    /*
     * Port allocation for containers is handled at the host level since
     * containers use host-mapped ports. Find a free port on the host.
     */
    const port = await this.#findFreePort();
    this.#detectedPorts.add(port);
    logger.info(`Allocated port ${port} for container project "${this.#projectId}"`);

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

  async teardown(): Promise<void> {
    logger.info(`Tearing down ContainerRuntime for project "${this.#projectId}"`);

    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }

    const removalPromises: Promise<void>[] = [];

    for (const [, container] of this.#containers) {
      removalPromises.push(this.#forceRemoveContainer(container.containerId));

      if (container.process) {
        try {
          container.process.kill('SIGTERM');
        } catch {
          // Process may have already exited
        }
      }
    }

    await Promise.allSettled(removalPromises);

    this.#containers.clear();
    this.#portListeners = [];
    this.#detectedPorts.clear();
  }

  /*
   * -------------------------------------------------------------------------
   * Private: Docker CLI Helpers
   * -------------------------------------------------------------------------
   */

  /** Build the `docker run` arguments with security constraints and resource limits. */
  #buildDockerRunArgs(opts: {
    containerName: string;
    cwd: string;
    env?: Record<string, string>;
    interactive: boolean;
  }): string[] {
    const args: string[] = [
      'run',
      '--rm',
      '--name',
      opts.containerName,

      // Security: run as non-root user (node user UID 1000 in node images)
      '--user',
      '1000:1000',

      // Security: drop ALL capabilities, add back only what's needed
      '--cap-drop',
      'ALL',

      // Security: read-only root filesystem
      '--read-only',

      // Writable temp directories for processes that need it
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=100m',
      '--tmpfs',
      '/home/node/.npm:rw,noexec,nosuid,size=50m',

      // Resource limits
      '--cpus',
      this.#resourceLimits.cpus,
      '--memory',
      this.#resourceLimits.memory,
      '--memory-swap',
      this.#resourceLimits.memory, // no swap

      // Security: no new privileges
      '--security-opt',
      'no-new-privileges',

      // Mount the project workspace
      '-v',
      `${this.#workdir}:/workspace:rw`,
      '-w',
      opts.cwd,
    ];

    // Network access — disabled by default
    if (!this.#resourceLimits.networkEnabled) {
      args.push('--network', 'none');
    }

    // Environment variables
    if (opts.env) {
      for (const [key, value] of Object.entries(opts.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    if (opts.interactive) {
      args.push('-i');
    }

    return args;
  }

  /** Force-remove a Docker container by name. */
  async #forceRemoveContainer(containerName: string): Promise<void> {
    try {
      await execFileAsync('docker', ['rm', '-f', containerName], {
        timeout: 10_000,
        windowsHide: true,
      });
      logger.debug(`Removed container: ${containerName}`);
    } catch {
      // Container may have already been removed
    }
  }

  /** Remove tracked container state after exit. */
  #removeContainer(sessionId: string): void {
    this.#containers.delete(sessionId);
  }

  /*
   * -------------------------------------------------------------------------
   * Private: Cleanup Timer
   * -------------------------------------------------------------------------
   */

  /** Start periodic timer to clean up containers that exceeded the 30-minute timeout. */
  #startCleanupTimer(): void {
    this.#cleanupTimer = setInterval(() => {
      this.#cleanupExpiredContainers();
    }, CLEANUP_INTERVAL_MS);

    if (this.#cleanupTimer && typeof this.#cleanupTimer === 'object' && 'unref' in this.#cleanupTimer) {
      this.#cleanupTimer.unref();
    }
  }

  /** Kill and remove containers older than CONTAINER_TIMEOUT_MS. */
  #cleanupExpiredContainers(): void {
    const now = Date.now();

    for (const [sessionId, container] of this.#containers) {
      if (now - container.createdAt > CONTAINER_TIMEOUT_MS) {
        logger.warn(`Container ${container.containerId} exceeded 30-minute timeout — killing`);

        if (container.process) {
          try {
            container.process.kill('SIGTERM');
          } catch {
            // Already exited
          }
        }

        this.#forceRemoveContainer(container.containerId).catch(() => {
          /* best-effort */
        });
        this.#containers.delete(sessionId);
      }
    }
  }

  /*
   * -------------------------------------------------------------------------
   * Private: Port Detection
   * -------------------------------------------------------------------------
   */

  /** Regex patterns to detect port announcements in process output. */
  static readonly #PORT_PATTERNS = [
    /(?:Local|Server|App|http):?\s*(?:running\s+(?:at|on)\s+)?https?:\/\/[^:/\s]+:(\d+)/i,
    /(?:listening|started|running)\s+(?:at|on)\s+(?:port\s+)?(\d+)/i,
    /localhost:(\d+)(?!\s+is\b)(?!.*(?:in use|already))/i,
    /0\.0\.0\.0:(\d+)(?!\s+is\b)(?!.*(?:in use|already))/i,
    /127\.0\.0\.1:(\d+)(?!\s+is\b)(?!.*(?:in use|already))/i,
    /port\s+(\d+)\b(?!\s+is\b)/i,
  ];

  /** Detect port numbers from process output and fire port events. */
  #detectPorts(output: string): void {
    const cleaned = output.replace(/\x1b\[[0-9;]*m/g, '');
    const lines = cleaned.split(/\r?\n/);

    for (const line of lines) {
      if (/\b(?:in use|already|occupied|EADDRINUSE|address already|taken)\b/i.test(line)) {
        continue;
      }

      for (const pattern of ContainerRuntime.#PORT_PATTERNS) {
        const match = line.match(pattern);

        if (match?.[1]) {
          const port = parseInt(match[1], 10);

          if (port > 0 && port < 65536 && !this.#detectedPorts.has(port)) {
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

          break;
        }
      }
    }
  }

  /*
   * -------------------------------------------------------------------------
   * Private: Port Allocation
   * -------------------------------------------------------------------------
   */

  async #findFreePort(startPort = 3000, endPort = 9000): Promise<number> {
    const { createServer } = await import('node:net');
    const hostPort = parseInt(process.env.PORT || '5173', 10);

    for (let port = startPort; port <= endPort; port++) {
      if (port === hostPort) {
        continue;
      }

      const isFree = await new Promise<boolean>((resolve) => {
        const server = createServer();

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

  #ensureBooted(): void {
    if (!this.#projectId) {
      throw new Error('Runtime not booted. Call boot(projectId) first.');
    }
  }
}

/**
 * Create a runtime provider with automatic Docker fallback.
 *
 * Attempts to use Docker container runtime. If Docker is unavailable,
 * falls back to LocalRuntime with a warning log.
 */
export async function createRuntimeWithFallback(options?: {
  projectsDir?: string;
  containerImage?: string;
  resourceLimits?: Partial<ContainerResourceLimits>;
}): Promise<RuntimeProvider> {
  const dockerAvailable = await isDockerAvailable();

  if (dockerAvailable) {
    logger.info('Docker is available — using ContainerRuntime');

    return new ContainerRuntime(options);
  }

  logger.warn('Docker is not available — falling back to LocalRuntime');

  // Dynamic import to avoid circular dependency issues at module load time
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const { LocalRuntime } = await import('./local-runtime');

  return new LocalRuntime({
    projectsDir: options?.projectsDir,
  });
}
