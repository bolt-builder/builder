# Architecture

> System design, layers, and data flow for Bolt.

---

## High-Level Overview

```text
┌─────────────────────────────────────────────────────────┐
│                     Browser Client                       │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Chat UI  │  │  Workbench   │  │    Settings UI    │  │
│  │ Messages  │  │ Editor+Term  │  │  Providers/Keys   │  │
│  └─────┬─────┘  └──────┬───────┘  └────────┬──────────┘  │
│        │               │                   │             │
│  ┌─────▼───────────────▼───────────────────▼──────────┐  │
│  │              Nanostores (State Layer)               │  │
│  │  workbench · chat · files · editor · settings · …  │  │
│  └─────────────────────┬──────────────────────────────┘  │
│                        │                                 │
│  ┌─────────────────────▼──────────────────────────────┐  │
│  │         RuntimeClient (Browser ↔ Server Bridge)     │  │
│  │   Communicates via /api/runtime/* Remix routes       │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
└──────────────────────────┬───────────────────────────────┘
                           │ HTTP (Remix API Routes)
┌──────────────────────────▼───────────────────────────────┐
│                      Remix Server                         │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  LLM Stream  │  │  MCP Service │  │  Git/Deploy    │  │
│  │  (AI SDK)    │  │  (Tools)     │  │  Proxies       │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                 │                  │           │
│  ┌──────▼─────────────────▼──────────────────▼────────┐  │
│  │          LocalRuntime (Server-Side Execution)       │  │
│  │   File I/O · Shell (Git Bash / system) · Dev server │  │
│  │   Projects at ~/.bolt/projects/{projectId}/       │  │
│  └────────────────────────────────────────────────────┘  │
│         │                 │                  │           │
│  ┌──────▼─────────────────▼──────────────────▼────────┐  │
│  │            External APIs (LLM Providers)            │  │
│  │  OpenAI · Anthropic · Google · Ollama · 18 more     │  │
│  │  (22 total: + Cerebras, Cohere, Deepseek, Fireworks,│  │
│  │   Groq, HuggingFace, Hyperbolic, Mistral, Moonshot, │  │
│  │   OpenRouter, OpenAILike, Perplexity, xAI, Together,│  │
│  │   LMStudio, AmazonBedrock, Github, Z.ai)            │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## Layer Breakdown

### 1. Presentation Layer (`app/components/`)

React components organized into 10 groups. See [Components](COMPONENTS.md) for full details.

**Key pattern**: Components with `.client.tsx` suffix are browser-only (no SSR). Remix's `ClientOnly` wrapper is used in routes to lazy-load them.

### 2. State Layer (`app/lib/stores/`)

24 nanostore files managing all application state. See [State Management](STATE-MANAGEMENT.md) for full details.

**Key pattern**: Class-based stores (`WorkbenchStore`) compose sub-stores (`EditorStore`, `FilesStore`, `TerminalStore`, `PreviewsStore`). HMR-safe via `import.meta.hot.data`.

### 3. Service Layer (`app/lib/services/`)

Business logic separated from UI:

| Service | Purpose |
| ------- | ------- |
| `agentOrchestratorService.ts` | Agent mode execution loop, iteration tracking, approval flows |
| `agentToolsService.ts` | Agent tool definitions and execution |
| `agentChatIntegration.ts` | Bridges agent mode with chat API |
| `mcpService.ts` | MCP (Model Context Protocol) client management — includes schema sanitization for Gemini compatibility (strips `anyOf`, `oneOf`, `allOf`, `additionalProperties`), auto-approve per-server toggle, and formatted markdown rendering of tool results |
| `autoFixService.ts` | Error formatting and fix-attempt tracking — used when the user manually clicks "Ask Bolt" in a ChatAlert dialog (no auto-triggering) |
| `githubApiService.ts` | GitHub API operations |
| `gitlabApiService.ts` | GitLab API operations |
| `importExportService.ts` | Chat import/export functionality |
| `repositoryPushService.ts` | Push project files to remote Git repositories (GitHub/GitLab) |
| `localModelHealthMonitor.ts` | Monitors local model (Ollama/LMStudio) availability |

### 4. Error Classification Layer (`app/lib/errors/`)

Centralized error classification that replaces the old auto-fix auto-triggering system. All runtime errors now flow through this layer before reaching the UI.

| File | Purpose |
| ---- | ------- |
| `error-classifier.ts` | Classifies errors into 6 categories (`network`, `auth`, `validation`, `build`, `runtime`, `unknown`) and 4 severity levels (`fatal`, `error`, `warning`, `info`). Exports `classifyError()` and `shouldShowFullAlert()`. |
| `error-toast.ts` | Thin wrapper around Sonner `toast` for displaying classified errors as lightweight toast notifications. |

**Routing logic:**

```text
Error detected (terminal or preview)
       │
       ▼
classifyError(message) → ClassifiedError { category, severity, recoverable, suggestion }
       │
       ▼
shouldShowFullAlert(classified)?
       ├── true  (severity = fatal | error)  → ChatAlert dialog
       │         User clicks "Ask Bolt" to send error to LLM
       └── false (severity = warning | info) → Sonner toast notification
                 Auto-dismissed, no LLM involvement
```

**Consumers:**

- `terminalErrorDetector.ts` — detects errors in terminal output, classifies via this layer, routes to ChatAlert or toast
- `previewErrorHandler.ts` — detects errors in preview iframe, classifies via this layer, routes to ChatAlert or toast

> **No auto-fix auto-triggering.** The old system that automatically sent errors to the LLM has been completely removed. All error handling now requires explicit user action — clicking "Ask Bolt" in the ChatAlert dialog for serious errors, or simply reading the toast for minor ones.

### 5. LLM Layer (`app/lib/modules/llm/`)

Provider-based architecture for multi-LLM support. See [LLM Providers](LLM-PROVIDERS.md).

**Key pattern**: `LLMManager` singleton auto-discovers and registers all providers from `providers/` directory. Each provider extends `BaseProvider`.

### 6. Runtime Layer (`app/lib/runtime/`)

Handles LLM response parsing and action execution:

| File | Purpose |
| ---- | ------- |
| `message-parser.ts` | Parses LLM streaming output into structured actions (file writes, shell commands) |
| `enhanced-message-parser.ts` | Extended parser that auto-wraps untagged code blocks and shell commands into action tags |
| `action-runner.ts` | Executes parsed actions via LocalRuntime (create files, run commands) |
| `local-runtime.ts` | Server-side runtime managing code execution, file I/O, shell commands, and port detection |
| `local-filesystem.ts` | Local filesystem abstraction for project file operations |
| `runtime-client.ts` | Browser-side client communicating with LocalRuntime via `/api/runtime/*` routes |
| `runtime-provider.ts` | React context provider for runtime initialization and access |
| `git-client.ts` | Git client for repository operations |
| `git-manager.ts` | Git repository lifecycle management |
| `command-safety.ts` | Command validation and safety checks for shell execution |

### 7. Persistence Layer (`app/lib/persistence/`)

| File | Purpose |
| ---- | ------- |
| `db.ts` | IndexedDB schema and connection management |
| `chats.ts` | Chat CRUD operations (getAllChats, getChatById, saveChat, deleteChat) |
| `useChatHistory.ts` | React hook for chat history with IndexedDB, URL sync, duplication |
| `localStorage.ts` | Client-side localStorage utilities with error handling |
| `lockedFiles.ts` | File/folder lock management per chat (localStorage-backed) |
| `snapshotUtils.ts` | Global snapshot utilities for persisting file state |
| `projectPlanMode.ts` | Project plan mode settings per chat (localStorage-backed) |
| `autoBackup.ts` | Automatic backup management for chat data |
| `types.ts` | Shared persistence type definitions |
| `ChatDescription.client.tsx` | Chat description editing component |

### 8. Server Layer (`app/routes/api.*`)

51 Remix API routes. See [API Routes](API-ROUTES.md).

**Key pattern**: Routes use Remix conventions — `action()` for POST/PUT/DELETE, `loader()` for GET. Server-only code lives in `app/lib/.server/`. All route handlers are wrapped with `withSecurity()` from `app/lib/security.ts` (except `/api/sentry-tunnel`, which is CSRF-exempt for Sentry SDK compatibility), enforcing CORS origin validation, SameSite cookie attributes, request sanitization, and a URL allowlist on the git proxy.

---

## Data Flow: Chat Message

```text
User types message
       │
       ▼
  Chat.client.tsx (sends via AI SDK useChat)
       │
       ▼
  POST /api/chat (Remix action)
       │
       ├── Validate request (Zod schema)
       ├── Load provider settings (cookies)
       ├── Select context (file contents for prompt)
       ├── Build system prompt
       │
       ▼
  streamText() (Vercel AI SDK)
       │
       ├── Stream to LLM provider (OpenAI, Anthropic, etc.)
       ├── Process streaming response
       │     ├── Parse artifacts (file operations)
       │     ├── Parse shell commands
       │     └── Track progress annotations
       │
       ▼
  Client receives stream
       │
       ├── MessageParser processes chunks
       ├── ActionRunner executes file writes via LocalRuntime (server-side)
       ├── ActionRunner executes shell commands via LocalRuntime (server-side)
       └── UI updates (Messages, Editor, Preview)
```

---

## Data Flow: Agent Mode

```text
User enables Agent Mode + sends task
       │
       ▼
  AgentOrchestrator.startSession(task)
       │
       ▼
  ┌─── Iteration Loop ──────────────────┐
  │                                      │
  │  LLM generates tool calls            │
  │       │                              │
  │       ▼                              │
  │  AgentToolsService.execute()         │
  │       │                              │
  │       ├── bolt_read_file           │
  │       ├── bolt_write_file          │
  │       ├── bolt_list_directory      │
  │       ├── bolt_run_command         │
  │       ├── bolt_search_code         │
  │       └── bolt_get_errors          │
  │       │                              │
  │       ▼                              │
  │  Check: needs approval?              │
  │       ├── Yes → wait for user        │
  │       └── No → continue              │
  │       │                              │
  │  Check: max iterations?              │
  │       ├── Yes → warn user            │
  │       └── No → next iteration        │
  │                                      │
  └──────────────────────────────────────┘
       │
       ▼
  AgentOrchestrator.endSession()
```

---

## Key Design Decisions

1. **LocalRuntime for execution**: Code runs on the host machine via `LocalRuntime` (server-side). `RuntimeClient` (browser-side) communicates with it through `/api/runtime/*` Remix routes. `bootRuntime(projectId)` initializes a project runtime with files stored at `~/.bolt/projects/{projectId}/`. Supports native binaries, real Git, and full shell access (Git Bash preferred on Windows). Port detection uses ANSI-stripped regex matching, firing events via SSE to `PreviewsStore` for iframe preview at `http://localhost:PORT`. COEP/COOP headers have been removed (they were WebContainer-only); CSP `frame-src` allows localhost.

   **Runtime lifecycle guarantees:**
   - **Single instance enforcement** — `RuntimeManager` is a server-side singleton that maps project IDs to `LocalRuntime` instances. Concurrent `bootRuntime()` calls for the same project coalesce into a single promise. On chat exit, `teardown()` destroys the runtime and releases all resources.
   - **Port escalation prevention** — `teardown()` kills all shell sessions, awaits process exit with a **5 s timeout**, force-kills orphaned port holders via `killPortHolder()`, then polls with `waitForPortFree()` (250 ms interval, 3 s timeout) to confirm ports are released before a new runtime boots.
   - **Preview refresh debouncing** — `PreviewsStore` debounces iframe refreshes (300 ms delay) to avoid rapid reloads during agent mode file writes.

2. **Nanostores as the only state management**: Nanostores is the **sole** state management library — there is no Redux, Zustand, or React Context for global state. Lightweight atomic stores avoid boilerplate while supporting cross-component reactivity without prop drilling.

   **Leak prevention patterns:**
   - **Computed atoms over manual subscribes** — Derived state uses `computed()` (e.g., `isAutoFixEnabled`, `isInReviewCycle`, `budgetSeverity`) instead of manual `subscribe()` + `set()` chains, eliminating a class of subscription leak bugs.
   - **HMR guards** — Class-based stores (e.g., `EditorStore`) persist atoms across hot module replacement via `import.meta.hot.data`, preventing store re-creation and state loss during development.

3. **Remix for routing + SSR**: Server-side rendering for SEO/initial load, with client-only components for interactive features (editor, terminal, preview).

4. **Provider pattern for LLMs**: Adding a new LLM provider requires only one file — extend `BaseProvider`, define models, implement `getModelInstance()`.

5. **MCP for extensibility**: Model Context Protocol allows connecting external tools (databases, APIs, filesystems) to the AI assistant without modifying core code.

6. **Extended Thinking**: Supported for Anthropic Claude and Google Gemini models. Allows models to expose their internal reasoning process before producing a final answer, with a configurable thinking budget per request.

7. **CSS custom properties for theming**: All theme colors flow through `--bolt-elements-*` variables, enabling runtime theme switching without rebuilds.

8. **Security by default** — Every API route is wrapped with `withSecurity()` from `app/lib/security.ts` (except `/api/sentry-tunnel`, which is CSRF-exempt for Sentry SDK requests), enforcing CORS origin validation, SameSite cookie attributes, request sanitization, and a URL allowlist on the git proxy.

9. **Docker-first deployment** — Multi-stage Dockerfile + docker-compose.yml with GHCR CI/CD and optional Watchtower auto-update enables one-command self-hosting.

10. **Startup performance** — Vite `optimizeDeps` pre-bundles critical dependencies and unconfigured LLM providers are skipped during initialization.

---

## File Naming Conventions

| Pattern | Meaning |
| ------- | ------- |
| `*.client.tsx` | Browser-only component (no SSR) |
| `*.spec.ts` | Test file (Vitest) |
| `*.module.scss` | CSS Modules (scoped styles) |
| `api.*.ts` | Server API route |
| `*.d.ts` | TypeScript declaration file |
