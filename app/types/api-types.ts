/**
 * Centralized API Types
 *
 * Single source of truth for all API request/response types used by
 * route handlers and client-side fetch calls. Follows the vibesdk
 * pattern from vibesdk/src/api-types.ts.
 *
 * Domain-specific types (ModelInfo, ProviderInfo) remain in their
 * respective modules — this file only defines API transport shapes.
 *
 * @module types/api-types
 */

import { z } from 'zod';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { ProviderInfo } from '~/types/model';
import { OPERATION_TYPES } from '~/lib/.server/llm/model-router';

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * Common API Response Types
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Standard error response schema for all API routes */
export const apiErrorResponseSchema = z.object({
  error: z.string(),
  details: z
    .array(
      z.object({
        path: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});

/** Standard error response type for all API routes */
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/** Generic success response wrapper */
export interface ApiSuccessResponse<T = unknown> {
  data: T;
}

/** Generic paginated response wrapper */
export interface PaginatedResponse<T = unknown> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * Chat API Types
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Zod schema for individual chat message */
const chatMessageSchema = z
  .object({
    id: z.string().optional(),
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
  })
  .passthrough(); // Preserve 'parts' and other AI SDK fields for MCP tool invocations

/** Zod schema for design scheme in chat requests */
const designSchemeRequestSchema = z
  .object({
    palette: z.record(z.string()),
    features: z.array(z.string()),
    font: z.array(z.string()),
  })
  .optional();

/** Zod schema for supabase connection in chat requests */
const supabaseConnectionSchema = z
  .object({
    isConnected: z.boolean(),
    hasSelectedProject: z.boolean(),
    credentials: z
      .object({
        anonKey: z.string().optional(),
        supabaseUrl: z.string().optional(),
      })
      .optional(),
  })
  .optional();

/** Zod schema for a per-operation model route override */
const modelRouteConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

/** Zod schema for model routing configuration (partial map of operation type → provider+model) */
const modelRoutingConfigSchema = z.record(z.enum(OPERATION_TYPES), modelRouteConfigSchema).optional();

/** Zod schema for POST /api/chat request body */
export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1, 'At least one message is required'),
  files: z.any().optional(),
  promptId: z.string().optional(),
  contextOptimization: z.boolean().default(false),
  enableThinking: z.boolean().default(false),
  chatMode: z.enum(['discuss', 'build']).default('build'),
  planMode: z.boolean().default(false),
  designScheme: designSchemeRequestSchema,
  supabase: supabaseConnectionSchema,
  maxLLMSteps: z.number().int().positive().max(20).default(5),
  agentMode: z.boolean().optional(),
  modelRoutingConfig: modelRoutingConfigSchema,
  blueprintMode: z.boolean().optional(),
});

/** Validated chat request type inferred from Zod schema */
export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** Chat error response shape (returned on validation failure or server error) */
export interface ChatResponse {
  error: string;
  details?: Array<{ path: string; message: string }>;
}

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * Model API Types
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Response from GET /api/models */
export interface ModelListResponse {
  modelList: ModelInfo[];
  providers: ProviderInfo[];
  defaultProvider: ProviderInfo;
}

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * Provider API Types (configured providers detection)
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Single configured provider entry */
export interface ConfiguredProvider {
  name: string;
  isConfigured: boolean;
  configMethod: 'environment' | 'none';
}

/** Response from GET /api/configured-providers */
export interface ProviderListResponse {
  providers: ConfiguredProvider[];
}

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * Health API Types
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Response from GET /api/health */
export interface HealthResponse {
  status: 'healthy';
  timestamp: string;
}

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * Update API Types
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Individual step result in update process */
export interface UpdateStepResult {
  name: string;
  status: 'completed' | 'failed' | 'skipped';
  error?: string;
}

/** Response from POST /api/update */
export interface UpdateResponse {
  success: boolean;
  message: string;
  steps: UpdateStepResult[];
}

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * Version Check API Types
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Single changelog entry */
export interface ChangelogEntry {
  hash: string;
  message: string;
  date: string;
}

/** Response from GET /api/version-check */
export interface VersionCheckResponse {
  local: { hash: string; fullHash: string };
  remote: { hash: string; fullHash: string; date: string; message: string };
  updateAvailable: boolean;
  commitsBehind: number;
  changelog: ChangelogEntry[];
  compareUrl: string;
  isDocker: boolean;
  error: string | null;
}

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * LLM Fallback Types
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Describes a fallback attempt when the primary LLM model fails */
export interface FallbackEvent {
  /** Provider + model that failed (e.g. "openai/gpt-4o") */
  primaryModel: string;

  /** Provider + model used as fallback (e.g. "anthropic/claude-haiku-4-5-20251001") */
  fallbackModel: string;

  /** Error category from the primary failure */
  errorCategory: 'rate_limit' | 'auth_failure' | 'timeout' | 'provider_error' | 'model_not_found' | 'unknown';

  /** Whether the fallback attempt succeeded */
  fallbackSucceeded: boolean;
}
