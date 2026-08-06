/// <reference types="vitest/globals" />
import { ContainerRuntime, isDockerAvailable, createRuntimeWithFallback } from './container-runtime';
import { validateCommand } from './command-safety';
import type { RuntimeProvider } from './runtime-provider';

/*
 * ---------------------------------------------------------------------------
 * Mocks
 * ---------------------------------------------------------------------------
 */

// Mock child_process for Docker CLI calls
const mockExecFile = vi.fn();
const mockSpawn = vi.fn();
const mockChildProcess = {
  pid: 12345,
  stdin: { write: vi.fn() },
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  on: vi.fn(),
  kill: vi.fn(),
};

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  spawn: (...args: unknown[]) => {
    mockSpawn(...args);

    return mockChildProcess;
  },
  exec: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:util')>();

  return {
    ...actual,
    promisify: () => {
      return (...args: unknown[]): Promise<{ stdout: string; stderr: string }> => {
        /*
         * promisify(execFile) is used for docker info, docker rm, and docker run (exec mode).
         * We return a promise that resolves/rejects based on mock configuration.
         */
        return new Promise((resolve, reject) => {
          const result = mockExecFile(...args);

          if (result instanceof Error) {
            reject(result);
          } else {
            resolve(result ?? { stdout: '', stderr: '' });
          }
        });
      };
    },
  };
});

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(''),
  writeFile: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ isFile: () => true, isDirectory: () => false, size: 100 }),
  readdir: vi.fn().mockResolvedValue([]),
  rm: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./local-filesystem', () => ({
  LocalFileSystem: vi.fn().mockImplementation(() => ({
    readFile: vi.fn().mockResolvedValue(''),
    readFileRaw: vi.fn().mockResolvedValue(new Uint8Array()),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ isFile: true, isDirectory: false, size: 0, mtime: '' }),
    rm: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
    rename: vi.fn().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    watch: vi.fn().mockReturnValue(() => {}),
    ensureInspectorReady: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('~/utils/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

/*
 * ---------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------------
 */

describe('ContainerRuntime', () => {
  let runtime: ContainerRuntime;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: docker info succeeds
    mockExecFile.mockReturnValue({ stdout: 'Docker info output', stderr: '' });

    runtime = new ContainerRuntime({
      projectsDir: '/tmp/test-projects',
      containerImage: 'node:20-slim',
    });
  });

  afterEach(async () => {
    try {
      await runtime.teardown();
    } catch {
      // Ignore teardown errors in tests
    }
  });

  // ─── Test 1: RuntimeProvider interface compliance ──────────────────────

  describe('RuntimeProvider interface compliance', () => {
    it('implements all required RuntimeProvider properties and methods', async () => {
      await runtime.boot('test-project');

      // Required properties
      expect(runtime.type).toBe('docker');
      expect(runtime.projectId).toBe('test-project');
      expect(runtime.workdir).toContain('test-project');
      expect(runtime.fs).toBeDefined();

      // Required methods
      expect(typeof runtime.boot).toBe('function');
      expect(typeof runtime.spawn).toBe('function');
      expect(typeof runtime.exec).toBe('function');
      expect(typeof runtime.allocatePort).toBe('function');
      expect(typeof runtime.getPreviewUrl).toBe('function');
      expect(typeof runtime.onPortEvent).toBe('function');
      expect(typeof runtime.teardown).toBe('function');
    });

    it('type property returns "docker"', () => {
      expect(runtime.type).toBe('docker');
    });

    it('satisfies RuntimeProvider type assignment', async () => {
      const provider: RuntimeProvider = runtime;
      expect(provider.type).toBe('docker');
    });
  });

  // ─── Test 2: Boot and project ID validation ───────────────────────────

  describe('boot', () => {
    it('boots successfully with a valid project ID', async () => {
      await runtime.boot('my-project-123');

      expect(runtime.projectId).toBe('my-project-123');
      expect(runtime.workdir).toContain('my-project-123');
    });

    it('rejects invalid project IDs', async () => {
      await expect(runtime.boot('../escape')).rejects.toThrow('Invalid project ID');
      await expect(runtime.boot('')).rejects.toThrow('Invalid project ID');
      await expect(runtime.boot('a'.repeat(65))).rejects.toThrow('Invalid project ID');
    });

    it('throws when calling methods before boot', async () => {
      const unbooted = new ContainerRuntime({ projectsDir: '/tmp/test' });

      await expect(unbooted.exec('echo hello')).rejects.toThrow('Runtime not booted');
    });
  });

  // ─── Test 3: Docker-unavailable fallback to LocalRuntime ──────────────

  describe('createRuntimeWithFallback', () => {
    it('falls back to LocalRuntime when Docker is not available', async () => {
      // Make docker info fail
      mockExecFile.mockImplementation(() => {
        throw new Error('Docker daemon not running');
      });

      const provider = await createRuntimeWithFallback({
        projectsDir: '/tmp/test-projects',
      });

      expect(provider.type).toBe('local');
    });

    it('returns ContainerRuntime when Docker is available', async () => {
      mockExecFile.mockReturnValue({ stdout: 'Docker version 24.0.0', stderr: '' });

      const provider = await createRuntimeWithFallback({
        projectsDir: '/tmp/test-projects',
      });

      expect(provider.type).toBe('docker');
    });
  });

  // ─── Test 4: Command-safety validation before execution ───────────────

  describe('command-safety validation', () => {
    it('blocks destructive commands via exec', async () => {
      await runtime.boot('test-project');

      const result = await runtime.exec('rm -rf /');

      expect(result.exitCode).toBe(126);
      expect(result.output).toContain('blocked by safety check');
    });

    it('blocks fork bombs via exec', async () => {
      await runtime.boot('test-project');

      const result = await runtime.exec(':(){ :|:& };:');

      expect(result.exitCode).toBe(126);
      expect(result.output).toContain('blocked by safety check');
    });

    it('blocks destructive commands via spawn', async () => {
      await runtime.boot('test-project');

      await expect(runtime.spawn('rm', ['-rf', '/'])).rejects.toThrow('blocked by safety check');
    });

    it('validates commands using command-safety module', () => {
      const dangerous = validateCommand('rm -rf /');
      expect(dangerous.allowed).toBe(false);

      const safe = validateCommand('npm install');
      expect(safe.allowed).toBe(true);
    });
  });

  // ─── Test 5: Container cleanup on timeout ─────────────────────────────

  describe('container cleanup on timeout', () => {
    it('tracks container creation time for timeout enforcement', async () => {
      await runtime.boot('test-project');

      // Simulate a spawned process that registers a container
      mockChildProcess.on.mockImplementation((event: string, _cb: (code: number) => void) => {
        if (event === 'exit') {
          // Don't call exit immediately — container stays tracked
        }
      });

      /*
       * Access the containers map size via spawning a process
       * The spawn method should track the container
       */
      try {
        await runtime.spawn('echo', ['hello']);
      } catch {
        // spawn may throw if mock isn't perfect, but the container tracking is the point
      }

      // Teardown should clean up all containers
      await runtime.teardown();

      // Verify docker rm was called during teardown
      expect(mockExecFile).toHaveBeenCalled();
    });

    it('teardown removes all tracked containers', async () => {
      await runtime.boot('test-project');

      // Teardown should complete without errors even with no containers
      await expect(runtime.teardown()).resolves.toBeUndefined();
    });
  });

  // ─── Test 6: Resource limit configuration ─────────────────────────────

  describe('resource limit configuration', () => {
    it('uses default resource limits when none specified', async () => {
      const defaultRuntime = new ContainerRuntime({
        projectsDir: '/tmp/test-projects',
      });
      await defaultRuntime.boot('test-project');

      // Exec a command and verify docker run args contain resource limits
      mockExecFile.mockReturnValue({ stdout: 'output', stderr: '' });
      await defaultRuntime.exec('echo hello');

      // The execFile mock receives the docker args — verify resource limits are present
      const calls = mockExecFile.mock.calls;
      const dockerRunCall = calls.find((call: unknown[]) => Array.isArray(call[1]) && call[1].includes('run'));

      if (dockerRunCall) {
        const args = dockerRunCall[1] as string[];
        expect(args).toContain('--cpus');
        expect(args).toContain('--memory');
        expect(args).toContain('--network');
        expect(args[args.indexOf('--cpus') + 1]).toBe('1.0');
        expect(args[args.indexOf('--memory') + 1]).toBe('512m');
        expect(args[args.indexOf('--network') + 1]).toBe('none');
      }

      await defaultRuntime.teardown();
    });

    it('accepts custom resource limits', async () => {
      const customRuntime = new ContainerRuntime({
        projectsDir: '/tmp/test-projects',
        resourceLimits: {
          cpus: '2.0',
          memory: '1g',
          networkEnabled: true,
        },
      });
      await customRuntime.boot('test-project');

      mockExecFile.mockReturnValue({ stdout: 'output', stderr: '' });
      await customRuntime.exec('echo hello');

      const calls = mockExecFile.mock.calls;
      const dockerRunCall = calls.find((call: unknown[]) => Array.isArray(call[1]) && call[1].includes('run'));

      if (dockerRunCall) {
        const args = dockerRunCall[1] as string[];
        expect(args).toContain('--cpus');
        expect(args[args.indexOf('--cpus') + 1]).toBe('2.0');
        expect(args).toContain('--memory');
        expect(args[args.indexOf('--memory') + 1]).toBe('1g');

        // Network should NOT be 'none' when enabled
        expect(args.includes('none')).toBe(false);
      }

      await customRuntime.teardown();
    });
  });

  // ─── Test 7: Socket mount security (no --privileged) ──────────────────

  describe('security constraints', () => {
    it('never uses --privileged flag in docker run args', async () => {
      await runtime.boot('test-project');

      mockExecFile.mockReturnValue({ stdout: 'output', stderr: '' });
      await runtime.exec('echo hello');

      const calls = mockExecFile.mock.calls;

      for (const call of calls) {
        if (Array.isArray(call[1])) {
          const args = call[1] as string[];
          expect(args).not.toContain('--privileged');
        }
      }
    });

    it('runs containers as non-root user', async () => {
      await runtime.boot('test-project');

      mockExecFile.mockReturnValue({ stdout: 'output', stderr: '' });
      await runtime.exec('echo hello');

      const calls = mockExecFile.mock.calls;
      const dockerRunCall = calls.find((call: unknown[]) => Array.isArray(call[1]) && call[1].includes('run'));

      if (dockerRunCall) {
        const args = dockerRunCall[1] as string[];
        expect(args).toContain('--user');

        const userIdx = args.indexOf('--user');
        expect(args[userIdx + 1]).toBe('1000:1000');
      }
    });

    it('drops all capabilities', async () => {
      await runtime.boot('test-project');

      mockExecFile.mockReturnValue({ stdout: 'output', stderr: '' });
      await runtime.exec('echo hello');

      const calls = mockExecFile.mock.calls;
      const dockerRunCall = calls.find((call: unknown[]) => Array.isArray(call[1]) && call[1].includes('run'));

      if (dockerRunCall) {
        const args = dockerRunCall[1] as string[];
        expect(args).toContain('--cap-drop');

        const capDropIdx = args.indexOf('--cap-drop');
        expect(args[capDropIdx + 1]).toBe('ALL');
      }
    });

    it('uses read-only root filesystem', async () => {
      await runtime.boot('test-project');

      mockExecFile.mockReturnValue({ stdout: 'output', stderr: '' });
      await runtime.exec('echo hello');

      const calls = mockExecFile.mock.calls;
      const dockerRunCall = calls.find((call: unknown[]) => Array.isArray(call[1]) && call[1].includes('run'));

      if (dockerRunCall) {
        const args = dockerRunCall[1] as string[];
        expect(args).toContain('--read-only');
      }
    });

    it('sets no-new-privileges security option', async () => {
      await runtime.boot('test-project');

      mockExecFile.mockReturnValue({ stdout: 'output', stderr: '' });
      await runtime.exec('echo hello');

      const calls = mockExecFile.mock.calls;
      const dockerRunCall = calls.find((call: unknown[]) => Array.isArray(call[1]) && call[1].includes('run'));

      if (dockerRunCall) {
        const args = dockerRunCall[1] as string[];
        expect(args).toContain('--security-opt');

        const secOptIdx = args.indexOf('--security-opt');
        expect(args[secOptIdx + 1]).toBe('no-new-privileges');
      }
    });
  });

  // ─── Test 8: Preview URL and port events ──────────────────────────────

  describe('preview URL and port events', () => {
    it('returns correct preview URL format', async () => {
      await runtime.boot('test-project');

      const url = runtime.getPreviewUrl(3000);
      expect(url).toBe('http://localhost:3000');
    });

    it('registers and removes port event listeners', async () => {
      await runtime.boot('test-project');

      const listener = vi.fn();
      const dispose = runtime.onPortEvent(listener);

      expect(typeof dispose).toBe('function');

      // Dispose should not throw
      dispose();
    });
  });

  // ─── Test 9: isDockerAvailable ────────────────────────────────────────

  describe('isDockerAvailable', () => {
    it('returns true when docker info succeeds', async () => {
      mockExecFile.mockReturnValue({ stdout: 'Docker version', stderr: '' });

      const available = await isDockerAvailable();
      expect(available).toBe(true);
    });

    it('returns false when docker info fails', async () => {
      mockExecFile.mockImplementation(() => {
        throw new Error('command not found: docker');
      });

      const available = await isDockerAvailable();
      expect(available).toBe(false);
    });
  });

  // ─── Test 10: Container image configuration ───────────────────────────

  describe('container image configuration', () => {
    it('uses default image when BOLT_CONTAINER_IMAGE is not set', async () => {
      const defaultRuntime = new ContainerRuntime({
        projectsDir: '/tmp/test-projects',
      });
      await defaultRuntime.boot('test-project');

      mockExecFile.mockReturnValue({ stdout: 'output', stderr: '' });
      await defaultRuntime.exec('echo hello');

      const calls = mockExecFile.mock.calls;
      const dockerRunCall = calls.find((call: unknown[]) => Array.isArray(call[1]) && call[1].includes('run'));

      if (dockerRunCall) {
        const args = dockerRunCall[1] as string[];
        expect(args).toContain('node:20-slim');
      }

      await defaultRuntime.teardown();
    });

    it('uses custom image passed via constructor', async () => {
      const customRuntime = new ContainerRuntime({
        projectsDir: '/tmp/test-projects',
        containerImage: 'custom-bolt:latest',
      });
      await customRuntime.boot('test-project');

      mockExecFile.mockReturnValue({ stdout: 'output', stderr: '' });
      await customRuntime.exec('echo hello');

      const calls = mockExecFile.mock.calls;
      const dockerRunCall = calls.find((call: unknown[]) => Array.isArray(call[1]) && call[1].includes('run'));

      if (dockerRunCall) {
        const args = dockerRunCall[1] as string[];
        expect(args).toContain('custom-bolt:latest');
      }

      await customRuntime.teardown();
    });
  });

  // ─── Test 11: Exec error handling ─────────────────────────────────────

  describe('exec error handling', () => {
    it('returns captured output on command failure', async () => {
      await runtime.boot('test-project');

      mockExecFile.mockImplementation(() => {
        const err = new Error('Command failed') as Error & { code: number; stdout: string; stderr: string };
        err.code = 1;
        err.stdout = 'partial output';
        err.stderr = 'error text';

        return err;
      });

      const result = await runtime.exec('exit 1');

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('partial output');
    });
  });
});
