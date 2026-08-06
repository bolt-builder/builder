# Getting Started

> Setup, environment variables, and run commands for Bolt.

---

## Prerequisites

| Requirement | Version |
| ----------- | ------- |
| Node.js | ≥ 18.18.0 |
| pnpm | 9.14.4 (exact, managed via `packageManager` field) |
| Git | Any recent version |

---

## Installation

```bash
# Clone the repository
git clone https://github.com/zebbern/Bolt.git
cd Bolt

# Install dependencies
pnpm install
```

---

## Environment Variables

Create a `.env.local` file in the project root (gitignored). The app loads env files in this priority:

1. `.env.local` (highest priority)
2. `.env`
3. Process environment

### LLM Provider Keys

All provider keys are **optional** — set only the ones for providers you want to use. You can also add keys at runtime through the UI settings panel.

```env
# OpenAI
OPENAI_API_KEY=sk-...

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Google (Gemini)
GOOGLE_GENERATIVE_AI_API_KEY=...

# Mistral
MISTRAL_API_KEY=...

# Groq
GROQ_API_KEY=gsk_...

# OpenRouter
OPEN_ROUTER_API_KEY=sk-or-...

# DeepSeek
DEEPSEEK_API_KEY=...

# Together
TOGETHER_API_KEY=...

# XAI (Grok)
XAI_API_KEY=...

# Cohere
COHERE_API_KEY=...

# HuggingFace
HuggingFace_API_KEY=...

# Perplexity
PERPLEXITY_API_KEY=...

# Amazon Bedrock (JSON format)
AWS_BEDROCK_CONFIG={"region":"us-east-1","accessKeyId":"...","secretAccessKey":"..."}

# Z.ai
ZAI_API_KEY=your-zai-key

# Fireworks
FIREWORKS_API_KEY=...

# Cerebras
CEREBRAS_API_KEY=...
```

### MCP Setup

MCP (Model Context Protocol) servers extend the agent with specialized tools:

- Configure MCP servers in **Settings → MCP Servers** tab
- Supports **streamable-http**, **SSE**, and **stdio** transports
- **Auto-approve** can be toggled per server for trusted servers (skips tool call confirmation)

### Extended Thinking

Extended Thinking (AI reasoning visualization) is available for Anthropic Claude and Google Gemini. Configure it in **Settings → Features** tab.

### Local Model URLs

For self-hosted models, you can also set API keys via the UI settings panel.

```env
# Ollama (default: http://127.0.0.1:11434)
OLLAMA_API_BASE_URL=http://127.0.0.1:11434

# LM Studio (default: http://127.0.0.1:1234)
LMSTUDIO_API_BASE_URL=http://127.0.0.1:1234

# OpenAI-compatible servers
OPENAI_LIKE_API_BASE_URL=http://localhost:8080
OPENAI_LIKE_API_MODELS=model-name-1,model-name-2
```

### Deployment Keys (Optional)

```env
# GitHub (for push-to-repo features)
# Set via UI settings panel — stored in browser cookies

# Vercel
# Set via UI settings panel

# Netlify
# Set via UI settings panel
```

### Encryption Key (Optional)

```env
# Encryption key for API key cookie encryption (AES-256-GCM).
# If omitted or invalid, the app auto-generates a random key at startup.
# For persistent encryption across restarts, generate a 32-byte hex key:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
BOLT_ENCRYPTION_KEY=
```

> **Note**: API keys can also be set through the UI settings panel at runtime. They are stored in browser cookies, not on the server.

> See `.env.example` for the full list of 55+ documented environment variables. Copy it as a starting point: `cp .env.example .env.local`

---

## Running the App

### Development

```bash
pnpm dev
```

This runs `pre-start.cjs` (prints version/commit info) then starts the Vite dev server. Open `http://localhost:5173` (default Vite port).

### Production Build

```bash
pnpm build
pnpm start
```

Builds with Remix + Vite, then serves via `remix-serve` on `http://localhost:3000`.

### Preview (Build + Serve)

```bash
pnpm preview
```

Runs build and start in sequence.

---

## Other Commands

| Command | Purpose |
| ------- | ------- |
| `pnpm test` | Run Vitest test suite (single run) |
| `pnpm test:watch` | Run Vitest in watch mode |
| `pnpm lint` | Lint `app/` with ESLint (cached) |
| `pnpm lint:fix` | Auto-fix lint issues + format with Prettier |
| `pnpm typecheck` | Run TypeScript type checking (`tsc --noEmit`) |
| `pnpm clean` | Remove build artifacts |
| `pnpm run update` | Pull latest code, install deps, rebuild (git clone users) |
| `pnpm docker:build` | Build production Docker image |
| `pnpm docker:run` | Run Docker container standalone |
| `pnpm docker:up` | Start via Docker Compose |
| `pnpm docker:down` | Stop Docker Compose services |
| `pnpm docker:dev` | Dev mode with hot reload in Docker |
| `pnpm docker:update` | Pull latest GHCR image and restart |

---

## Running with Docker

### Quick Start (Pull from GHCR)

```bash
# Copy env template
cp .env.example .env.local
# Edit .env.local with your API keys

# Pull and run
docker compose up -d
```

### Build Locally

```bash
pnpm docker:build    # Build image
pnpm docker:run      # Run standalone
# or
docker compose up -d --build   # Build + run via Compose
```

### Auto-Update (Watchtower)

```bash
# Automatically pulls new images every 5 minutes
docker compose --profile auto-update up -d
```

The `RUNNING_IN_DOCKER=true` environment variable is set automatically in the Docker Compose configuration, which adjusts Ollama and LMStudio base URLs to use `host.docker.internal`.

### Docker Notes

- **`fast-glob`** is a production dependency (not devDependency), so it is available in the Docker production image. If you see `Cannot find module 'fast-glob'` after building, ensure you are on the latest code — this was fixed by moving it from `devDependencies` to `dependencies`.
- **`BOLT_ENCRYPTION_KEY`** gracefully falls back to an auto-generated random key if the variable is missing or invalid. You do not need to set it for Docker to work, but for persistent cookie encryption across container restarts, set a stable 32-byte hex key in your `.env.local` or Docker Compose environment.

---

## Updating Bolt

### Git Clone Users

```bash
pnpm run update              # Pull, install, rebuild
pnpm run update -- --skip-build  # Pull + install only
```

### Docker Users

```bash
pnpm docker:update           # Pull latest image + restart
```

The app shows a blue banner at the top of the page when a new version is available, with instructions for both update methods.

---

## Project Structure Quick Reference

```text
./
├── .dockerignore         # Docker ignore rules
├── .github/workflows/    # CI/CD pipelines
├── Dockerfile            # Production Docker build
├── docker-compose.yml    # Docker Compose config
├── app/                  # Application source code
│   ├── components/       # React components
│   ├── lib/              # Core logic
│   ├── routes/           # Pages + API endpoints
│   ├── styles/           # Global styles
│   ├── types/            # Shared types
│   └── utils/            # Utilities
├── docs/                 # Documentation (you are here)
├── icons/                # Custom SVG icons
├── public/               # Static files
├── scripts/              # Build scripts
└── types/                # Global type declarations
```

---

## Troubleshooting

### Chrome 129 Issue

Chrome version 129 has a known issue with Vite's JavaScript modules in dev mode. The app detects this and shows a warning. Use Chrome Canary or another browser for development, or use the production build (`pnpm preview`).

### Local Runtime

Bolt uses a Local Runtime that executes code on the host machine (not in the browser). If the preview or terminal doesn't load:

- Ensure **Node.js 18+** is installed on the host
- On Windows, **Git Bash** must be available (installed with Git for Windows) — it is the preferred shell
- The projects directory (`~/.bolt/projects/`) must be writable
- **Port conflicts**: the dev server may bind to ports 5173+. Kill orphan Node processes if a port is already in use
- No SharedArrayBuffer, COOP/COEP, or Service Worker requirements — those were WebContainer-only constraints

### Missing Dependencies

```bash
# If you see module resolution errors after pulling
pnpm install

# Nuclear option — clear everything and reinstall
pnpm clean
rm -rf node_modules
pnpm install
```
