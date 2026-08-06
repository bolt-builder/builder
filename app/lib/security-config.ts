/**
 * Centralized Security Configuration
 *
 * Single source of truth for all security-related constants.
 * This file exports pure data objects — no logic, no side effects.
 * security.ts imports these values instead of hardcoding them.
 */

/* Rate Limiting */

export interface RateLimitRule {
  /** Sliding window duration in milliseconds */
  windowMs: number;

  /** Maximum requests allowed in the window */
  maxRequests: number;
}

/**
 * Rate limit rules keyed by route pattern.
 *
 * - Exact patterns are matched first.
 * - Prefix patterns ending in `-*` are matched next.
 * - Wildcard patterns ending in `/*` are matched last.
 */
export const RATE_LIMITS: Record<string, RateLimitRule> = {
  // General API endpoints — 100 requests per 15 minutes
  '/api/*': { windowMs: 15 * 60 * 1000, maxRequests: 100 },

  // LLM API (more restrictive) — 10 requests per minute
  '/api/llmcall': { windowMs: 60 * 1000, maxRequests: 10 },

  // GitHub API endpoints — 30 requests per minute
  '/api/github-*': { windowMs: 60 * 1000, maxRequests: 30 },

  // Netlify API endpoints — 20 requests per minute
  '/api/netlify-*': { windowMs: 60 * 1000, maxRequests: 20 },
} as const;

/* Content Security Policy */

/**
 * Allowed connect-src origins for CSP.
 * Centralised here so they can be reviewed / extended without touching
 * the CSP builder logic in security.ts.
 */
export const CSP_CONNECT_SRC_ALLOWLIST: readonly string[] = [
  // Git providers
  'https://api.github.com',
  'https://models.github.ai',
  'https://gitlab.com',

  // Deployment platforms
  'https://api.netlify.com',
  'https://api.vercel.com',
  'https://*.supabase.co',
  'https://api.supabase.com',

  // LLM providers – Major
  'https://api.openai.com',
  'https://api.anthropic.com',
  'https://generativelanguage.googleapis.com',

  // LLM providers – Other
  'https://api.groq.com',
  'https://api.mistral.ai',
  'https://api.cohere.com',
  'https://api.deepseek.com',
  'https://api.perplexity.ai',
  'https://api.x.ai',
  'https://api.together.xyz',
  'https://api.hyperbolic.xyz',
  'https://api.moonshot.ai',
  'https://openrouter.ai',
  'https://api-inference.huggingface.co',

  // WebSocket support for real-time features
  'wss://*.supabase.co',
] as const;

/* CSRF */

export interface CsrfConfig {
  /** Whether CSRF protection is enabled */
  enabled: boolean;

  /** Token time-to-live in milliseconds */
  tokenTTL: number;

  /** Name of the cookie that stores the CSRF token */
  cookieName: string;

  /** Name of the HTTP header that carries the CSRF token */
  headerName: string;

  /** HTTP methods exempt from CSRF validation (safe methods) */
  exemptMethods: readonly string[];
}

export const CSRF_CONFIG: CsrfConfig = {
  enabled: true,
  tokenTTL: 2 * 60 * 60 * 1000, // 2 hours
  cookieName: 'csrf-token',
  headerName: 'X-CSRF-Token',
  exemptMethods: ['GET', 'HEAD', 'OPTIONS'] as const,
} as const;

/* Auth — Token transport */

export interface AuthTokenConfig {
  /** HTTP header used to supply the auth token */
  tokenHeader: string;

  /** Cookie name used as a fallback for the auth token */
  cookieName: string;

  /** Environment variable that holds the expected token value */
  envVariable: string;
}

export const AUTH_CONFIG: AuthTokenConfig = {
  tokenHeader: 'X-Auth-Token',
  cookieName: 'bolt-auth',
  envVariable: 'BOLT_AUTH_TOKEN',
} as const;

/* Auth — Route protection presets */

/** Discriminated auth level for route protection. */
export type AuthLevel = 'public' | 'authenticated' | 'ownerOnly';

/**
 * Declarative auth configuration for a route.
 *
 * Discriminated on the `level` field so downstream guards can narrow
 * the union and apply the correct enforcement logic.
 */
export interface AuthConfig {
  /** Auth level required to access the route */
  level: AuthLevel;

  /** Whether CSRF token validation is required (typically true for mutations) */
  csrfRequired: boolean;

  /** Optional per-route rate-limit override; when omitted the global rule applies */
  rateLimitOverride?: RateLimitRule;
}

/**
 * Pre-built, frozen AuthConfig presets for common route protection patterns.
 *
 * - `public`        — No auth required. CSRF still enforced for mutations.
 * - `authenticated` — Valid auth token required. CSRF enforced.
 * - `ownerOnly`     — Valid auth token + admin/owner validation. CSRF enforced.
 */
export const AUTH_PRESETS = Object.freeze({
  /** No auth required; CSRF required for mutations; rate limiting enabled (default rules). */
  public: Object.freeze<AuthConfig>({
    level: 'public',
    csrfRequired: true,
  }),

  /** Auth token required; CSRF required; rate limiting enabled (default rules). */
  authenticated: Object.freeze<AuthConfig>({
    level: 'authenticated',
    csrfRequired: true,
  }),

  /** Auth token required; admin/owner validation; CSRF required; rate limiting enabled (default rules). */
  ownerOnly: Object.freeze<AuthConfig>({
    level: 'ownerOnly',
    csrfRequired: true,
  }),
});

/* CORS */

export interface CorsConfig {
  /** Maximum age (in seconds) for preflight cache */
  maxAge: number;
}

export const CORS_CONFIG: CorsConfig = {
  maxAge: 86_400, // 24 hours
} as const;

/* Aggregate export */

export interface SecurityConfig {
  csp: {
    connectSrcAllowlist: readonly string[];
  };
  cors: CorsConfig;
  rateLimit: Record<string, RateLimitRule>;
  csrf: CsrfConfig;
  auth: AuthTokenConfig;
}

export const SECURITY_CONFIG: SecurityConfig = {
  csp: {
    connectSrcAllowlist: CSP_CONNECT_SRC_ALLOWLIST,
  },
  cors: CORS_CONFIG,
  rateLimit: RATE_LIMITS,
  csrf: CSRF_CONFIG,
  auth: AUTH_CONFIG,
} as const;
