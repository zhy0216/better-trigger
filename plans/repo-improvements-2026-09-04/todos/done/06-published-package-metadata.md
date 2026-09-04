difficulty: easy

# 06 · 发布包运行时与副作用元数据

覆盖方案 F7。五个实际发布包是 `@better-trigger/core`、`@better-trigger/db`、`@better-trigger/kernel`、`better-trigger`（SDK）和 `@better-trigger/worker`；private 的 `@better-trigger/testing` 不进入此任务。

## T1 · 给每个发布 tarball 声明 Node 18 下限

- 要做什么：在 core/db/kernel 子包补 `engines.node: ">=18"`，并核对 SDK/worker 已有声明保持相同。根 package 的 engines 不能当作子包发布元数据。不要借机提高最低版本；所有 tsdown target 继续与 Node 18 对齐。
- 预计修改文件：`packages/core/package.json`、`packages/db/package.json`、`packages/kernel/package.json`；核对但通常无需修改 `packages/sdk/package.json`、`apps/worker/package.json` 及五个 `tsdown.config.ts`。
- 验收条件：五个 tgz 内的 `package/package.json` 都含精确的 `engines.node >=18`；Node 18/20/22 下五个入口的 ESM+CJS clean-install smoke 通过；`bun run check:exports` 无 engines 建议/错误。
- 前置依赖：`01-reproducible-worker-artifacts.md`、`02-deterministic-dependency-audit.md`。

## T2 · 基于入口审计声明 sideEffects

- 要做什么：逐包审计 `src/index.ts`、SDK `src/internal.ts`、worker `src/embedded.ts`/CLI entry 及其静态导入链，确认是否存在顶层注册、I/O、定时器或全局状态修改。只有确认纯的包/入口才声明 `sideEffects: false`；若某入口有必要副作用，使用精确文件模式保留，禁止对五包一刀切。
- 预计修改文件：`packages/core/package.json`、`packages/db/package.json`、`packages/kernel/package.json`、`packages/sdk/package.json`、`apps/worker/package.json`；源文件仅用于审计，不为迎合声明改写运行时行为。
- 验收条件：五个 pack manifest 都有与审计结论一致的 `sideEffects`；用最小 bundler/tree-shaking fixture 证明纯未使用入口可消除，同时必要副作用入口不会被错误丢弃；publint/attw 通过，worker CLI 与 embedded smoke 通过。
- 前置依赖：T1。

## 本文件验证

`bun run build && bun run check:exports && bun run typecheck && bun run lint && bun run test`；对五个目录执行 `bun pm pack`，解析 tgz manifest，并在 Node 18/20/22 分别验证全部公开 ESM/CJS 入口。
