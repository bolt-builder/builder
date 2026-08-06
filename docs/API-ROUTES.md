# API Routes

> All server endpoints in Bolt, documented by category.

---

## Overview

Bolt uses Remix file-based routing. All API endpoints are in `app/routes/api.*.ts`. Routes export:

- `action()` — Handles POST/PUT/DELETE requests
- `loader()` — Handles GET requests

All route handlers are wrapped with `withSecurity()` from `app/lib/security.ts` (except `/api/sentry-tunnel`, which is CSRF-exempt for Sentry SDK compatibility). This middleware enforces CORS origin validation, SameSite=Strict cookie policy, and input sanitization.

---

## Chat & AI

| Endpoint | Method | Purpose |
| -------- | ------ | ------- |
| `/api/chat` | POST | Main chat endpoint — streams LLM responses with tool calls, file operations, and agent mode |
| `/api/enhancer` | POST | Enhances user prompts via LLM for better code generation results |
| `/api/llmcall` | POST | Generic LLM call endpoint for non-chat use cases |

### `/api/chat` Details

The primary endpoint. Accepts:

```json
{
  "messages": [{ "role": "user", "content": "..." }],
  "files": {},
  "promptId": "optional-prompt-id",
  "contextOptimization": true,
  "chatMode": "build",
  "designScheme": { "palette": {}, "features": [], "font": [] },
  "supabase": { "isConnected": false },
  "maxLLMSteps": 5,
  "agentMode": false
}
```

Validated with Zod. Returns a data stream with:

- LLM text chunks
- Tool call results (agent mode)
- Progress annotations
- Context annotations
- Error information

> **Extended Thinking**: The chat endpoint supports extended thinking via `thinkingBudget` in provider options. For Anthropic Claude, this uses the `thinking` provider option with a configurable budget (percentage of `maxTokens`). For Google Gemini, it uses `thinkingConfig` with a `thinkingBudget` token count.

---

## LLM Provider Management

| Endpoint | Method | Purpose |
| -------- | ------ | ------- |
| `/api/models` | GET | List all available models across all configured providers |
| `/api/models/:provider` | GET | List models for a specific provider |
| `/api/configured-providers` | GET | List which providers have API keys configured |
| `/api/check-env-key` | GET | Check if a specific environment variable is set |
| `/api/check-env-keys` | GET | Bulk check multiple environment variables at once |
| `/api/export-api-keys` | GET | Export API keys (for backup) |

---

## MCP (Model Context Protocol)

| Endpoint | Method | Purpose |
| -------- | ------ | ------- |
| `/api/mcp-check` | GET | Check MCP server availability and health |
| `/api/mcp-update-config` | POST | Update MCP server configuration |

> **Schema Sanitization**: `mcpService.ts` performs automatic schema sanitization before registering MCP tools. It strips `anyOf`, `oneOf`, `allOf`, and `additionalProperties` constructs from tool input schemas to ensure compatibility with Google Gemini and other providers that don't support complex JSON Schema features.

---

## Database / Persistence (Drizzle ORM)

Server-side chat persistence backed by Drizzle ORM. These routes complement the client-side IndexedDB layer, enabling cross-device access and backup.

| Endpoint | Method | Purpose |
| -------- | ------ | ------- |
| `/api/db/chats` | GET/POST | List chats (paginated) or create a new chat |
| `/api/db/chats/:id` | GET/PUT/DELETE | Get, update, or delete a single chat (including messages and snapshot) |
| `/api/db/migrate` | POST | Migrate chats from IndexedDB export format into the server-side database (batch processing) |

---

## Git Operations

| Endpoint | Method | Purpose |
| -------- | ------ | ------- |
| `/api/git-info` | GET | Get current git repository information |
| `/api/git-clone` | POST | Clone a git repository into a project runtime |
| `/api/git-proxy/*` | GET/POST | Proxy for git operations (clone, fetch, push) |

---

## GitHub Integration

| Endpoint | Method | Purpose |
| -------- | ------ | ------- |
| `/api/github-user` | GET | Get authenticated GitHub user info |
| `/api/github-branches` | GET | List branches for a GitHub repository |
| `/api/github-stats` | GET | Get GitHub repository statistics |
| `/api/github-template` | GET | Clone/template a GitHub repository |

---

## GitLab Integration

| Endpoint | Method | Purpose |
| -------- | ------ | ------- |
| `/api/gitlab-projects` | GET | List GitLab projects |
| `/api/gitlab-branches` | GET | List branches for a GitLab project |

---

## Deployment

| Endpoint | Method | Purpose |
| -------- | ------ | ------- |
| `/api/vercel-deploy` | GET/POST | Deploy to Vercel / check deployment status |
| `/api/vercel-user` | GET | Get authenticated Vercel user info |
| `/api/vercel-domains` | GET | List Vercel domains |
| `/api/vercel-proxy` | GET | Proxy requests to Vercel API |
| `/api/netlify-deploy` | POST | Deploy to Netlify |
| `/api/netlify-user` | GET | Get authenticated Netlify user info |

---

## Supabase

| Endpoint | Method | Purpose |
| -------- | ------ | ------- |
| `/api/supabase` | GET/POST | Supabase project management |
| `/api/supabase-user` | GET | Get Supabase user info |
| `/api/supabase/query` | POST | Execute Supabase queries |
| `/api/supabase/variables` | POST | Manage Supabase environment variables |

---

## System & Diagnostics

| Endpoint | Method | Purpose |
| -------- | ------ | ------- |
| `/api/health` | GET | Health check endpoint |
| `/api/system/diagnostics` | GET | System diagnostics (memory, CPU, etc.) |
| `/api/system/disk-info` | GET | Disk usage information |
| `/api/system/git-info` | GET | Git installation and version info |
| `/api/bug-report` | POST | Submit bug reports |
| `/api/version-check` | GET | Compares local commit hash against latest GitHub commit to detect available updates |
| `/api/update` | POST | One-click update: stash, pull latest from main, install dependencies (blocked in Docker — use `docker compose pull` instead) |
| `/api/web-search` | POST | Fetch web content with SSRF protection for AI web search |
| `/api/encrypt` | POST | Encrypt a value using server-side encryption (for secure storage of API keys) |
| `/api/sentry-tunnel` | POST | Proxy for Sentry event envelopes — bypasses ad-blockers that block direct `sentry.io` requests. **Not wrapped with `withSecurity()`** (Sentry SDK requests lack CSRF tokens). Validates target host against an allowlist. |
| `/api/deploy` | POST | SSE-streamed deployment to Vercel with progress events (alternative to `/api/vercel-deploy`) |

---

## External API (v1)

Headless / programmatic access for external integrations. Requires API key authentication via `requireApiAuth()`.

| Endpoint | Method | Purpose |
| -------- | ------ | ------- |
| `/api/v1/chat` | POST | External chat endpoint — accepts messages, streams LLM responses via SSE |
| `/api/v1/status` | GET | API health and version check (returns `{ status, version }`) |

---

## Page Routes

| Route | Component | Purpose |
| ----- | --------- | ------- |
| `/` | `_index.tsx` | Landing page with chat interface |
| `/chat/:id` | `chat.$id.tsx` | Chat page with specific conversation loaded |
| `/git` | `git.tsx` | Git URL import page |
| `/templates` | `templates.tsx` | Template gallery with category filtering, search, and preview |
| `/preview/:port` | `preview.$port.tsx` | Preview proxy page for dev server output |
| `/*` | `$.tsx` | Catch-all route |

---

## Runtime

Server-side local runtime for code execution, file I/O, and shell management. `LocalRuntime` runs on the server; `RuntimeClient` in the browser communicates with it via these routes.

| Endpoint | Method | Purpose |
| -------- | ------ | ------- |
| `/api/runtime/exec` | GET/POST | Process execution and runtime lifecycle. POST `op`: `boot` (initialize project runtime at `~/.bolt/projects/{projectId}/`), `exec` (execute a process), `teardown` (destroy runtime). GET `op`: `portEvents` (SSE stream for port detection — strips ANSI codes, fires `PortEvent` → `RuntimeClient` → `PreviewsStore` → iframe at `http://localhost:PORT`) |
| `/api/runtime/fs` | GET/POST | File system operations. GET `op`: `readFile`, `readFileRaw`, `readdir`, `stat`, `exists`, `watch` (SSE). POST `op`: `writeFile`, `mkdir`, `rm`, `rename` |
| `/api/runtime/terminal` | POST | Shell session management — create, write, kill, list, resize. Uses Git Bash on Windows, system shell otherwise |
| `/api/runtime/search` | GET | Code search across project files — supports regex patterns, include/exclude filters |
| `/api/runtime/git` | GET/POST | Git operations within a project runtime (status, commit, branch, etc.) |

---

## Authentication Pattern

Most API routes read credentials from **cookies** (set by the client-side settings panel):

```typescript
const cookieHeader = request.headers.get('Cookie') || '';
const apiKeys = JSON.parse(cookies['apiKeys'] || '{}');
const providerSettings = JSON.parse(cookies['providers'] || '{}');
```

There is no server-side session management — all auth state lives in browser cookies.

Additionally, all routes are protected by the `withSecurity()` wrapper which validates CORS origins, enforces `SameSite=Strict` on cookies, and applies a domain allowlist on the git proxy route (`/api/git-proxy/*`).

---

## Error Handling Pattern

API routes follow this pattern:

```typescript
import { withSecurity } from '~/lib/security';

async function myAction({ request }: ActionFunctionArgs) {
  // 1. Parse request body
  const rawBody = await request.json();

  // 2. Validate with Zod
  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'Invalid request', details: parsed.error.issues }), {
      status: 400,
    });
  }

  // 3. Execute business logic
  try {
    const result = await doSomething(parsed.data);
    return new Response(JSON.stringify(result));
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}

export const action = withSecurity(myAction, {
  allowedMethods: ['POST'],
  rateLimit: false,
});
```

### Client-Side Error Classification

Errors from the runtime (terminal output, preview iframe) are **not** handled by the API routes themselves. Instead, they flow through a client-side error classification layer before reaching the UI:

```text
Terminal output / Preview iframe
       │
       ▼
terminalErrorDetector.ts   or   previewErrorHandler.ts
  (detects error patterns)       (detects uncaught exceptions / unhandled rejections)
       │
       ▼
classifyError(message)  →  { category, severity, recoverable, suggestion }
  Categories: network | auth | validation | build | runtime | unknown
  Severities: fatal | error | warning | info
       │
       ▼
shouldShowFullAlert(classified)?
  ├── true  (fatal / error)  →  ChatAlert dialog (workbenchStore.actionAlert)
  │                              User manually clicks "Ask Bolt" to send to LLM
  └── false (warning / info) →  Sonner toast notification (showErrorToast)
                                 Auto-dismissed, no LLM involvement
```

> **No auto-fix auto-triggering.** Errors are never automatically sent to the LLM. The old auto-fix system that auto-triggered LLM calls on detected errors has been completely removed. Users must explicitly click "Ask Bolt" in the ChatAlert dialog to request a fix.
