/**
 * @route /api/runtime/search
 * Server-side API route for full-text search across project files.
 *
 * Replaces the WebContainer internal.textSearch() private API with a
 * server-side implementation using fast-glob for file discovery and
 * line-by-line text matching.
 *
 * POST body: projectId, query, includes, excludes,
 * caseSensitive, isRegex, isWordMatch, resultLimit
 */

import type { ActionFunctionArgs } from 'react-router';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import fg from 'fast-glob';
import { RuntimeManager } from '~/lib/runtime/local-runtime';
import { withSecurity } from '~/lib/security';
import { searchRequestSchema, validateInput } from '~/lib/api/schemas';
import { successResponse, errorResponse } from '~/lib/api/responses';
import { AppError, AppErrorType } from '~/lib/api/errors';
import { AUTH_PRESETS } from '~/lib/security-config';
import { WORK_DIR } from '~/utils/constants';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('RuntimeSearch');

/** A single search match with file path, line, and preview context. */
interface SearchMatch {
  path: string;
  lineNumber: number;
  previewText: string;
  matchCharStart: number;
  matchCharEnd: number;
}

/** Default patterns to exclude from search. */
const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/*.lock',
  '**/package-lock.json',
  '**/.next/**',
  '**/.nuxt/**',
  '**/coverage/**',
  '**/.cache/**',
  '**/.dart_tool/**',
];

/** Maximum file size to search (1 MB). Skip binary / large files. */
const MAX_FILE_SIZE = 1_048_576;

/**
 * Check whether a file is likely binary by reading the first 512 bytes
 * and scanning for null bytes.
 */
function isBinaryContent(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, 512);

  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }

  return false;
}

/**
 * Build a RegExp from the user's search query, respecting options.
 */
function buildSearchPattern(query: string, caseSensitive: boolean, isRegex: boolean, isWordMatch: boolean): RegExp {
  let pattern = isRegex ? query : escapeRegExp(query);

  if (isWordMatch) {
    pattern = `\\b${pattern}\\b`;
  }

  const flags = caseSensitive ? 'g' : 'gi';

  return new RegExp(pattern, flags);
}

/** Escape special regex characters for literal matching. */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Search a single file for matches and return them.
 */
async function searchFile(
  filePath: string,
  relativePath: string,
  regex: RegExp,
  resultLimit: number,
  currentCount: number,
): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = [];

  try {
    const stat = await fs.stat(filePath);

    /* Skip files exceeding size limit */
    if (stat.size > MAX_FILE_SIZE || stat.size === 0) {
      return matches;
    }

    const buffer = await fs.readFile(filePath);

    /* Skip binary files */
    if (isBinaryContent(buffer)) {
      return matches;
    }

    const content = buffer.toString('utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (currentCount + matches.length >= resultLimit) {
        break;
      }

      const line = lines[i];

      /* Reset lastIndex for global regex on each line */
      regex.lastIndex = 0;

      let match: RegExpExecArray | null;

      while ((match = regex.exec(line)) !== null) {
        if (currentCount + matches.length >= resultLimit) {
          break;
        }

        matches.push({
          path: relativePath,
          lineNumber: i + 1,
          previewText: line,
          matchCharStart: match.index,
          matchCharEnd: match.index + match[0].length,
        });

        /* Prevent infinite loop on zero-width matches */
        if (match[0].length === 0) {
          regex.lastIndex++;
        }
      }
    }
  } catch {
    /* Skip unreadable files silently */
  }

  return matches;
}

/*
 * ---------------------------------------------------------------------------
 * POST — Text search
 * ---------------------------------------------------------------------------
 */

async function searchAction({ request }: ActionFunctionArgs) {
  const validation = await validateInput(request, searchRequestSchema);

  if (!validation.success) {
    return errorResponse(validation.error);
  }

  const {
    projectId,
    query,
    includes = ['**/*.*'],
    excludes = DEFAULT_EXCLUDES,
    caseSensitive = false,
    isRegex = false,
    isWordMatch = false,
    resultLimit = 500,
  } = validation.data;

  /* Cap result limit to a sensible maximum */
  const cappedLimit = Math.min(resultLimit, 5000);

  let regex: RegExp;

  try {
    regex = buildSearchPattern(query, caseSensitive, isRegex, isWordMatch);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid regex';
    return errorResponse(new AppError(AppErrorType.VALIDATION, `Invalid search pattern: ${message}`));
  }

  const manager = RuntimeManager.getInstance();
  const runtime = await manager.getRuntime(projectId);

  /* Resolve project root from the runtime's workdir */
  const projectRoot = runtime.workdir;

  try {
    /* Use fast-glob to discover files matching the include/exclude patterns */
    const files = await fg(includes, {
      cwd: projectRoot,
      ignore: excludes,
      dot: false,
      onlyFiles: true,
      absolute: false,
      followSymbolicLinks: false,
    });

    const allMatches: SearchMatch[] = [];

    for (const relPath of files) {
      if (allMatches.length >= cappedLimit) {
        break;
      }

      const absPath = nodePath.join(projectRoot, relPath);

      /* Prefix relative path with WORK_DIR for store compatibility */
      const storePath = `${WORK_DIR}/${relPath}`;
      const fileMatches = await searchFile(absPath, storePath, regex, cappedLimit, allMatches.length);
      allMatches.push(...fileMatches);
    }

    return successResponse({ results: allMatches });
  } catch (error) {
    logger.error(`Text search failed for project "${projectId}":`, error);

    return errorResponse(error instanceof Error ? error : 'Search failed');
  }
}

/*
 * ---------------------------------------------------------------------------
 * Exports (wrapped with security middleware)
 * ---------------------------------------------------------------------------
 */

export const action = withSecurity(searchAction, { auth: AUTH_PRESETS.authenticated, rateLimit: false });
