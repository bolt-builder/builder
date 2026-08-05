// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { applyActions, toProjectRelativePath, type AgentRuntime } from './action-applier';
import type { DevonzAction } from '~/types/actions';

function makeFakeRuntime(files: Record<string, string> = {}): AgentRuntime & {
  files: Record<string, string>;
  execCalls: string[];
} {
  const execCalls: string[] = [];

  return {
    files,
    execCalls,
    fs: {
      writeFile: vi.fn(async (path: string, content: string | Uint8Array) => {
        files[path] = content.toString();
      }),
      readFile: vi.fn(async (path: string) => {
        if (!(path in files)) {
          throw new Error(`ENOENT: ${path}`);
        }

        return files[path];
      }),
    },
    exec: vi.fn(async (command: string) => {
      execCalls.push(command);

      return command.includes('failme') ? { exitCode: 1, output: 'boom' } : { exitCode: 0, output: 'ok' };
    }),
  };
}

describe('toProjectRelativePath', () => {
  it('strips the WORK_DIR prefix and leading slashes', () => {
    expect(toProjectRelativePath('/home/project/src/index.ts')).toBe('src/index.ts');
    expect(toProjectRelativePath('src/index.ts')).toBe('src/index.ts');
    expect(toProjectRelativePath('/etc/passwd')).toBe('etc/passwd');
  });

  it('rejects the project root and empty paths', () => {
    expect(() => toProjectRelativePath('/home/project')).toThrow();
    expect(() => toProjectRelativePath('///')).toThrow();
  });
});

describe('applyActions', () => {
  it('writes file actions with normalized paths', async () => {
    const runtime = makeFakeRuntime();

    const results = await applyActions(runtime, 'proj-1', [
      { type: 'file', filePath: '/home/project/src/app.ts', content: 'console.log(1);' } as DevonzAction,
    ]);

    expect(results).toEqual([{ type: 'file', target: 'src/app.ts', status: 'applied' }]);
    expect(runtime.files['src/app.ts']).toBe('console.log(1);');
  });

  it('applies diff actions and reports failed blocks', async () => {
    const runtime = makeFakeRuntime({ 'a.txt': 'hello world' });

    const results = await applyActions(runtime, 'proj-1', [
      {
        type: 'diff',
        filePath: '/home/project/a.txt',
        content: '',
        diffBlocks: [{ search: 'hello', replace: 'goodbye' }],
      } as DevonzAction,
      {
        type: 'diff',
        filePath: '/home/project/a.txt',
        content: '',
        diffBlocks: [{ search: 'no-such-text-anywhere', replace: 'x' }],
      } as DevonzAction,
    ]);

    expect(results[0].status).toBe('applied');
    expect(runtime.files['a.txt']).toBe('goodbye world');
    expect(results[1].status).toBe('failed');
  });

  it('executes safe shell actions and reports non-zero exits as failed', async () => {
    const runtime = makeFakeRuntime();

    const results = await applyActions(runtime, 'proj-1', [
      { type: 'shell', content: 'npm install' } as DevonzAction,
      { type: 'shell', content: 'failme now' } as DevonzAction,
    ]);

    expect(results[0].status).toBe('applied');
    expect(results[1].status).toBe('failed');
    expect(runtime.execCalls).toEqual(['npm install', 'failme now']);
  });

  it('skips blocked commands without executing them', async () => {
    const runtime = makeFakeRuntime();

    const results = await applyActions(runtime, 'proj-1', [{ type: 'shell', content: 'rm -rf /' } as DevonzAction]);

    expect(results[0].status).toBe('skipped');
    expect(runtime.execCalls).toEqual([]);
  });

  it('skips start actions and unsupported action types', async () => {
    const runtime = makeFakeRuntime();

    const results = await applyActions(runtime, 'proj-1', [
      { type: 'start', content: 'npm run dev' } as DevonzAction,
      { type: 'supabase', operation: 'query', content: 'select 1' } as DevonzAction,
    ]);

    expect(results.map((r) => r.status)).toEqual(['skipped', 'skipped']);
  });

  it('continues past individual action errors', async () => {
    const runtime = makeFakeRuntime();

    const results = await applyActions(runtime, 'proj-1', [
      { type: 'diff', filePath: '/home/project/missing.txt', content: '', diffBlocks: [] } as DevonzAction,
      { type: 'file', filePath: '/home/project/ok.txt', content: 'fine' } as DevonzAction,
    ]);

    expect(results[0].status).toBe('failed');
    expect(results[1].status).toBe('applied');
    expect(runtime.files['ok.txt']).toBe('fine');
  });
});
