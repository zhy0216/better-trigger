difficulty: medium

# 04 · 固定版本、非 root 的 worker runtime 镜像

覆盖方案 F5。只处理容器 runtime 身份、文件权限和 Bun 版本可复现性；CI 中的运行级 smoke 由 07 接线。

## T1 · 固定 Bun 镜像并切换到 bun 用户

- 要做什么：将 Dockerfile 的 build/runtime 基础镜像从可变 `oven/bun:1.3-slim` 对齐到仓库 `packageManager` 与 CI 使用的 `oven/bun:1.3.14-slim`（digest pin 仅在确认多架构更新策略后采用）。runtime stage 使用基础镜像已有的 `bun` 用户（uid/gid 1000）；通过 `COPY --chown`、目录所有权或只读布局保证 `dist`、workspace symlink、migrations、healthcheck 与 task module 可读，不给整个 `/app` 不必要的 root/全局写权限。
- 预计修改文件：`apps/worker/Dockerfile`。
- 验收条件：镜像能完成 frozen production install 与所有 workspace build；`docker run --rm --entrypoint bun <image> -e 'console.log(process.getuid?.())'` 输出非 0（预期 1000）；最终 `Config.User` 非空且为非 root；镜像中仍无 vitest/typescript/eslint/tsdown 等 devDependencies。
- 前置依赖：无。

## T2 · 验证真实 runtime 行为没有被权限收紧破坏

- 要做什么：用临时 PostgreSQL 与只读 task module 启动镜像，覆盖启动 migration、动态 `--tasks` 加载、deep healthcheck 和 SIGTERM 优雅退出。需要写入的路径必须精确挂载/赋权；若发现用户 task 错误依赖 cwd 可写，修正容器布局或明确挂载点，不能退回 root。
- 预计修改文件：`apps/worker/Dockerfile`；如现有 `docker-compose.yml` 的任务挂载确实需要最小权限修正，可同步该文件，但不得扩大网络暴露。
- 验收条件：非 root 容器能连接 PostgreSQL 完成 migration，`/api/v1/health?deep=1` 成功，加载只读 task 文件后能列出任务，并在 SIGTERM 后于现有 grace period 内退出；healthcheck 与默认无 task 的 API-only 启动仍工作。
- 前置依赖：T1。

## 本文件验证

`docker build -f apps/worker/Dockerfile --build-arg GIT_SHA=test-sha -t better-trigger-worker:nonroot .`，随后执行 T1/T2 的 uid、依赖、PostgreSQL、health、只读 tasks 与 SIGTERM smoke；另跑 `bun run typecheck && bun run lint && bun run build && bun run test`。
