# Contributing

> Conventions, tooling, and workflow for contributing to Bolt.

---

## Quick Reference

| Aspect | Tool / Convention |
| ------ | ----------------- |
| Package manager | pnpm 9.14.4 |
| Node version | ≥ 18.18.0 |
| Linter | ESLint (`@blitz/eslint-plugin`) |
| Formatter | Prettier 3.x |
| Test runner | Vitest 2.x |
| Test utilities | `@testing-library/react` 16.x |
| Path alias | `~/` → `./app/` |
| CSS framework | UnoCSS (Tailwind-compatible) |

---

## Code Quality Standards

These quality rules apply to all contributed code:

- **No TODOs in production code** — if it needs more work, do the work before merging
- **No placeholder implementations or stubs** — every function must be fully implemented
- **Error handling is mandatory** — use the error classifier (`~/lib/errors/error-classifier.ts`) to classify and route errors to ChatAlert (fatal) or toast (non-fatal). Do not silently swallow errors
- **No auto-fix** — errors are never silently patched. All errors go through ChatAlert (for fatal/build errors the user should address) or toast notifications (for recoverable warnings). See [ARCHITECTURE.md](ARCHITECTURE.md) for the error flow
- **Subscribe/listener cleanup required** — unsubscribe from store listeners on component unmount; use `import.meta.hot?.dispose()` for HMR cleanup of subscriptions and side-effects
- **Use accent color tokens from UnoCSS theme** — never hardcode hex color values (e.g., `#7B61FF`). Use the theme tokens defined in `uno.config.ts` instead
- **Use `cn()` for conditional class merging** — import from `~/utils/cn` (wraps `clsx` + `tailwind-merge`). Do not manually concatenate class strings

---

## Code Style

### ESLint

Config lives in `eslint.config.mjs`. Key rules enforced:

- **No relative imports** — use `~/` path alias instead of `../`
- **Semicolons** always
- **Curly braces** always (even single-line blocks)
- **No `eval()`**
- **Unix line endings** (`LF`, not `CRLF`)
- **Arrow spacing** — spaces before/after `=>`
- **Consistent return** — every branch must explicitly return (or none)
- **Array brackets** — no spaces inside `[]`
- **Naming conventions** — enforced on `.tsx` files via `@blitz/eslint-plugin`

```bash
# Lint the project
pnpm lint

# Lint and auto-fix
pnpm lint:fix
```

### Prettier

Integrated with ESLint via `eslint-config-prettier` + `eslint-plugin-prettier`. Running `pnpm lint:fix` applies both ESLint fixes and Prettier formatting.

---

## File Naming Conventions

| Pattern | Meaning |
| ------- | ------- |
| `*.client.tsx` | Browser-only component — never runs on the server |
| `*.server.ts` | Server-only code — never shipped to the client |
| `*.spec.ts` / `*.spec.tsx` | Test files (colocated with source) |
| `api.*.ts` | Remix API route under `app/routes/` |
| `PascalCase.tsx` | React components |
| `camelCase.ts` | Utilities, services, stores |

---

## Import Rules

```typescript
// CORRECT — absolute path alias
import { workbenchStore } from '~/lib/stores/workbench';
import { BaseChat } from '~/components/chat/BaseChat';

// WRONG — relative imports are blocked by ESLint
import { workbenchStore } from '../../stores/workbench';
```

The `~/` alias maps to `app/` and is configured in both `tsconfig.json` and Vite.

---

## Component Patterns

### Client-Only Components

Use the `.client.tsx` suffix for components that depend on browser APIs.

```typescript
// Workbench.client.tsx — uses RuntimeClient, browser-only APIs
export default function Workbench() { /* ... */ }
```

### Scoped Logging

Use `createScopedLogger` from `~/utils/logger` for debug output:

```typescript
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('MyComponent');
logger.debug('Initializing...');
logger.error('Something failed', error);
```

### State in Components

- Read stores with `useStore(someAtom)` from `@nanostores/react`
- Avoid `useState` for shared/global state — use nanostores
- See [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) for patterns

---

## Testing

### Setup

Unit and component tests use **Vitest** with `@testing-library/react` and `@testing-library/jest-dom`. End-to-end tests use **Playwright** (config in `playwright.config.ts`, tests in `e2e/`).

```bash
# Run all unit tests once
pnpm test

# Watch mode
pnpm test:watch

# Run e2e tests (Playwright)
pnpm exec playwright test
```

### Build Verification

The production build command runs TypeScript type-checking before building:

```bash
pnpm run build   # runs: tsc --noEmit && react-router build
```

Always run `pnpm run build` before opening a PR to catch type errors early.

### lint-staged Note

`lint-staged` (via Husky pre-commit hook) may hang on some systems. If your commit hangs, use the `--no-verify` flag:

```bash
git commit -m "feat: my change" --no-verify
```

### Writing Tests

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MyComponent } from '~/components/MyComponent';

describe('MyComponent', () => {
  it('renders correctly', () => {
    render(<MyComponent />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });
});
```

The project currently has 810 tests across 38 spec files.

Recent test expansion areas include:

- **MCP schema sanitization** — 11 tests in `mcpService.spec.ts` covering JSON Schema cleanup for Google Gemini compatibility (`anyOf`, `oneOf`, `allOf`, `additionalProperties` removal)
- **MCP result text extraction** — 16 tests in `ToolInvocations.spec.ts` verifying correct rendering of MCP tool call results
- **Auto-approve toggle** — tests for the MCP auto-approve UI toggle behaviour

### Test File Location

Colocate test files next to source files:

```
components/
  chat/
    Markdown.tsx
    Markdown.spec.ts
```

---

## API Route Conventions

All API routes live in `app/routes/` with the `api.` prefix:

```
api.chat.ts           →  POST /api/chat
api.models.$provider.ts  →  GET /api/models/:provider
```

Every route handler must be wrapped with `withSecurity()` from `~/lib/security`. This is mandatory for all new routes.

### Request Validation

Use Zod for request body validation:

```typescript
import { z } from 'zod';

const RequestSchema = z.object({
  field: z.string().min(1),
});

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.json();
  const parsed = RequestSchema.safeParse(body);

  if (!parsed.success) {
    return json({ error: 'Invalid request' }, { status: 400 });
  }
  // ...
}
```

### Authentication

Credentials come from cookies — never from request bodies or query params:

```typescript
const cookieHeader = request.headers.get('Cookie') || '';
```

---

## Architecture Notes

- **State management** — the project uses **nanostores** (`atom()`, `map()`, `computed()`) for all shared state. Do NOT introduce Redux, Zustand, Jotai, or other state libraries. See [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md)
- **Error classifier** — `app/lib/errors/error-classifier.ts` classifies errors by category (`network`, `auth`, `validation`, `build`, `runtime`, `unknown`) and severity (`fatal`, `error`, `warning`, `info`). Use it to decide routing: fatal/build errors → ChatAlert dialog; recoverable errors → toast notification via `error-toast.ts`
- **No auto-fix pattern** — Bolt does NOT automatically patch or retry on error. All errors are surfaced to the user through ChatAlert or toast. Never add silent error recovery that hides failures from the user

---

## Adding New Features

### New LLM Provider

See [LLM-PROVIDERS.md](LLM-PROVIDERS.md) — step-by-step guide.

> **Extended thinking** is supported for **Anthropic Claude** and **Google Gemini** providers. When adding a new provider, check whether it supports extended/reasoning tokens and wire up the `thinkingBudget` parameter accordingly.

### New Component

1. Create in the appropriate `components/` subdirectory
2. Use `.client.tsx` suffix if browser-only
3. Use scoped logger for debug output
4. Read state from stores, not local state for shared data

### New Store

1. Create in `app/lib/stores/`
2. Use `atom()` or `map()` from `nanostores`
3. Guard with `import.meta.hot?.data` for HMR safety
4. See [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md)

### New API Route

1. Create `api.your-route.ts` in `app/routes/`
2. Export `loader` (GET) or `action` (POST/PUT/DELETE)
3. Validate input with Zod
4. Read credentials from cookies
5. Return `json()` responses with proper status codes
6. Wrap with `withSecurity()` — import from `~/lib/security` and wrap your handler function

### MCP Tool Schema Sanitization

New MCP tools must have JSON Schemas compatible with **Google Gemini**, which rejects `anyOf`, `oneOf`, `allOf`, and `additionalProperties` keywords. The `_sanitizeJsonSchema()` method in `mcpService.ts` handles this automatically at connection time — it recursively strips unsupported keywords and flattens composite schemas into a single `object` type. No manual cleanup is needed when adding MCP servers, but be aware of this constraint when debugging schema-related tool call failures.

---

## Git Workflow

```bash
# Create a feature branch
git checkout -b feature/my-feature

# Make changes, then lint + test
pnpm lint:fix
pnpm test

# Commit with descriptive message
git commit -m "feat: add X to Y"

# Push and open a PR
git push origin feature/my-feature
```

### Commit Message Format

Use conventional commits:

| Prefix | Usage |
| ------ | ----- |
| `feat:` | New feature |
| `fix:` | Bug fix |
| `docs:` | Documentation only |
| `refactor:` | Code restructuring (no behavior change) |
| `test:` | Adding or updating tests |
| `chore:` | Tooling, dependencies, config |

---

## Project Scripts

| Script | Command | Purpose |
| ------ | ------- | ------- |
| `dev` | `pnpm dev` | Start dev server (Remix + Vite) |
| `build` | `pnpm build` | Production build |
| `start` | `pnpm start` | Start production server |
| `lint` | `pnpm lint` | Run ESLint |
| `lint:fix` | `pnpm lint:fix` | ESLint + Prettier auto-fix |
| `test` | `pnpm test` | Run tests (Vitest) |
| `test:watch` | `pnpm test:watch` | Watch mode tests |
| `clean` | `pnpm clean` | Clean build artifacts |
| `update` | `pnpm run update` | Pull latest and reinstall (git users) |
| `docker:build` | `pnpm docker:build` | Build Docker image |
| `docker:run` | `pnpm docker:run` | Run Docker container |
| `docker:up` | `pnpm docker:up` | Start via Docker Compose |
| `docker:down` | `pnpm docker:down` | Stop Docker Compose |
| `docker:dev` | `pnpm docker:dev` | Docker dev mode |
| `docker:update` | `pnpm docker:update` | Update Docker deployment |
| `setup` | `pnpm run setup` | Interactive setup wizard (init .env.local, prompt for keys) |
| `preview` | `pnpm preview` | Build + serve locally |
| `test:coverage` | `pnpm test:coverage` | Run tests with V8 coverage |
| `test:integration` | `pnpm test:integration` | Run integration tests (LocalRuntime, AgentTools) |
