# Deployment

> Deploy integrations for Vercel, Netlify, GitHub, and GitLab in Bolt.

---

## Overview

Bolt supports deploying generated projects to four platforms directly from the UI. All deployment credentials are managed through browser cookies (set via the Settings panel).

---

## Docker Self-Hosting

### Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/zebbern/Bolt.git
cd Bolt

# 2. Copy environment template
cp .env.example .env.local
# Edit .env.local with your API keys

# 3. Run with Docker Compose (pulls from GHCR)
docker compose up -d
```

### Building Locally

```bash
pnpm docker:build              # Build image locally
pnpm docker:run                # Run standalone container
docker compose up -d --build   # Build + run via Compose
```

### Docker Image

The project publishes Docker images to GitHub Container Registry on every push to `main`:

- **Image**: `ghcr.io/zebbern/bolt:latest`
- **Base**: `node:20-slim` with `git` and `curl`
- **Size**: ~1.5 GB
- **User**: Non-root (`appuser:1001`)

### Docker Compose Profiles

| Profile | Command | Description |
| --- | --- | --- |
| Default | `docker compose up -d` | Production mode |
| Dev | `docker compose --profile dev up bolt-dev` | Dev mode with hot reload |
| Auto-Update | `docker compose --profile auto-update up -d` | Adds Watchtower for automatic updates |

### Environment Variables

Set `RUNNING_IN_DOCKER=true` in your Docker environment (automatically set in docker-compose.yml). This adjusts Ollama and LMStudio base URLs to use `host.docker.internal` instead of `localhost`.

Add `ZAI_API_KEY=your-zai-key` if using the Z.ai provider.

See `.env.example` for the complete list of 55+ environment variables.

### MCP Servers in Docker

MCP servers configured in the UI persist to `localStorage` in the browser. However, any MCP servers requiring local **stdio** transport need the Docker container to have access to those binaries (e.g., mounted volumes or installed in the image). HTTP-based transports (streamable-http, SSE) work without additional container configuration as long as the container can reach the MCP server's URL.

---

## CI/CD Pipeline

### GitHub Actions

The workflow at `.github/workflows/docker-publish.yml` automatically builds and pushes Docker images to GHCR.

**Triggers:**
- Push to `main` branch → tags image as `latest` and `sha-<hash>`
- Push version tag (e.g., `v1.0.0`) → tags image as `1.0.0` and `1.0`

**Features:**
- Docker Buildx with GitHub Actions cache for fast rebuilds
- Multi-stage build (base → deps → build → prod-deps → runtime)
- Automatic authentication via `GITHUB_TOKEN`

---

## Update System

### Version Check

The `/api/version-check` endpoint compares the local git commit hash against the latest commit on `main` via the GitHub API. The `UpdateBanner` component in the UI uses this to show a non-intrusive notification when updates are available.

### Updating

**Git Clone users:**
```bash
pnpm run update                # Pulls latest, installs, rebuilds
pnpm run update -- --skip-build  # Skip rebuild
```

**Docker users:**
```bash
pnpm docker:update   # docker compose pull && docker compose up -d
```

**Docker auto-update (Watchtower):**
```bash
docker compose --profile auto-update up -d
```

Watchtower polls GHCR every 5 minutes and automatically restarts the container when a new image is available.

---

## Supported Platforms

| Platform | Push Code | Deploy | Custom Domains | Status Check |
| -------- | --------- | ------ | -------------- | ------------ |
| GitHub | Yes | Via GitHub Pages/Actions | No | Yes |
| GitLab | Yes | Via GitLab CI | No | Yes |
| Vercel | Yes | Yes (direct) | Yes | Yes |
| Netlify | No | Yes (direct) | No | Yes |

---

## GitHub Integration

### Setup

1. Open Settings (sidebar menu) → GitHub tab
2. Enter your GitHub **Personal Access Token** (needs `repo` scope)
3. Optionally set a default username

### Features

- **Push to Repository**: Push generated code to a new or existing GitHub repo
- **Clone from GitHub**: Start a project from any public/private repo
- **Branch Management**: Create branches, push to branches
- **Template Loading**: Load starter templates from GitHub

### API Routes

| Route | Purpose |
| ----- | ------- |
| `/api/github-user` | Validate token and get user info |
| `/api/github-branches` | List repository branches |
| `/api/github-stats` | Repository statistics |
| `/api/github-template` | Clone/template a repository |

### Components

| Component | Location |
| --------- | -------- |
| `GitHubDeploy.client.tsx` | `components/deploy/` |
| `GitHubDeploymentDialog.tsx` | `components/deploy/` |
| GitHub Settings Tab | `components/@settings/tabs/github/` |

### State

| Store | Purpose |
| ----- | ------- |
| `stores/github.ts` | Repository selection, push state |
| `stores/githubConnection.ts` | Auth token, user info |

---

## GitLab Integration

### Setup

1. Open Settings → GitLab tab
2. Enter your GitLab **Personal Access Token** (needs `api` scope)
3. Set your GitLab instance URL (defaults to `gitlab.com`)

### Features

- **Push to Project**: Push code to GitLab projects
- **Clone from GitLab**: Import existing projects
- **Branch Management**: List and create branches

### API Routes

| Route | Purpose |
| ----- | ------- |
| `/api/gitlab-projects` | List user's projects |
| `/api/gitlab-branches` | List project branches |

### State

| Store | Purpose |
| ----- | ------- |
| `stores/gitlab.ts` | Auth token, instance URL, user info |

---

## Vercel Integration

### Setup

1. Open Settings → Vercel tab
2. Enter your Vercel **API Token** ([vercel.com/account/tokens](https://vercel.com/account/tokens))

### Features

- **Direct Deploy**: Deploy projects directly to Vercel
- **Domain Management**: Add/manage custom domains
- **Deployment Status**: Track deployment progress

### API Routes

| Route | Purpose |
| ----- | ------- |
| `/api/vercel-deploy` | Deploy project / check status |
| `/api/vercel-user` | Validate token, get user info |
| `/api/vercel-domains` | List/manage domains |
| `/api/vercel-proxy` | Proxy API requests |

### Components

| Component | Location |
| --------- | -------- |
| `VercelDeploy.client.tsx` | `components/deploy/` |
| `VercelDomainModal.tsx` | `components/deploy/` |
| Vercel Settings Tab | `components/@settings/tabs/vercel/` |

### State

| Store | Purpose |
| ----- | ------- |
| `stores/vercel.ts` | Deployment state, project info |

---

## Netlify Integration

### Setup

1. Open Settings → Netlify tab
2. Enter your Netlify **Personal Access Token** ([app.netlify.com/user/applications](https://app.netlify.com/user/applications))

### Features

- **Direct Deploy**: Deploy projects directly to Netlify
- **Site Status**: Track deployment status

### API Routes

| Route | Purpose |
| ----- | ------- |
| `/api/netlify-deploy` | Deploy project |
| `/api/netlify-user` | Validate token, get user info |

### Components

| Component | Location |
| --------- | -------- |
| `NetlifyDeploy.client.tsx` | `components/deploy/` |
| Netlify Settings Tab | `components/@settings/tabs/netlify/` |

### State

| Store | Purpose |
| ----- | ------- |
| `stores/netlify.ts` | Deployment state |

---

## Supabase Integration

### Setup

1. Open Settings → Supabase tab
2. Enter your Supabase **Project URL** and **Anon Key**

### Features

- **Database Queries**: Execute SQL queries against Supabase
- **Environment Variables**: Manage project environment variables
- **Connection Status**: Monitor Supabase connectivity

### API Routes

| Route | Purpose |
| ----- | ------- |
| `/api/supabase` | Project management |
| `/api/supabase-user` | User info |
| `/api/supabase/query` | Execute SQL queries |
| `/api/supabase/variables` | Environment variable management |

---

## Credential Management

All deployment credentials follow the same pattern:

1. **Set via Settings UI** — user enters token in the appropriate settings tab
2. **Stored in cookies** — credentials saved in browser cookies (client-side)
3. **Sent per request** — API routes read credentials from the `Cookie` header
4. **No server storage** — credentials never persist on the server

```typescript
// How API routes read credentials:
const cookieHeader = request.headers.get('Cookie') || '';
const cookies = parseCookies(cookieHeader);
const token = cookies['githubToken'] || '';
```

---

## Deploy Button

The header contains a **Deploy** button (`DeployButton.tsx`) that opens a dropdown with available deployment options. Each option opens a modal dialog for that platform's deployment workflow.

```text
[Deploy ▾]
├── Push to GitHub
├── Push to GitLab
├── Deploy to Vercel
└── Deploy to Netlify
```

Only platforms with configured credentials are shown as active options.
