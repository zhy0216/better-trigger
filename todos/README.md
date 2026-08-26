# better-trigger TODOs — 全仓库改进点专项（2026-08-26）

本轮条目来自对 kernel / db / sdk / core / worker / web / CI 的全仓库审查。每个文件一个（或一组紧密相关的）问题；文件内保留现状证据、影响、不变量、实现方案和验收标准。条目目前都只是待办，不代表修复已经落地。

## 状态：待办

## 优先级与执行顺序

按 `finish-todo` 规则从高到低串行处理；同一文件完成独立实现、对抗式复核和仓库级校验后，才可以归档到 `todos/done/` 并创建该文件对应的 commit。

| # | 文件 | 一句话 | 依赖 |
|---|------|--------|------|
| 1 | [p0-01-concurrency-env-validation.md](./done/p0-01-concurrency-env-validation.md) ✅ | `BETTER_TRIGGER_CONCURRENCY` env 用裸 `Number()`，拼错值 → NaN → daemon 正常启动但永不领取任务 | — |
| 2 | [p0-02-dashboard-env-propagation.md](./done/p0-02-dashboard-env-propagation.md) ✅ | Dashboard EnvSwitcher 只对 `/runs` 列表生效，详情/Cancel/Retry/tasks/schedules/workers 不带 env，非 prod run 全部 404 或静默显示 prod 数据 | — |
| 3 | [p1-03-embedded-rate-limit.md](./p1-03-embedded-rate-limit.md) | embedded 进程内 fetch 也过 rateLimitMiddleware，高吞吐 embedded 应用会对自己返回 429 | — |
| 4 | [p1-04-heartbeat-reentrancy.md](./p1-04-heartbeat-reentrancy.md) | heartbeat 的 `setInterval` 无重入保护，慢 tick 会并发；stop() 后仍可能把 workers 行重新点亮 | — |
| 5 | [p1-05-sdk-waitforresult-signature.md](./p1-05-sdk-waitforresult-signature.md) | SDK `waitForResult` 签名与文档/兄弟方法不一致；README 漏 namespace 列与 `retryRun.operationKey` | — |
| 6 | [p1-06-dashboard-terminal-polling.md](./p1-06-dashboard-terminal-polling.md) | 终态 run 永久 2s 轮询、不感知页面可见性；loadMore 吞错、动作 401 不进连接注册表 | — |
| 7 | [p1-07-schema-drift-guard.md](./p1-07-schema-drift-guard.md) | schema.ts 自称 single source of truth 但只对 migration 成立；kernel 手写行类型/约束名无编译期保护 | — |
| 8 | [p1-08-ci-release-node-matrix.md](./p1-08-ci-release-node-matrix.md) | 无 release workflow、CI 无 Node 矩阵、publint/attw 未覆盖 kernel/db、残留 `.next` 输出、TS 未使用变量无人查 | — |
| 9 | [p2-09-refactor-monoliths.md](./p2-09-refactor-monoliths.md) | kernel `runs.ts`(2577) / `claimRuns`(315) / `scanWaits`(290) / worker `main.ts`(1246) 拆分，executor 重复模板抽取 | — |
| 10 | [p2-10-kernel-low-hanging.md](./p2-10-kernel-low-hanging.md) | kernel 低挂果：appendLogs 静默丢弃、enqueueMany 陷阱、裸 Error→500、TERMINAL_STATUSES 重复、withTx 样板、prune 索引、注释漂移 | — |
| 11 | [p2-11-worker-low-hanging.md](./p2-11-worker-low-hanging.md) | worker 低挂果：未知 task 租约滞留、stepsTruncated 读 env、AbortError 模板重复、intQuery clamp、PATCH /schedules 限流/审计、Bearer 大小写、handoff 顺序 | — |
| 12 | [p2-12-sdk-web-toolchain-low-hanging.md](./p2-12-sdk-web-toolchain-low-hanging.md) | sdk/web/toolchain 低挂果：SDK_VERSION 硬编码、batchTrigger env 剥离、retry sleep 不感知 AbortSignal、timeoutMs 校验、useTweaks 死代码、VITE_BT_API_URL 注释 | — |

## 执行约定

- 一次只推进一个文件；不可把未完成条目移动到 `todos/done/`。
- 一个文件内部条目多于 6 条时，按 `finish-todo` 规则拆成两个 workflow（先 P0/P1 条目，再其余）。
- 每个条目下面的「推荐实现方案」是实现 agent 的边界，不等于本轮已经修改源代码。
- 只动条目要求的代码；不顺手重构、不改无关文件、不升级依赖。
- P2 里的「低挂果重命名/去重」类条目要格外小心：去重（如 `TERMINAL_STATUSES`）时若某处故意以内联字面量表达独立语义，需保留注释说明差异，不要把语义不同的常量合并。

## 基线校验

- 校验命令：`bun run typecheck` → `bun run build` → `bun run test`（存在哪条跑哪条，全部通过才 commit）。
- kernel 真 PostgreSQL 套件在设置 `DATABASE_URL` 时自动运行、未设置时干净跳过；涉及 kernel/worker 的条目若改到并发/回滚/通知路径，需在真 PG 下复跑。
