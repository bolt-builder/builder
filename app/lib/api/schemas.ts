/**
 * @module schemas
 * Shared Zod validation schemas for API routes.
 *
 * Centralizes request validation to ensure consistency across routes
 * and prevent silent failures from malformed requests.
 */

import { z } from 'zod';
import { AppError, AppErrorType } from './errors';

/*
 * ---------------------------------------------------------------------------
 * LLM / Provider schemas
 * ---------------------------------------------------------------------------
 */

/** Shared schema for LLM provider objects sent from the client. */
export const providerSchema = z.object({
  name: z.string().min(1, 'Provider name is required'),
  staticModels: z.array(z.any()).optional(),
  getApiKeyLink: z.string().optional(),
  labelForGetApiKey: z.string().optional(),
  icon: z.string().optional(),
});

/*
 * ---------------------------------------------------------------------------
 * Runtime schemas
 * ---------------------------------------------------------------------------
 */

/** Valid project ID: alphanumeric, hyphens, underscores, 1-64 chars. */
export const projectIdSchema = z
  .string()
  .min(1, 'projectId is required')
  .max(64, 'projectId must be at most 64 characters')
  .regex(/^[\w-]+$/, 'projectId must be alphanumeric with hyphens/underscores');

/** Safe relative path (no traversal). */
export const safePathSchema = z
  .string()
  .min(1, 'path is required')
  .refine((p) => !p.includes('..') && !p.startsWith('/'), {
    message: 'Path traversal detected',
  });

/** Schema for POST /api/runtime/exec operations. */
export const execRequestSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('boot'),
    projectId: projectIdSchema,
  }),
  z.object({
    op: z.literal('exec'),
    projectId: projectIdSchema,
    command: z.string().min(1, 'command is required'),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    timeout: z.number().int().positive().optional(),
  }),
  z.object({
    op: z.literal('teardown'),
    projectId: projectIdSchema,
  }),
  z.object({
    op: z.literal('allocatePort'),
    projectId: projectIdSchema,
  }),
]);

/** Schema for POST /api/runtime/fs operations. */
export const fsWriteRequestSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('writeFile').default('writeFile'),
    projectId: projectIdSchema,
    path: safePathSchema,
    content: z.string(),
    binary: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('mkdir'),
    projectId: projectIdSchema,
    path: safePathSchema,
    recursive: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('rm'),
    projectId: projectIdSchema,
    path: safePathSchema,
    recursive: z.boolean().optional(),
    force: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('rename'),
    projectId: projectIdSchema,
    oldPath: safePathSchema,
    newPath: safePathSchema,
  }),
]);

/** Schema for POST /api/runtime/terminal operations. */
export const terminalRequestSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('spawn'),
    projectId: projectIdSchema,
    command: z.string().optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
    env: z.record(z.string()).optional(),
    cwd: z.string().optional(),
  }),
  z.object({
    op: z.literal('write'),
    sessionId: z.string().min(1, 'sessionId is required'),
    data: z.string(),
  }),
  z.object({
    op: z.literal('resize'),
    sessionId: z.string().min(1, 'sessionId is required'),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({
    op: z.literal('kill'),
    sessionId: z.string().min(1, 'sessionId is required'),
    signal: z.string().optional(),
  }),
  z.object({
    op: z.literal('list'),
    projectId: projectIdSchema,
  }),
]);

const browserSessionIdSchema = z.string().min(1, 'sessionId is required');

/** Schema for POST /api/browser operations (embedded real-browser sessions). */
export const browserRequestSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }),
  z.object({
    op: z.literal('navigate'),
    sessionId: browserSessionIdSchema,
    url: z.string().url(),
  }),
  z.object({ op: z.literal('back'), sessionId: browserSessionIdSchema }),
  z.object({ op: z.literal('forward'), sessionId: browserSessionIdSchema }),
  z.object({ op: z.literal('reload'), sessionId: browserSessionIdSchema }),
  z.object({
    op: z.literal('mouse'),
    sessionId: browserSessionIdSchema,
    event: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('move'), x: z.number(), y: z.number() }),
      z.object({
        kind: z.literal('down'),
        x: z.number(),
        y: z.number(),
        button: z.enum(['left', 'middle', 'right']),
        clickCount: z.number().int().min(1).max(3),
      }),
      z.object({
        kind: z.literal('up'),
        x: z.number(),
        y: z.number(),
        button: z.enum(['left', 'middle', 'right']),
      }),
      z.object({
        kind: z.literal('wheel'),
        x: z.number(),
        y: z.number(),
        deltaX: z.number(),
        deltaY: z.number(),
      }),
    ]),
  }),
  z.object({
    op: z.literal('key'),
    sessionId: browserSessionIdSchema,
    event: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('down'), key: z.string().min(1).max(32) }),
      z.object({ kind: z.literal('up'), key: z.string().min(1).max(32) }),
      z.object({ kind: z.literal('insertText'), text: z.string().max(4096) }),
    ]),
  }),
  z.object({
    op: z.literal('resize'),
    sessionId: browserSessionIdSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({ op: z.literal('close'), sessionId: browserSessionIdSchema }),
]);

/** Schema for POST /api/runtime/search. */
export const searchRequestSchema = z.object({
  projectId: projectIdSchema,
  query: z.string().min(1, 'query is required'),
  includes: z.array(z.string()).optional(),
  excludes: z.array(z.string()).optional(),
  caseSensitive: z.boolean().optional(),
  isRegex: z.boolean().optional(),
  isWordMatch: z.boolean().optional(),
  resultLimit: z.number().int().positive().max(5000).optional(),
});

/** SHA string for git operations. */
const shaSchema = z.string().min(1, 'SHA is required');

/** Schema for POST /api/runtime/git operations. */
export const gitRequestSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('commit'),
    projectId: projectIdSchema,
    message: z.string().min(1, 'Commit message is required'),
  }),
  z.object({ op: z.literal('log'), projectId: projectIdSchema, maxCount: z.number().int().positive().optional() }),
  z.object({ op: z.literal('checkout'), projectId: projectIdSchema, sha: shaSchema }),
  z.object({ op: z.literal('checkout-main'), projectId: projectIdSchema }),
  z.object({ op: z.literal('diff'), projectId: projectIdSchema, sha: shaSchema }),
  z.object({ op: z.literal('commit-files'), projectId: projectIdSchema, sha: shaSchema }),
  z.object({ op: z.literal('commit-files-status'), projectId: projectIdSchema, sha: shaSchema }),
  z.object({
    op: z.literal('file-diff'),
    projectId: projectIdSchema,
    sha: shaSchema,
    file: z.string().min(1, 'File path is required'),
  }),
  z.object({ op: z.literal('commit-diff'), projectId: projectIdSchema, sha: shaSchema }),
  z.object({ op: z.literal('archive'), projectId: projectIdSchema, sha: shaSchema, type: z.string().optional() }),
]);

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Parse a Zod schema and return a standardized 400 error Response on failure.
 * Returns the validated data on success or a Response on failure.
 */
export function parseOrError<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  _loggerName?: string,
): { success: true; data: T } | { success: false; response: Response } {
  const result = schema.safeParse(data);

  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));

    return {
      success: false,
      response: new Response(
        JSON.stringify({
          error: 'Invalid request',
          details,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    };
  }

  return { success: true, data: result.data };
}

/** Default maximum request body size in bytes (1 MB). */
const DEFAULT_MAX_BODY_SIZE = 1_048_576;

/** Options accepted by {@link validateInput}. */
export interface ValidateInputOptions {
  /** Maximum allowed body size in bytes. Defaults to 1 MB. */
  maxBodySize?: number;
}

/** Successful validation result containing the typed data. */
export interface ValidationSuccess<T> {
  success: true;
  data: T;
}

/** Failed validation result containing the structured error. */
export interface ValidationFailure {
  success: false;
  error: AppError;
}

/** Discriminated union returned by {@link validateInput}. */
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

/**
 * Centralized input validation helper.
 *
 * Reads the request body as JSON, enforces a size limit, validates it against
 * the given Zod schema, and returns a typed discriminated union. Never throws —
 * all failures are surfaced through the `{ success: false, error }` branch.
 */
export async function validateInput<T>(
  request: Request,
  schema: z.ZodSchema<T>,
  options?: ValidateInputOptions,
): Promise<ValidationResult<T>> {
  const maxBodySize = options?.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;

  // --- 1. Read body text and enforce size limit --------------------------------
  let bodyText: string;

  try {
    bodyText = await request.text();
  } catch {
    return {
      success: false,
      error: new AppError(AppErrorType.VALIDATION, 'Failed to read request body', 400),
    };
  }

  if (bodyText.length > maxBodySize) {
    return {
      success: false,
      error: new AppError(AppErrorType.VALIDATION, `Request body exceeds maximum size of ${maxBodySize} bytes`, 413, {
        maxBodySize,
        receivedSize: bodyText.length,
      }),
    };
  }

  // --- 2. Parse JSON -----------------------------------------------------------
  let body: unknown;

  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      success: false,
      error: new AppError(AppErrorType.VALIDATION, 'Invalid JSON in request body', 400),
    };
  }

  // --- 3. Validate against Zod schema ------------------------------------------
  const result = schema.safeParse(body);

  if (!result.success) {
    const fieldErrors = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));

    return {
      success: false,
      error: new AppError(AppErrorType.VALIDATION, 'Request validation failed', 400, {
        fields: fieldErrors,
      }),
    };
  }

  return { success: true, data: result.data };
}
