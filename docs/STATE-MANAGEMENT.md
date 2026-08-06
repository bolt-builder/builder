# State Management

> Stores, hooks, and data flow patterns in Bolt.

---

## Overview

Bolt uses **Nanostores** as its primary state management solution. Nanostores provides lightweight, framework-agnostic atomic stores with React bindings via `@nanostores/react`.

### Why Nanostores

- **Tiny bundle** (~300 bytes per store)
- **No boilerplate** — stores are plain objects/atoms
- **Cross-framework** — works outside React (in services, utilities)
- **HMR-friendly** — stores persist across hot module replacement
- **No context providers** — any component can subscribe directly

---

## Store Location

All stores live in `app/lib/stores/`. Each file exports one or more stores.

---

## Store Inventory

### Core Application Stores

| Store File | Type | Purpose |
| ---------- | ---- | ------- |
| `workbench.ts` | Class (`WorkbenchStore`) | Main orchestrator — artifacts, file ops, views, alerts (1033 lines) |
| `chat.ts` | `map` | Chat state: started, aborted, showChat, pendingMessage |
| `editor.ts` | Class (`EditorStore`) | Selected file, scroll position, document map |
| `files.ts` | Class (`FilesStore`) | File system state (FileMap), file operations via RuntimeClient → LocalRuntime |
| `terminal.ts` | Class (`TerminalStore`) | Terminal instances, shell management via RuntimeClient (Git Bash on Windows, system shell otherwise) |
| `previews.ts` | Class (`PreviewsStore`) | Preview URLs from localhost dev server (port detected by LocalRuntime) |
| `settings.ts` | `map` + atoms | User preferences, shortcuts, provider settings |
| `theme.ts` | `atom` | Current theme (`'dark'` or `'light'`) |
| `sidebar.ts` | `atom`/`map` | Sidebar visibility and state |
| `streaming.ts` | `atom` | Whether LLM is currently streaming |

### Feature-Specific Stores

| Store File | Type | Purpose |
| ---------- | ---- | ------- |
| `agentMode.ts` | `map` | Agent mode enabled state and settings |
| `autofix.ts` | `atom`/`map` | Auto-fix error detection and correction state |
| `github.ts` | `map` | GitHub connection state |
| `githubConnection.ts` | `map` | GitHub auth tokens and user info |
| `gitlabConnection.ts` | `map` | GitLab auth tokens and user info |
| `mcp.ts` | `map` | MCP server configurations (`mcpServers` map, `autoApproveServers: string[]`). Persisted to localStorage under `mcp_settings` |
| `netlify.ts` | `map` | Netlify deployment state |
| `vercel.ts` | `map` | Vercel deployment state |
| `supabase.ts` | `map` | Supabase connection and project state |
| `staging.ts` | `map` | Staged file changes (diff/accept/reject workflow) |
| `plan.ts` | `map` | Plan/task tracking for code generation |
| `versions.ts` | `map` | Version/snapshot management |
| `profile.ts` | `map` | User profile data |
| `qrCodeStore.ts` | `atom` | Expo QR code URL for mobile preview |
| `logs.ts` | `map` | Application log entries |

---

## Store Patterns

### Pattern 1: Simple Atom

For single-value state:

```typescript
import { atom } from 'nanostores';

export const themeStore = atom<'dark' | 'light'>('dark');
```

**Usage in React:**

```tsx
import { useStore } from '@nanostores/react';
import { themeStore } from '~/lib/stores/theme';

function MyComponent() {
  const theme = useStore(themeStore);
  return <div>Current theme: {theme}</div>;
}
```

### Pattern 2: Map Store

For object state with named keys:

```typescript
import { map } from 'nanostores';

export const chatStore = map({
  started: false,
  aborted: false,
  showChat: true,
  pendingMessage: null as string | null,
});
```

**Update individual keys:**

```typescript
chatStore.setKey('started', true);
chatStore.setKey('pendingMessage', 'Hello');
```

### Pattern 3: Class-Based Composed Stores

For complex state with sub-stores (the WorkbenchStore pattern):

```typescript
import { atom, map } from 'nanostores';

export class WorkbenchStore {
  // Compose sub-stores
  #filesStore = new FilesStore(runtimeClient);
  #editorStore = new EditorStore(this.#filesStore);
  #terminalStore = new TerminalStore(runtimeClient);
  #previewsStore = new PreviewsStore(runtimeClient);

  // Public reactive atoms
  showWorkbench = atom(false);
  currentView = atom<'code' | 'preview'>('code');

  // HMR-safe constructor
  constructor() {
    if (import.meta.hot) {
      import.meta.hot.data.showWorkbench = this.showWorkbench;
    }
  }
}

// Export singleton
export const workbenchStore = new WorkbenchStore();
```

### Pattern 4: Computed Stores

Derived state from other stores:

```typescript
import { computed } from 'nanostores';

const hasPreview = computed(workbenchStore.previews, (previews) => previews.length > 0);
```

### Pattern 5: HMR Persistence

Stores use `import.meta.hot.data` to survive hot module replacement:

```typescript
showWorkbench: WritableAtom<boolean> =
  import.meta.hot?.data.showWorkbench ?? atom(false);

constructor() {
  if (import.meta.hot) {
    import.meta.hot.data.showWorkbench = this.showWorkbench;
  }
}
```

---

## Custom Hooks

All hooks live in `app/lib/hooks/`. They often wrap store access or provide data-fetching logic.

| Hook | Purpose |
| ---- | ------- |
| `useSettings` | Access and update settings store |
| `useGit` | Git operations (commit, push, pull) |
| `useGitHubAPI` | GitHub API interactions |
| `useGitHubConnection` | GitHub auth state |
| `useGitLabAPI` | GitLab API interactions |
| `useGitLabConnection` | GitLab auth state |
| `useConnectionStatus` | Runtime connection monitoring |
| `useConnectionTest` | Provider connection testing |
| `useDataOperations` | Data import/export |
| `useEditChatDescription` | In-place chat title editing |
| `useFeatures` | Feature flag management |
| `useIndexedDB` | IndexedDB access for chat history |
| `useLocalModelHealth` | Ollama/LMStudio availability check |
| `useMessageParser` | LLM response parsing |
| `useNotifications` | Toast notification management |
| `usePromptEnhancer` | Prompt improvement via LLM |
| `useSearchFilter` | Search/filter functionality |
| `useShortcuts` | Keyboard shortcut registration |
| `useSupabaseConnection` | Supabase connection state |
| `useViewport` | Responsive breakpoint detection |
| `useVersionCheck` | Polls `/api/version-check` to detect available updates, drives `UpdateBanner` |
| `usePlanSync` | Syncs PLAN.md file changes from LocalRuntime via RuntimeClient into the plan store, preserving user approval state |
| `useFileContent` | Read and track file content from runtime |
| `useGitHubStats` | GitHub repository statistics |

---

## Data Persistence

| Storage | What's Stored | Access Pattern |
| ------- | ------------- | -------------- |
| **IndexedDB** (`boltHistory`) | Chat messages, snapshots | `app/lib/persistence/db.ts` |
| **Cookies** | API keys, provider settings | `js-cookie` library |
| **localStorage** | Theme preference, MCP settings, locked files, project plan mode | `app/lib/persistence/localStorage.ts` |
| **URL Parameters** | Chat ID | Remix route params |

### IndexedDB Schema

Database: `boltHistory` (version 3)

**Object Stores:**

- `chats` — Key: `id`, Indexes: `id` (unique), `urlId` (unique)
- `snapshots` — Key: `chatId`

---

## State Flow Diagram

```text
User Action (click, type, etc.)
       │
       ▼
  React Component
       │
       ├── Direct store update: store.set(value)
       │                        store.setKey('key', value)
       │
       └── Via hook: useSettings().updateSetting(...)
              │
              ▼
       Nanostores reactivity
              │
              ▼
       All subscribed components re-render
       (useStore(someStore) triggers re-render)
```
