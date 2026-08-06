<div align="center">

<img width="236" height="79" alt="bolt" src="https://github.com/user-attachments/assets/30c464d9-39a9-4c0d-85f8-64473cfa774c" />

**AI-powered vibe coding platform — describe what you want, watch it build.**

[![Node](https://img.shields.io/badge/Node-18.18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

[Features](#features) · [Quick Start](#quick-start) · [Environment Variables](#environment-variables) · [Docker](#docker) · [Tech Stack](#tech-stack) · [Contributing](#contributing)

![Bolt Screenshot](https://github.com/user-attachments/assets/e4c3067d-2539-4b5e-abab-d129d90b51dc)

</div>

---

## What is Bolt?

Bolt is a **local AI-powered vibe coding platform** forked from [bolt.diy](https://github.com/stackblitz-labs/bolt.diy). Describe what you want to build in natural language, and an AI agent generates full-stack applications in a browser-based IDE with an integrated editor, terminal, and live preview.

This is a **local development tool**, not a hosted web service. You run it on your own machine, bring your own API keys, and keep full control of your code.

---

## Features

- **Real-time code generation** — AI streaming produces code as you watch, with live diffs applied to the editor.
- **In-browser code execution** — run and preview generated applications directly in the browser via WebContainer.
- **22+ LLM providers** — OpenAI, Anthropic, Google, xAI, Groq, Mistral, DeepSeek, OpenRouter, Ollama, LM Studio, and [more](docs/LLM-PROVIDERS.md). Swap models mid-conversation.
- **Agent mode** — handles complex multi-step tasks with autonomous planning and execution.
- **Template system** — start from React, Astro, Vite + Shadcn, and other popular boilerplates, then customise with AI.
- **Git integration** — built-in version control with commit, branch, and push support.
- **Smart terminal** — integrated terminal with error detection and intelligent alerts that help the agent auto-fix failures.
- **Speech-to-text** — dictate prompts instead of typing.
- **File upload** — attach files and images to prompts for additional context.
- **Dark / light themes** — system-aware theme switching.
- **Framer Motion animations** — smooth chat animations and transitions.
- **Error classification** — errors are categorised and routed to toast notifications or dialog windows based on severity.
- **Deploy from the UI** — push to GitHub, GitLab, Netlify, or Vercel directly.

---

## Quick Start

### Prerequisites

| Requirement | Version |
|---|---|
| **Node.js** | ≥ 18.18.0 |
| **pnpm** | 9.x (see below) |

Enable pnpm via Corepack:

```bash
corepack enable
corepack prepare pnpm@9.14.4 --activate
```

### Setup

```bash
git clone https://github.com/bolt-builder/builder.git
cd Bolt
cp .env.example .env.local      # add at least one API key
pnpm install
pnpm run dev
```

Open [http://localhost:5173](http://localhost:5173).

> The first load can take up to two minutes while dependencies compile.

---

## Environment Variables

Copy the example file and fill in your API keys:

```bash
cp .env.example .env.local
```

Or run the interactive setup wizard:

```bash
pnpm run setup
```

At minimum, add one AI provider key:

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_GENERATIVE_AI_API_KEY=AI...
```

You can also configure providers at runtime via **Settings → Providers** in the UI.

See [`.env.example`](.env.example) for the full list of supported variables including deployment tokens, local provider URLs, and encryption settings.

### Supported LLM Providers

| Provider | Env Variable | Notes |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | GPT-4o, o1 series |
| Anthropic | `ANTHROPIC_API_KEY` | Claude 3.5 / 4 |
| Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini models |
| xAI | `XAI_API_KEY` | Grok models |
| Groq | `GROQ_API_KEY` | Fast inference |
| Mistral | `MISTRAL_API_KEY` | Mistral Large / Small |
| DeepSeek | `DEEPSEEK_API_KEY` | DeepSeek Chat, Coder |
| Cohere | `COHERE_API_KEY` | Command R+ |
| Perplexity | `PERPLEXITY_API_KEY` | Search-augmented |
| Together | `TOGETHER_API_KEY` | Open-source models |
| Fireworks | `FIREWORKS_API_KEY` | Fast inference |
| Cerebras | `CEREBRAS_API_KEY` | Fast inference |
| HuggingFace | `HuggingFace_API_KEY` | Inference API |
| OpenRouter | `OPEN_ROUTER_API_KEY` | Multi-provider routing |
| GitHub Models | `GITHUB_API_KEY` | GitHub-hosted models |
| Moonshot | `MOONSHOT_API_KEY` | Kimi models |
| Hyperbolic | `HYPERBOLIC_API_KEY` | Hyperbolic inference |
| Z.ai | `ZAI_API_KEY` | GLM coding models |
| Amazon Bedrock | `AWS_BEDROCK_CONFIG` | AWS-hosted models (JSON) |
| Ollama | `OLLAMA_API_BASE_URL` | Local models, no key needed |
| LM Studio | `LMSTUDIO_API_BASE_URL` | Local models, no key needed |
| OpenAI-Like | `OPENAI_LIKE_API_BASE_URL` | Any compatible API |

See [docs/LLM-PROVIDERS.md](docs/LLM-PROVIDERS.md) for details on configuring each provider.

### Encryption

Set `BOLT_ENCRYPTION_KEY` to persist encrypted API-key cookies across server restarts. Generate a key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

If omitted, a random key is generated on each startup and cookies will not survive restarts.

---

## Docker

No local Node.js required — just Docker.

```bash
git clone https://github.com/bolt-builder/builder.git
cd Bolt
cp .env.example .env.local      # add at least one API key
docker compose up -d
```

Open [http://localhost:5173](http://localhost:5173).

### Docker Commands

```bash
pnpm docker:build          # Build image locally
pnpm docker:run            # Run standalone container
pnpm docker:up             # Start via Docker Compose
pnpm docker:down           # Stop services
pnpm docker:dev            # Dev mode with hot reload
pnpm docker:update         # Pull latest image + restart
```

### Compose Profiles

| Profile | Command | Description |
|---|---|---|
| *(default)* | `docker compose up -d` | Production — pulls from GHCR |
| `dev` | `docker compose --profile dev up` | Development — bind-mount with hot reload |
| `auto-update` | `docker compose --profile auto-update up -d` | Adds Watchtower for automatic image updates |

> Set `BOLT_ENCRYPTION_KEY` in your environment or `.env.local` to persist encrypted cookies across container restarts.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React Router v7 (Remix) |
| UI | React 19 |
| Build | Vite 5 |
| Language | TypeScript 5 (strict) |
| Styling | UnoCSS + SCSS + Radix UI |
| Database | Drizzle ORM |
| State | Nanostores |
| AI | Vercel AI SDK (22 providers) |
| Runtime | WebContainer API |
| Editor | CodeMirror 6 |
| Terminal | xterm.js |
| Testing | Vitest + Testing Library + Playwright |
| Package Manager | pnpm 9.14.4 |

---

## Development

### Scripts

```bash
pnpm run dev               # Start dev server (http://localhost:5173)
pnpm run build             # Production build
pnpm run start             # Run production build
pnpm run preview           # Build + preview locally

pnpm test                  # Run test suite
pnpm test:watch            # Tests in watch mode
pnpm run typecheck         # TypeScript type check
pnpm run lint              # ESLint check
pnpm run lint:fix          # Auto-fix lint issues

pnpm run clean             # Clean build artifacts
pnpm run update            # Pull latest + install + rebuild
```

### Updating

```bash
# From source
pnpm run update                    # pull, install, rebuild
pnpm run update -- --skip-build    # pull + install only

# Docker
pnpm docker:update                 # pull latest image, restart
```

### Project Structure

<details>
<summary>Expand file tree</summary>

```
bolt/
├── app/
│   ├── components/         # React components
│   │   ├── @settings/      # Settings panel
│   │   ├── chat/           # Chat interface
│   │   ├── deploy/         # Deployment integrations
│   │   ├── editor/         # Code editor (CodeMirror)
│   │   ├── git/            # Git integration
│   │   ├── header/         # App header
│   │   ├── sidebar/        # Sidebar navigation
│   │   ├── templates/      # Template gallery
│   │   ├── ui/             # Shared UI components
│   │   └── workbench/      # Development workbench
│   ├── lib/
│   │   ├── .server/        # Server-only code (LLM streaming)
│   │   ├── agent/          # Agent prompts + orchestration
│   │   ├── common/         # Prompt library + shared prompts
│   │   ├── hooks/          # Custom React hooks
│   │   ├── modules/        # Feature modules (22 LLM providers)
│   │   ├── persistence/    # IndexedDB, localStorage, autoBackup
│   │   ├── runtime/        # Action runner, message parser
│   │   ├── services/       # API services
│   │   ├── stores/         # Nanostores
│   │   └── utils/          # Utilities
│   ├── routes/             # Routes (pages + API endpoints)
│   ├── styles/             # Global styles (SCSS + CSS)
│   └── types/              # TypeScript type definitions
├── docs/                   # Extended documentation
├── drizzle/                # Database migrations
└── scripts/                # Build & update scripts
```

</details>

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Run checks: `pnpm lint:fix && pnpm test`
4. Commit with a [conventional message](https://www.conventionalcommits.org/): `git commit -m 'feat: add my feature'`
5. Push and open a Pull Request

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for detailed guidelines including code style, testing patterns, and API route conventions.

---

## Acknowledgements

Bolt is forked from [bolt.diy](https://github.com/stackblitz-labs/bolt.diy) (originally StackBlitz bolt.new). Built with the [Vercel AI SDK](https://sdk.vercel.ai/).

---

## License

[AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0)

---

<div align="center">
  <strong>Build anything with AI. Just describe what you want.</strong>
  <br><br>
  <a href="https://github.com/bolt-builder/builder">GitHub</a> ·
  <a href="https://github.com/bolt-builder/builder/issues">Issues</a> ·
  <a href="docs/">Documentation</a>
</div>