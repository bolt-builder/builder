# ─────────────────────────────────────────────────────────────
# Bolt (bolt.diy) — Multi-stage Docker build
# Optimised for pnpm + React Router v7 on Node 20 LTS
# ─────────────────────────────────────────────────────────────

# ── Stage 1: base ─────────────────────────────────────────────
# Shared base with corepack-managed pnpm
FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.14.4 --activate
WORKDIR /app

# ── Stage 2: deps ─────────────────────────────────────────────
# Install ALL dependencies (dev + prod) for the build step
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── Stage 3: build ────────────────────────────────────────────
# Build the React Router application
FROM deps AS build
COPY . .

# Git info for pre-start.cjs (falls back to 'no-git-info' in Docker)
RUN node pre-start.cjs
RUN pnpm build

# ── Stage 4: prod-deps ───────────────────────────────────────
# Prune to production deps only (@react-router/serve is now a prod dep)
FROM build AS prod-deps
RUN pnpm prune --prod --ignore-scripts

# ── Stage 5: runtime ─────────────────────────────────────────
# Minimal final image — only build output + prod deps
FROM node:20-slim AS runtime
ENV NODE_ENV="production"
ENV PORT="5173"
# Bind all interfaces so published ports work; the bind guard in
# instrument.server.mjs then requires BOLT_AUTH_TOKEN to actually start,
# because the runtime API grants shell execution and file access.
ENV HOST="0.0.0.0"
WORKDIR /app

# git: needed by api.git-info.ts (execSync('git ...'))
# curl: needed for healthchecks on some container platforms
RUN apt-get update && apt-get install -y --no-install-recommends git curl \
    && rm -rf /var/lib/apt/lists/*

# Copy node_modules (includes @react-router/serve needed for runtime)
COPY --from=prod-deps /app/node_modules ./node_modules

# Copy build output
COPY --from=build /app/build ./build

# Copy package.json (needed by @react-router/serve)
COPY --from=build /app/package.json ./

# Copy the server instrumentation / bind-policy guard loaded via --import
COPY --from=build /app/instrument.server.mjs ./

# Non-root user for security
RUN groupadd --system --gid 1001 appgroup && \
    useradd --system --uid 1001 --gid appgroup --create-home appuser && \
    chown -R appuser:appgroup /app
USER appuser

EXPOSE 5173
CMD ["node", "--import", "./instrument.server.mjs", "node_modules/@react-router/serve/dist/cli.js", "./build/server/index.js"]
