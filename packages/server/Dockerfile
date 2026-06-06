# =============================================================================
# @better-trigger/server — production image.
# Built from the monorepo ROOT so workspace packages (core) resolve.
#   docker build -f packages/server/Dockerfile -t better-trigger-server .
# =============================================================================
FROM oven/bun:1.3-slim AS base
WORKDIR /app

# ---- install ---------------------------------------------------------------
# Copy workspace manifests first for better layer caching.
FROM base AS deps
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
RUN bun install --frozen-lockfile

# ---- build -----------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock turbo.json tsconfig.json ./
COPY packages/core packages/core
COPY packages/server packages/server
# Build core first (server depends on its dist), then the server.
RUN bun run --cwd packages/core build \
 && bun run --cwd packages/server build

# ---- runtime ---------------------------------------------------------------
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4848

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/server/package.json packages/server/package.json

EXPOSE 4848
CMD ["bun", "packages/server/dist/main.js"]
