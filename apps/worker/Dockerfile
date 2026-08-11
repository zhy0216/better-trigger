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
#
# examples/basic is baked in (sources + the node_modules the install produced
# for it) so `docker compose up` executes a real task set on a machine that has
# never run `bun install` — nothing is expected to be mounted from the host.
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
# examples/basic devDepends on @better-trigger/testing, so its manifest has to be
# here for `bun install --frozen-lockfile` to resolve the workspace graph.
COPY packages/testing/package.json packages/testing/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY examples/basic/package.json examples/basic/package.json
RUN bun install --frozen-lockfile

COPY packages/core packages/core
COPY packages/kernel packages/kernel
COPY packages/db packages/db
COPY packages/sdk packages/sdk
COPY apps/worker apps/worker
# The dashboard (apps/web) is built inside the worker build step
# (scripts/copy-public.mjs) and embedded into apps/worker/dist/public, so the
# image serves it from the same 4848 port — no second container, port or CORS.
COPY apps/web apps/web
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

# The example task set, so the image is executable on its own. Its sources need
# no build step (bun runs the TypeScript), so they come straight from the build
# context — only node_modules is install output and has to come from `build`.
# That tree is what resolves the module's two imports, and both of its symlinks
# land inside this stage: `better-trigger` -> ../../../packages/sdk and
# `zod` -> ../../../node_modules/.bun/zod@…/node_modules/zod. The workspace
# links it also holds for the example's devDependencies (@better-trigger/testing
# and friends) dangle here — nothing in src/ imports them.
COPY --from=build /app/examples/basic/node_modules examples/basic/node_modules
COPY examples/basic/package.json examples/basic/package.json
COPY examples/basic/src examples/basic/src

EXPOSE 4848

# The *deep* probe (?deep=1): it runs SELECT 1 and answers 503 when Postgres is
# unreachable, so "HTTP process alive, database gone" reads as unhealthy — which
# is what `depends_on: condition: service_healthy` and k8s readiness need. The
# plain /health is liveness only and would call that state healthy.
# Driven by bun rather than curl: the slim image ships no HTTP client, and the
# runtime we already depend on is one. The endpoint is unauthenticated, so no
# key is needed here even with BETTER_TRIGGER_API_KEY set.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 4848}/api/v1/health?deep=1`); process.exit(r.ok ? 0 : 1)"]

# API-only by default — a production image should not execute the examples
# uninvited. Append `--tasks /app/examples/basic/src/tasks.ts` (what
# docker-compose.yml does) to run the bundled example set, or mount your own
# module and point `--tasks` at that.
CMD ["bun", "apps/worker/dist/main.js"]
