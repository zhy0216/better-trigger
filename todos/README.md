# better-trigger TODOs — 全仓库改进点专项（第二轮，2026-09-02）

本轮条目来自对 kernel / worker / sdk / core / web / CI / roadmap 的第二轮全仓库审查（第一轮 12 条见 `done/`）。每个文件一个（或一组紧密相关的）问题；文件内保留现状证据、影响、不变量、实现方案和验收标准。条目目前都只是待办，不代表修复已经落地。

## 状态：进行中（6/8 已归档至 done/）

## 优先级与执行顺序

按 `finish-todo` 规则从高到低串行处理；同一文件完成独立实现、对抗式复核和仓库级校验后，才可以归档到 `todos/done/` 并创建该文件对应的 commit。

| # | 文件 | 一句话 | 依赖 |
|---|------|--------|------|
| 1 | [p0-13-workers-namespace-filter.md](./done/p0-13-workers-namespace-filter.md) ✅ | `GET /workers` 按从不写入的 `project_id/env` 列过滤，真成员关系在 `namespaces` jsonb → 多 namespace 隔离失效，测试还固化了错误谓词 | 已完成：谓词改为 `namespaces` jsonb 的 `EXISTS`，测试补多 namespace 隔离用例 |
| 2 | [p0-14-claim-namespace-starvation.md](./done/p0-14-claim-namespace-starvation.md) | ✅ 已修（方案 2 顺序轮转 `rotateFrom` + `onScanSkipped`）：多 namespace claim 扫描共享配额按数组顺序先到先得，`namespaces[0]` 持续有活时其余 namespace 永久饥饿 | — |
| 3 | [p1-15-sdk-request-protection.md](./done/p1-15-sdk-request-protection.md) ✅ | SDK 响应 body 读取在 timeout/abort 清理之后 → 慢速 body 突破 `timeoutMs` 合约；per-request `timeoutMs` 覆盖绕过校验 | — |
| 4 | [p1-16-config-input-validation.md](./done/p1-16-config-input-validation.md) ✅ | `RetryPolicy` 全链路零校验（NaN/负值直落数据库）；`--lease-ms ≤ 500` 不拒绝（心跳必然晚于租约，reaper 吃光 recoveries）；`requireInt` 不校验整数 | — |
| 5 | [p1-17-dashboard-race-and-errors.md](./done/p1-17-dashboard-race-and-errors.md) ✅ | loadMore/loadOlderLogs 过期响应把旧 env/旧 run 数据写进新列表；Schedules 开关失败吞错、401 不上报；日志流强制滚底打断回读 | 已完成：分页提交加代次守卫（过期响应丢弃）；开关失败对齐 actionError 并 401 上报连接注册表；日志仅在贴底时自动跟随 |
| 6 | [p2-18-kernel-worker-low-hanging-2.md](./p2-18-kernel-worker-low-hanging-2.md) | kernel/worker 低挂果：孤儿 cron schedule 永久触发、LISTEN 重连代数竞态、日志 flush 无背压、waiter sweep 重入、releaseClaims 静默吞错 | — |
| 7 | [p2-19-sdk-web-low-hanging-2.md](./done/p2-19-sdk-web-low-hanging-2.md) ✅ | sdk/web 低挂果：实例级 `batchTrigger` per-item env 类型洞、TweaksPanel 永远不可达、Switch/行/菜单键盘不可用、拖拽监听器泄漏 | 已完成：实例级 item options 收窄为 `BatchItemOptions`；TweaksPanel 受控 + TopBar 开关；Switch/行/Card/Radio/EnvSwitcher 键盘可达；拖拽监听器卸载兜底 |
| 8 | [p2-20-toolchain-ci-low-hanging.md](./p2-20-toolchain-ci-low-hanging.md) | 工具链/CI：ESLint 从不检查 .ts/.tsx、CI 无缓存、Dockerfile 不构建验证且有死 stage、release 无 concurrency/验收门禁、LISTEN/NOTIFY 文档漂移 | — |

## 本轮未收编、后续单独立项的候选（roadmap 缺口）

审查同时核实了 `docs/architecture.md` P2–P6 的交付状态；以下是**新需求**而非缺陷，规模超出本轮条目，留待单独立项：

- **P3 events**：`event()` / `emit` / `wait.forEvent` + `events` 表（requestApproval 与北极星 demo 的地基，内核唯一整块缺失的原语）。
- **P3 fan-out 闭环**：`batchTriggerAndWait` + cancel 父→子级联（当前取消不传子，留孤儿 run）。
- **P2 尾**：持久化边界故障注入 harness（现只有 SIGKILL 一种故障；连接中断/重复投递下的接管承诺仍是空白）。
- **P3 前置**：testing 包虚拟时间（多日 wait 与未来 forEvent 的测试效率）。
- **P4**：`better-trigger-worker migrate` 子命令（cli.ts 已有 prune 模板，半天级）。
- **P5 agent 层**：`ctx.handoff` / `ctx.gather` / `ctx.requestApproval` / `ctx.llm` / `continueAsNew`、multi-agent 示例、dashboard agent 视图（依赖 P3）。
- **P6**：plugin interceptors、eslint-plugin。

## 执行约定

- 一次只推进一个文件；不可把未完成条目移动到 `todos/done/`。
- 一个文件内部条目多于 6 条时，按 `finish-todo` 规则拆成两个 workflow（先 P0/P1 条目，再其余）。
- 每个条目下面的「推荐实现方案」是实现 agent 的边界，不等于本轮已经修改源代码。
- 只动条目要求的代码；不顺手重构、不改无关文件、不升级依赖。
- P2 里的「低挂果」类条目要格外小心：改观测/背压时不得改变既有正确路径的语义；去重/合并常量时语义不同处保留注释说明差异。

## 基线校验

- 校验命令：`bun run typecheck` → `bun run build` → `bun run test`（存在哪条跑哪条，全部通过才 commit）。
- kernel 真 PostgreSQL 套件在设置 `DATABASE_URL` 时自动运行、未设置时干净跳过；涉及 kernel/worker 的条目若改到并发/回滚/通知路径，需在真 PG 下复跑。
