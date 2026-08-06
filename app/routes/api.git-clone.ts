/**
 * Server-side git clone API.
 *
 * Replaces the slow browser-side isomorphic-git clone by running
 * native `git clone --depth 1` on the server. This reduces template
 * import time from ~60 seconds to ~5 seconds for a typical repo.
 *
 * Endpoints (POST):
 *   { url, branch? }                  → clone to temp dir, return files
 *   { action: 'finalize', tempId, projectId } → move temp → project dir
 */
import type { ActionFunctionArgs } from 'react-router';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createScopedLogger } from '~/utils/logger';
import { withSecurity } from '~/lib/security';
import { successResponse, errorResponse } from '~/lib/api/responses';
import { AppError, AppErrorType } from '~/lib/api/errors';
import { AUTH_PRESETS } from '~/lib/security-config';
import { z } from 'zod';

const logger = createScopedLogger('GitClone');

/** Base directory for project workspaces. */
const PROJECTS_DIR = nodePath.join(os.homedir(), '.bolt', 'projects');

/**
 * Only allow cloning from known Git hosting domains.
 * Prevents SSRF/abuse even when running on localhost.
 */
const ALLOWED_DOMAINS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

/** Directories and files to skip when reading clone output. */
const SKIP_NAMES = new Set([
  'node_modules',
  '.git',
  '.github',
  '.vscode',
  '.idea',
  '.DS_Store',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
]);

/** File extensions to always skip (binary/large). */
const SKIP_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.avif',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
]);

/** Lock files to skip (reinstall is faster than transferring these). */
const SKIP_PATTERNS = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'npm-debug.log',
  'yarn-debug.log',
  'yarn-error.log',
];

/** Max file size to include in the response (1 MB). */
const MAX_FILE_SIZE = 1024 * 1024;

/**
 * Recursively walk a directory and return text file contents.
 */
async function walkDir(dir: string, base: string): Promise<Array<{ path: string; content: string }>> {
  const results: Array<{ path: string; content: string }> = [];
  let entries: fsSync.Dirent[];

  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (SKIP_NAMES.has(entry.name)) {
      continue;
    }

    if (SKIP_PATTERNS.includes(entry.name)) {
      continue;
    }

    const ext = nodePath.extname(entry.name).toLowerCase();

    if (SKIP_EXTENSIONS.has(ext)) {
      continue;
    }

    const fullPath = nodePath.join(dir, entry.name);

    if (entry.isDirectory()) {
      const nested = await walkDir(fullPath, base);
      results.push(...nested);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(fullPath);

        if (stat.size > MAX_FILE_SIZE) {
          continue;
        }

        const content = await fs.readFile(fullPath, 'utf-8');

        /* Quick binary detection: if the first 8 KB contains a null byte, skip. */
        if (content.slice(0, 8192).includes('\0')) {
          continue;
        }

        const relativePath = nodePath.relative(base, fullPath).replace(/\\/g, '/');
        results.push({ path: relativePath, content });
      } catch {
        /* Skip files that can't be read as UTF-8 text. */
      }
    }
  }

  return results;
}

/**
 * Validate that the given string is a safe project/temp ID.
 */
function isValidId(id: string): boolean {
  return /^[\w-]{1,64}$/.test(id);
}

const gitCloneRequestSchema = z.union([
  z.object({
    action: z.literal('finalize'),
    tempId: z.string(),
    projectId: z.string(),
  }),
  z.object({
    url: z.string(),
    branch: z.string().optional(),
  }),
]);

async function handleGitClone({ request }: ActionFunctionArgs) {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(new AppError(AppErrorType.VALIDATION, 'Invalid JSON in request body', 400));
  }

  const validatedBody = gitCloneRequestSchema.safeParse(rawBody);

  if (!validatedBody.success) {
    logger.warn('Validation failed:', validatedBody.error.flatten());

    return errorResponse(
      new AppError(AppErrorType.VALIDATION, 'Invalid request body', 400, {
        details: validatedBody.error.flatten().fieldErrors,
      }),
    );
  }

  const body = validatedBody.data;

  /*
   * ── Finalize: move temp clone → real project dir ──
   */
  if ('action' in body && body.action === 'finalize') {
    const { tempId, projectId } = body;

    if (!tempId || !isValidId(tempId) || !projectId || !isValidId(projectId)) {
      return errorResponse(new AppError(AppErrorType.VALIDATION, 'Invalid tempId or projectId', 400));
    }

    const tempDir = nodePath.join(PROJECTS_DIR, `_clone_${tempId}`);
    const projectDir = nodePath.join(PROJECTS_DIR, projectId);

    if (!fsSync.existsSync(tempDir)) {
      return errorResponse(new AppError(AppErrorType.NOT_FOUND, 'Temp clone directory not found', 404));
    }

    try {
      /* Remove existing project dir if present, then rename. */
      await fs.rm(projectDir, { recursive: true, force: true });
      await fs.rename(tempDir, projectDir);

      logger.info(`Finalized clone: _clone_${tempId} → ${projectId}`);

      return successResponse({ finalized: true });
    } catch (error) {
      logger.error('Finalize error:', error);

      return errorResponse(error instanceof Error ? error : String(error));
    }
  }

  /*
   * ── Clone: git clone → temp dir, return file listing ──
   */
  const { url, branch } = body as { url?: string; branch?: string };

  if (!url || typeof url !== 'string') {
    return errorResponse(new AppError(AppErrorType.VALIDATION, 'Missing or invalid "url"', 400));
  }

  /* Validate URL against allowed domains. */
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return errorResponse(new AppError(AppErrorType.VALIDATION, 'Invalid URL format', 400));
  }

  if (!ALLOWED_DOMAINS.has(parsed.hostname)) {
    return errorResponse(
      new AppError(
        AppErrorType.VALIDATION,
        `Domain "${parsed.hostname}" is not allowed. Allowed: ${[...ALLOWED_DOMAINS].join(', ')}`,
        400,
      ),
    );
  }

  const tempId = randomUUID().slice(0, 8);
  const tempDir = nodePath.join(PROJECTS_DIR, `_clone_${tempId}`);

  try {
    await fs.mkdir(tempDir, { recursive: true });

    /* Build git clone args — use execFileSync to avoid shell injection. */
    const args = ['clone', '--depth', '1'];

    if (branch) {
      args.push('-b', branch);
    }

    args.push(url, tempDir);

    logger.info(`Cloning ${url}${branch ? ` (branch: ${branch})` : ''} → _clone_${tempId}`);

    execFileSync('git', args, {
      timeout: 60_000,
      stdio: 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    /* Read all text files from the clone. */
    const files = await walkDir(tempDir, tempDir);

    logger.info(`Clone complete: ${files.length} files read from ${url}`);

    return successResponse({ tempId, files });
  } catch (error) {
    /* Clean up on failure. */
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
      /* intentionally swallow cleanup errors */
    });

    const message = error instanceof Error ? error.message : 'Clone failed';
    logger.error('Git clone error:', message);

    return errorResponse(error instanceof Error ? error : String(error));
  }
}

export const action = withSecurity(handleGitClone, { auth: AUTH_PRESETS.authenticated });
