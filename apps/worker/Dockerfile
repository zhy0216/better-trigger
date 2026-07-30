# =============================================================================
# @better-trigger/worker — production image.
# Built from the monorepo ROOT so workspace packages resolve.
#   docker build -f apps/worker/Dockerfile -t better-trigger-worker .
#
# bun installs workspaces in isolated mode: the store lives in the root
# node_modules/.bun and every package gets its own node_modules of symlinks
# into it — so per-package node_modules must travel with the root one.
#
# The image runs under bun, so `--tasks` may point at TypeScript directly.
# =============================================================================
FROM oven/bun:1.3-slim AS base
WORKDIR /app

# ---- build -----------------------------------------------------------------
# Manifests first for layer caching: the install layer only invalidates when a
# package.json / bun.lock changes. Every workspace member's package.json must
# be present (root workspaces glob + bun.lock cover apps/*, packages/*,
# examples/*) or the frozen install refuses to resolve — only the packages the
# daemon needs are copied and built though.
FROM base AS build
COPY package.json bun.lock turbo.json tsconfig.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/kernel/package.json packages/kernel/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY examples/basic/package.json examples/basic/package.json
RUN bun install --frozen-lockfile

COPY packages/core packages/core
COPY packages/kernel packages/kernel
COPY packages/db packages/db
COPY packages/sdk packages/sdk
COPY apps/worker apps/worker
# Dependency order: core → (kernel, db, sdk) → worker.
RUN bun run --cwd packages/core build \
 && bun run --cwd packages/kernel build \
 && bun run --cwd packages/db build \
 && bun run --cwd packages/sdk build \
 && bun run --cwd apps/worker build

# ---- runtime ---------------------------------------------------------------
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4848
# A container must bind 0.0.0.0 or the published port reaches nothing — the
# host is where the exposure is decided (publish to 127.0.0.1, see
# docker-compose.yml). Without BETTER_TRIGGER_API_KEY the daemon then refuses
# to start unless BETTER_TRIGGER_ALLOW_UNAUTHENTICATED=1 (or
# --allow-unauthenticated) says the exposure is intended.
ENV BETTER_TRIGGER_HOST=0.0.0.0

# Root store + the per-package symlink trees for the packages we actually run.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/packages/core/node_modules packages/core/node_modules
COPY --from=build /app/packages/kernel/dist packages/kernel/dist
COPY --from=build /app/packages/kernel/package.json packages/kernel/package.json
COPY --from=build /app/packages/kernel/node_modules packages/kernel/node_modules
COPY --from=build /app/packages/db/dist packages/db/dist
# migrations are applied at boot; migrate() resolves them relative to db/dist.
COPY --from=build /app/packages/db/migrations packages/db/migrations
COPY --from=build /app/packages/db/package.json packages/db/package.json
COPY --from=build /app/packages/db/node_modules packages/db/node_modules
COPY --from=build /app/packages/sdk/dist packages/sdk/dist
COPY --from=build /app/packages/sdk/package.json packages/sdk/package.json
COPY --from=build /app/packages/sdk/node_modules packages/sdk/node_modules
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/apps/worker/package.json apps/worker/package.json
COPY --from=build /app/apps/worker/node_modules apps/worker/node_modules

EXPOSE 4848
# Append `--tasks <module>` (and mount it) to make this an executing node.
CMD ["bun", "apps/worker/dist/main.js"]
