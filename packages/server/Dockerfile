# =============================================================================
# @better-trigger/server — production image.
# Built from the monorepo ROOT so workspace packages (core, db) resolve.
#   docker build -f packages/server/Dockerfile -t better-trigger-server .
#
# bun installs workspaces in isolated mode: the store lives in the root
# node_modules/.bun and every package gets its own node_modules of symlinks
# into it — so per-package node_modules must travel with the root one.
# =============================================================================
FROM oven/bun:1.3-slim AS base
WORKDIR /app

# ---- build -----------------------------------------------------------------
# Manifests first for layer caching: the install layer only invalidates when a
# package.json / bun.lock changes. Every workspace member's package.json must
# be present (root workspaces glob + bun.lock cover apps/*, packages/*,
# examples/*) or the frozen install refuses to resolve — only core/db/server
# sources are copied and built though.
FROM base AS build
COPY package.json bun.lock turbo.json tsconfig.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/server/package.json packages/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY examples/basic/package.json examples/basic/package.json
RUN bun install --frozen-lockfile

COPY packages/core packages/core
COPY packages/db packages/db
COPY packages/server packages/server
# Build core + db first (server depends on their dist), then the server.
RUN bun run --cwd packages/core build \
 && bun run --cwd packages/db build \
 && bun run --cwd packages/server build

# ---- runtime ---------------------------------------------------------------
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4848

# Root store + the per-package symlink trees for the packages we actually run.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/packages/core/node_modules packages/core/node_modules
COPY --from=build /app/packages/db/dist packages/db/dist
# migrations are applied at boot; migrate() resolves them relative to db/dist.
COPY --from=build /app/packages/db/migrations packages/db/migrations
COPY --from=build /app/packages/db/package.json packages/db/package.json
COPY --from=build /app/packages/db/node_modules packages/db/node_modules
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/server/package.json packages/server/package.json
COPY --from=build /app/packages/server/node_modules packages/server/node_modules

EXPOSE 4848
CMD ["bun", "packages/server/dist/main.js"]
