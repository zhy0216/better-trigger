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
# Tag pinned to the repo's `packageManager` (bun@1.4.0) and CI's Bun version so
# the image build is reproducible. A digest pin needs a multi-arch update
# policy first — deferred.
FROM oven/bun:1.4.0-slim AS base
WORKDIR /app

# ---- manifests ---------------------------------------------------------------
# Manifests first for layer caching: the install layers below only invalidate
# when a package.json / bun.lock changes. Every workspace member's package.json
# must be present (root workspaces glob + bun.lock cover apps/*, packages/*,
# examples/*) or the frozen install refuses to resolve — only the packages the
# daemon needs are copied and built though.
FROM base AS manifests
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
# apps/docs is a workspace member recorded in bun.lock — `bun install
# --frozen-lockfile` validates the manifests present against the lock's
# workspace list, and this member was the one the list above missed: the
# frozen install refused the whole lockfile (the exact failure P2-20's new
# CI docker job exists to catch). Only the manifest travels; the docs site
# itself is not part of the daemon image.
COPY apps/docs/package.json apps/docs/package.json
COPY examples/basic/package.json examples/basic/package.json

# ---- build -----------------------------------------------------------------
# O4 build provenance: the build stage has NO .git (only the listed paths are
# copied), so the commit identity is injected instead. scripts/write-build-info
# .mjs reads BT_GIT_SHA before falling back to git rev-parse (which fails here)
# — pass it when building:  GIT_SHA=$(git rev-parse --short HEAD) docker compose
# build worker  (CI passes $GITHUB_SHA). Without it the image degrades to
# version-only build metadata.
FROM base AS build
ARG GIT_SHA=
ENV BT_GIT_SHA=$GIT_SHA
COPY --from=manifests /app ./
# Unfiltered on purpose: this stage needs the dev toolchain (tsdown, the
# workspace typescript, the web build the worker embeds). The runtime image
# takes its dependency trees from prod-deps instead, so none of that ships.
RUN bun install --frozen-lockfile

COPY packages/core packages/core
COPY packages/kernel packages/kernel
COPY packages/db packages/db
COPY packages/sdk packages/sdk
COPY apps/worker apps/worker
# The worker build schedules apps/web through Turbo, then copy-public.mjs
# embeds it into apps/worker/dist/public, so the
# image serves it from the same 4848 port — no second container, port or CORS.
COPY apps/web apps/web
# The direct entry schedules core → (kernel, db, sdk, web) → worker.
RUN bun run --cwd apps/worker build

# ---- production dependencies -----------------------------------------------
# The same frozen lockfile installed without devDependencies: ~26 packages
# against the build stage's ~594, because the runtime image has no business
# carrying typescript, vitest, eslint, tsdown or the web toolchain. Workspace
# links survive a production install, so pg / hono / better-trigger → packages/
# sdk all still resolve from the trees copied below. (A `--production` install
# on top of the build stage's node_modules would NOT prune it — bun only
# skips adding dev deps — hence this separate stage.)
FROM base AS prod-deps
COPY --from=manifests /app ./
RUN bun install --frozen-lockfile --production

# ---- runtime ---------------------------------------------------------------
# Runs as the slim image's built-in `bun` user (uid/gid 1000), not root. The
# daemon never writes to disk (Postgres holds all state; static.ts only reads),
# so every COPY below is bun-owned and the tree is effectively read-only — no
# world-writable /app, no `USER 0` fallback. Mount your own task module `:ro`
# alongside its node_modules (see docker-compose.yml) and it resolves the same.
FROM oven/bun:1.4.0-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4848
# A container must bind 0.0.0.0 or the published port reaches nothing — the
# host is where the exposure is decided (publish to 127.0.0.1, see
# docker-compose.yml). Without BETTER_TRIGGER_API_KEY the daemon then refuses
# to start unless BETTER_TRIGGER_ALLOW_UNAUTHENTICATED=1 (or
# --allow-unauthenticated) says the exposure is intended.
ENV BETTER_TRIGGER_HOST=0.0.0.0

# Root store + the per-package symlink trees for the packages we actually run,
# from the production install. core is the one package with no dependency tree
# to copy at all (zero runtime deps, so bun never creates packages/core/
# node_modules) — that absence is the guarantee check:deps enforces.
COPY --chown=bun:bun --from=prod-deps /app/node_modules ./node_modules
COPY --chown=bun:bun --from=build /app/package.json ./package.json
COPY --chown=bun:bun --from=build /app/packages/core/dist packages/core/dist
COPY --chown=bun:bun --from=build /app/packages/core/package.json packages/core/package.json
COPY --chown=bun:bun --from=build /app/packages/kernel/dist packages/kernel/dist
COPY --chown=bun:bun --from=build /app/packages/kernel/package.json packages/kernel/package.json
COPY --chown=bun:bun --from=prod-deps /app/packages/kernel/node_modules packages/kernel/node_modules
COPY --chown=bun:bun --from=build /app/packages/db/dist packages/db/dist
# migrations are applied at boot; migrate() resolves them relative to db/dist.
COPY --chown=bun:bun --from=build /app/packages/db/migrations packages/db/migrations
COPY --chown=bun:bun --from=build /app/packages/db/package.json packages/db/package.json
COPY --chown=bun:bun --from=prod-deps /app/packages/db/node_modules packages/db/node_modules
COPY --chown=bun:bun --from=build /app/packages/sdk/dist packages/sdk/dist
COPY --chown=bun:bun --from=build /app/packages/sdk/package.json packages/sdk/package.json
COPY --chown=bun:bun --from=prod-deps /app/packages/sdk/node_modules packages/sdk/node_modules
COPY --chown=bun:bun --from=build /app/apps/worker/dist apps/worker/dist
COPY --chown=bun:bun --from=build /app/apps/worker/package.json apps/worker/package.json
COPY --chown=bun:bun --from=prod-deps /app/apps/worker/node_modules apps/worker/node_modules

# The example task set, so the image is executable on its own. Its sources need
# no build step (bun runs the TypeScript), so they come straight from the build
# context — only node_modules is install output and has to come from an install
# stage. That tree is what resolves the module's two imports, and both of its
# symlinks land inside this stage: `better-trigger` -> ../../../packages/sdk and
# `zod` -> ../../../node_modules/.bun/zod@…/node_modules/zod. The production
# install never linked the example's devDependencies (@better-trigger/testing &c.)
# at all here — nothing in src/ imports them, and the acceptance harnesses are
# not part of the image.
COPY --chown=bun:bun --from=prod-deps /app/examples/basic/node_modules examples/basic/node_modules
COPY --chown=bun:bun examples/basic/package.json examples/basic/package.json
COPY --chown=bun:bun examples/basic/src examples/basic/src

# Drop to the non-root user for everything the container actually runs
# (main.js, the healthcheck, task loading).
USER bun

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
