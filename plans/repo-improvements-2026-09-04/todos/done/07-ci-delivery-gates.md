difficulty: hard

# 07 · CI 交付物、安全与容器门禁

集中接线方案 F1/F2/F3/F5/F7 的 CI 验收。该文件独占 `.github/workflows/ci.yml`，避免前置实现任务在并行 worktree 中反复冲突。

## T1 · 接入 deterministic audit 与 artifact/package guards

- 要做什么：在主 CI 的 install 后、耗时 build/test 前运行 02 的 `bun run check:audit`，high severity 必须阻断。build/pack 阶段显式执行 01 的双 provenance/artifact guard，确保 Turbo cache 打开时也不会复用旧 SHA 或把 orphan chunk 带入 tgz。扩展现有五包 pack/Node 18/20/22 smoke，验证 06 的 `engines`/`sideEffects` manifest 契约，不复制多份易漂移的内联检查；优先调用前置任务提供的脚本。
- 预计修改文件：`.github/workflows/ci.yml`。
- 验收条件：workflow 在默认 registry 配置无关的情况下稳定审计官方 npm registry并 gate high；缓存命中场景验证当前 `github.sha` 出现在实际 worker artifact 且旧 SHA/orphan 文件不存在；五个 tgz manifest 和 Node matrix 继续通过；现有 typecheck/lint/build/unit/真 PG acceptance 门禁不被削弱。
- 前置依赖：`01-reproducible-worker-artifacts.md`、`02-deterministic-dependency-audit.md`、`06-published-package-metadata.md`。

## T2 · 将 Docker job 提升为 runtime smoke

- 要做什么：在现有 Docker build job 上增加 04 的运行级检查，而非只验证镜像能 build。使用临时 PostgreSQL/显式 Docker network 或等价隔离方式，检查 runtime uid、migration、deep health、只读 `--tasks` 加载与 SIGTERM；所有容器和临时网络在成功/失败时都清理。不得推送镜像或扩大服务端口暴露。
- 预计修改文件：`.github/workflows/ci.yml`。
- 验收条件：CI 明确断言 uid 非 0、deep health 为 2xx、任务可加载、SIGTERM 在 grace period 内退出；故意移除 `USER` 或破坏文件读取权限时 job 会失败；Docker smoke 无外部 publish、副作用和残留资源。
- 前置依赖：`04-non-root-pinned-worker-image.md`；与 T1 合并在同一 workflow commit。

## 本文件验证

使用 `actionlint`（若仓库环境可用）或等价 YAML/workflow 校验；本地逐条执行 workflow 中新增脚本。最终跑 `bun run check:audit && bun run typecheck && bun run lint && bun run build && bun run test && bun run check:deps && bun run check:drift && bun run check:exports`，并执行完整 Docker runtime smoke。
