# Agent Mode

> Autonomous agent orchestration, tools, and execution flows in Bolt.

---

## Overview

Agent Mode enables Bolt to act as an **autonomous coding agent**. Instead of generating code artifacts in the chat, the LLM uses structured **tool calls** to directly read, write, and execute code via the LocalRuntime on the host machine. This enables multi-step, iterative development with error detection and self-correction.

---

## Architecture

```text
┌─────────────────────────────────────────────────┐
│                  Chat Interface                  │
│          (agentMode toggle enabled)              │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│            agentChatIntegration.ts                │
│  Bridges chat API with agent orchestration        │
└──────────────────────┬───────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │   AgentOrchestrator     │
          │  (agentOrchestratorService.ts)          │
          │                         │
          │  - Session lifecycle    │
          │  - Iteration tracking   │
          │  - Approval workflows   │
          │  - Status management    │
          └────────────┬────────────┘
                       │
          ┌────────────▼────────────┐
          │   AgentToolsService     │
          │  (agentToolsService.ts) │
          │                         │
          │  - Tool definitions     │
          │  - Tool execution       │
          │  - Result formatting    │
          └────────────┬────────────┘
                       │
          ┌────────────▼────────────┐
          │     LocalRuntime        │
          │  (File I/O, Shell)      │
          │  Executes on host via   │
          │  /api/runtime/* routes  │
          └─────────────────────────┘
```

### Key Files

| File | Purpose |
| ---- | ------- |
| `app/lib/agent/index.ts` | Public API — re-exports all agent types and services |
| `app/lib/agent/types.ts` | TypeScript interfaces (464 lines of thorough type definitions) |
| `app/lib/agent/prompts.ts` | System prompts for agent mode (391 lines) |
| `app/lib/services/agentOrchestratorService.ts` | Session management, iteration control, approval flows (326 lines) |
| `app/lib/services/agentToolsService.ts` | Tool definitions and execution logic |
| `app/lib/services/agentChatIntegration.ts` | Integration layer between chat API and agent |
| `app/lib/stores/agentMode.ts` | Nanostore for agent mode UI state |

---

## Agent Tools

The LLM can call these tools during agent mode execution.

> **MCP Tools**: In addition to the built-in `bolt_*` tools listed below, any MCP tools registered through `mcpService` are also available to the LLM during agent mode. MCP tools are registered alongside agent tools and appear in the same tool set passed to the model.

> **Extended Thinking**: Extended thinking is fully compatible with agent mode. When enabled, the model's reasoning steps are shown before each tool call decision.

| Tool | Purpose | Approval Required |
| ---- | ------- | ----------------- |
| `bolt_read_file` | Read file contents (with optional line range) | No |
| `bolt_write_file` | Create or modify files | Configurable |
| `bolt_delete_file` | Delete files or directories | Configurable |
| `bolt_rename_file` | Rename or move files | Configurable |
| `bolt_list_directory` | Explore project structure | No |
| `bolt_run_command` | Execute shell commands (npm, node, etc.) | Configurable |
| `bolt_get_errors` | Check for build/runtime/preview errors | No |
| `bolt_search_code` | Search for code patterns across files (supports regex) | No |
| `bolt_patch_file` | Make targeted text replacements without rewriting entire files | Configurable |

### Tool Parameters

#### `bolt_read_file`

```typescript
{
  path: string;       // File path relative to project root
  startLine?: number; // Optional start line (1-indexed)
  endLine?: number;   // Optional end line (inclusive)
}
```

#### `bolt_write_file`

```typescript
{
  path: string;    // File path relative to project root
  content: string; // Complete file content
}
```

#### `bolt_delete_file`

```typescript
{
  path: string;        // File or directory path relative to project root
  recursive?: boolean; // Required for non-empty directories (default: false)
}
```

#### `bolt_rename_file`

```typescript
{
  oldPath: string; // Current file path relative to project root
  newPath: string; // New file path (parent directories are auto-created)
}
```

#### `bolt_list_directory`

```typescript
{
  path?: string;     // Directory path (default: "/")
  recursive?: boolean; // List recursively (default: false)
  maxDepth?: number; // Max depth for recursive (default: 3)
}
```

#### `bolt_run_command`

```typescript
{
  command: string;   // Shell command to execute
  cwd?: string;      // Working directory (relative to project root)
  timeout?: number;  // Timeout in ms (default: 30000)
}
```

#### `bolt_get_errors`

```typescript
{
  source?: 'terminal' | 'preview' | 'build' | 'all'; // Error source (default: 'all')
}
```

#### `bolt_search_code`

```typescript
{
  query: string;           // Search pattern — supports regex with automatic fallback to literal matching
  path?: string;           // Directory to search (default: "/")
  maxResults?: number;     // Max results (default: 50)
  includePattern?: string; // File path include filter
  excludePattern?: string; // File path exclude filter
}
```

#### `bolt_patch_file`

```typescript
{
  path: string;            // Absolute path to file (e.g., "/src/App.tsx")
  replacements: Array<{    // Array of targeted replacements
    oldText: string;       // Exact text to find
    newText: string;       // Replacement text
  }>;
}
```

---

## Agent Settings

Configurable via the Settings UI or programmatically:

```typescript
interface AgentModeSettings {
  enabled: boolean;                  // Toggle agent mode
  autoApproveFileCreation: boolean;  // Skip approval for new files (default: true)
  autoApproveFileModification: boolean; // Skip approval for file edits (default: true)
  autoApproveCommands: boolean;      // Skip approval for shell commands (default: false)
  maxIterations: number;             // Max iterations per session (default: 25)
}
```

---

## Execution Lifecycle

### Session States

```text
idle → thinking → executing → thinking → ... → completed
                      │
                      ▼
              waiting_for_approval → (approved) → executing
                      │
                      ▼
                  (denied) → thinking
```

| Status | Description |
| ------ | ----------- |
| `idle` | No active session |
| `thinking` | LLM is generating next action |
| `executing` | Tool is being executed |
| `waiting_for_approval` | User approval needed for a tool call |
| `waiting_for_user` | Agent needs user input to continue |
| `error` | An error occurred |
| `completed` | Session finished |

### Session Flow

1. **Start**: `AgentOrchestrator.startSession(task)` — initializes state, sets status to `thinking`
2. **Iterate**: LLM generates tool calls → orchestrator executes them → tracks results
3. **Approval**: If a tool needs approval, status changes to `waiting_for_approval`
4. **Iteration Limit**: If `maxIterations` reached, user is warned
5. **Complete**: `AgentOrchestrator.endSession()` — finalizes state, logs summary

### Session State Tracking

The orchestrator tracks everything during a session:

```typescript
interface AgentExecutionState {
  iteration: number;          // Current iteration count
  maxIterations: number;      // Configured limit
  status: AgentStatus;        // Current status
  isExecuting: boolean;       // Whether actively executing
  toolCalls: ToolCallRecord[]; // All tool calls with results
  totalToolCalls: number;     // Total count
  filesCreated: string[];     // Files created this session
  filesModified: string[];    // Files modified this session
  commandsExecuted: string[]; // Commands run this session
  sessionStartTime: number;   // Start timestamp
  sessionEndTime?: number;    // End timestamp
}
```

---

## System Prompt

When agent mode is active, the standard system prompt is **replaced** with a single unified prompt — `AGENT_MODE_FULL_SYSTEM_PROMPT` — exported from `app/lib/agent/prompts.ts`. This replaces the previous multi-prompt system (the legacy `AGENT_SYSTEM_PROMPT`, `AGENT_SYSTEM_PROMPT_COMPACT`, `AGENT_ERROR_CONTEXT_PROMPT`, `AGENT_ITERATION_WARNING_PROMPT`, and helper functions like `getAgentSystemPrompt()` / `enhanceSystemPromptWithAgentMode()` have all been removed).

### Prompt Optimizations

The system prompt has been significantly trimmed and improved:

- **~30% reduction** — trimmed from ~797 lines to ~559 lines
- **~88% token budget reduction** — simple apps now cost ~16K tokens (down from ~135K)
- **Chain-of-thought reasoning** added to guide the LLM through multi-step decisions
- **Entry point file requirements** — `main.tsx` and `index.html` must be created for web apps
- **CSS variable guidance** — shadcn/ui classes require CSS variables to be defined; the prompt now includes instructions for this
- **Response brevity guidelines** — keep responses concise and action-oriented

### Prompt Contents

The prompt covers:

1. Instructs the LLM to use `bolt_*` tools instead of artifact XML tags
2. Defines LocalRuntime capabilities and constraints (native binaries ARE supported, git IS available; projects are sandboxed to `~/.bolt/projects/{projectId}/`)
3. Establishes a tool selection hierarchy (prefer `write_file` over shell commands)
4. Forbids outputting file content in plain text (must use tools)
5. **Mobile-first design mandate** — all UI must be responsive and mobile-first
6. **Design system / semantic tokens** — enforces consistent use of design tokens
7. **Technology preferences** — React 19, Tailwind v4, shadcn/ui
8. **Chain-of-thought reasoning** — guides the LLM through multi-step planning before tool calls
9. **Entry point requirements** — ensures `main.tsx`, `index.html` are created for web projects
10. **CSS variable guidance** — explicit instructions for shadcn/ui CSS variable dependencies
11. **Self-validation checklist** — the agent validates its own output before finishing

See `app/lib/agent/prompts.ts` for the complete prompt.

---

## Chat Integration

The `agentChatIntegration.ts` module bridges agent mode with the standard chat API:

| Function | Purpose |
| -------- | ------- |
| `shouldUseAgentMode()` | Check if agent mode is enabled for the current request |
| `getAgentToolSetWithoutExecute()` | Get tool definitions (without execute functions) for the AI SDK |
| `initializeAgentSession()` | Start a new agent session |
| `incrementAgentIteration()` | Advance the iteration counter |
| `getAgentIterationWarning()` | Get a warning prompt when nearing iteration limit |
| `processAgentToolInvocations()` | Process tool invocations from LLM response |
| `processAgentToolCall()` | Execute a single tool call |
| `isAgentToolName()` | Check if a tool name is an agent tool |

---

## Agent Mode Runtime Behavior

- **Preview refresh debouncing** — Agent file writes trigger `schedulePreviewRefresh` in `action-runner.ts` to debounce preview reloads, preventing excessive iframe refreshes during rapid multi-file edits.
- **"Agent Executing" badge** — The badge properly resets on stream end, even if the stream terminates unexpectedly.
- **Runtime teardown** — Agent mode properly tears down the LocalRuntime on exit to free resources.

---

## Error Handling

Auto-fix has been **completely removed** from Bolt. There is no automatic error correction or auto-triggering of fixes.

Error handling in agent mode follows this pipeline:

1. **Tool execution errors** are captured and returned to the LLM as error results
2. **Build errors** can be detected via `bolt_get_errors` tool
3. **Error classifier** (`app/lib/errors/error-classifier.ts`) categorizes errors into 6 categories × 4 severity levels
4. **Minor errors** (warning/info severity) → Sonner toast notification (lightweight, auto-dismiss)
5. **Serious errors** (error/fatal severity) → `ChatAlert` dialog with an **"Ask Bolt"** button
6. **User-initiated fixes only** — The user must manually click "Ask Bolt" in the ChatAlert dialog to request the LLM to fix an error. There is no auto-triggering.
7. **Iteration warnings** prompt the user when approaching the iteration limit
8. **Session errors** set status to `error` with an error message

The LLM is prompted to check for errors after making changes and self-correct when possible, but this self-correction happens within the agent's own tool-call loop — not via any external auto-fix mechanism.
