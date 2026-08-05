import { describe, expect, it } from 'vitest';
import { isEnvFile, shouldUseCodeMirrorForFile } from './monaco-file-support';

describe('isEnvFile', () => {
  it('detects .env and .env.* files anywhere in the tree', () => {
    expect(isEnvFile('/home/project/.env')).toBe(true);
    expect(isEnvFile('/home/project/config/.env.production')).toBe(true);
    expect(isEnvFile('.env.local')).toBe(true);
  });

  it('does not flag files that merely contain .env in their path', () => {
    expect(isEnvFile('/home/project/.envrc-docs/readme.md')).toBe(false);
    expect(isEnvFile('/home/project/src/environment.ts')).toBe(false);
  });
});

describe('shouldUseCodeMirrorForFile', () => {
  it('falls back to CodeMirror for env files and CodeMirror-only languages', () => {
    expect(shouldUseCodeMirrorForFile('/home/project/.env')).toBe(true);
    expect(shouldUseCodeMirrorForFile('/home/project/src/App.vue')).toBe(true);
    expect(shouldUseCodeMirrorForFile('/home/project/module.wat')).toBe(true);
  });

  it('keeps Monaco for everything else, including extensionless files', () => {
    expect(shouldUseCodeMirrorForFile('/home/project/src/App.tsx')).toBe(false);
    expect(shouldUseCodeMirrorForFile('/home/project/src/main.py')).toBe(false);
    expect(shouldUseCodeMirrorForFile('/home/project/Dockerfile')).toBe(false);
    expect(shouldUseCodeMirrorForFile('/home/project/README.md')).toBe(false);
  });
});
