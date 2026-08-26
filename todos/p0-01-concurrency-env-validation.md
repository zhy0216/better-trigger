# P0-01 — `BETTER_TRIGGER_CONCURRENCY` env 无校验，拼错值会让 daemon 静默不领任务

- 优先级：P0（高危静默失败）
- 区域：apps/worker（启动配置）
- 状态：待办
- 来源：2026-08-26 全仓库审查

## 问题摘要

`PORT`、`BETTER_TRIGGER_CONCURRENCY` 的 env 回退用裸 `Number()` 无校验。`BETTER_TRIGGER_CONCURRENCY=abc` → `NaN` → `Array.from({ length: NaN })` 长度为 0 → daemon 正常启动、只服务 API，**一个 claim 循环都不起，永远不领取任何任务**，且无任何日志。CLI flag 路径有 `requireInt` 校验，env 路径漏了。

## 现状证据

- `apps/worker/src/main.ts:382,390` — env 回退裸 `Number()`。
- `apps/worker/src/runtime.ts:345` — `Array.from({ length: concurrency })`，NaN 时长度 0。
- CLI flag 路径的 `requireInt` 是既有正确范式。

## 影响与不变量

- 配置拼写错误必须在启动期以明确报错失败，不允许退化为「只服务 API、不执行任务」的静默状态。
- `0` 应有明确定义（现有 flag 语义）；非法（NaN、负数、小数）启动即报错。
- 不改变合法配置的既有行为。

## 推荐实现方案

- 把 env 回退路径与 flag 路径统一走同款 `requireInt` 校验（或抽公共 `parsePositiveIntEnv`），启动时即抛错并退出。
- 补一条启动期单测：`BETTER_TRIGGER_CONCURRENCY=abc` 应报错退出而非静默起 0 个 claim 循环。

## 验收标准

- [ ] `BETTER_TRIGGER_CONCURRENCY=abc` 启动报错并退出（或明确拒绝），不再静默不领任务。
- [ ] 合法值（含 0 与正整数）行为与现状一致。
- [ ] `bun run typecheck`、`bun run build`、`bun run test` 全部通过。

## 涉及文件

- `apps/worker/src/main.ts:382,390`
- `apps/worker/src/runtime.ts:345`
- `apps/worker/test/`（新增启动期校验测试）
