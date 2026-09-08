# 执行队列 · repo-improvements-2026-09-07

方案：[../plan.md](../plan.md)。18 项发现合为 9 个任务；R1–R7 roadmap 不入队。初始状态：全部待执行。

## 执行偏好

default_agent: codex

来源：本次 Codex 宿主。没有用户全局模型/推理覆盖，没有单任务 agent 指定；各 todo 的 `agent: inherit` 读取此处默认值，不因换 session 改成别的 CLI。按共享 agent-routing 规则解析模型：easy= gpt-6-astra/high，medium= gpt-6-astra/xhigh，hard= gpt-6-astra/max。表内展示实际解析结果，均继承默认。

协调器：Codex、gpt-6-astra、high；执行任务各自按难度选强度。协调器、任务、补位/重启均显式使用 `--dangerously-bypass-approvals-and-sandbox`。不能把旧计划的固定 xhigh 当成本队列覆盖。

## 优先级

| 文件 | 优先级 | 难度 | agent / 来源 | 模型 / Codex 推理强度 | 一句话说明 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| [01-browser-control-origins.md](done/01-browser-control-origins.md) | P1 | medium | codex / 继承 | gpt-6-astra / xhigh | 无 body 控制请求的浏览器来源检查（F1） | 已完成（已 rebase main 并通过验收、文档已同步，待协调器集成） |
| [02-core-json-error-boundaries.md](done/02-core-json-error-boundaries.md) | P1 | medium | codex / 继承 | gpt-6-astra / xhigh | JSON 值保真及不再抛错的诊断边界（F2–F4） | 已完成，待协调器集成 |
| [03-replay-canonicalization.md](done/03-replay-canonicalization.md) | P1 | hard | codex / 继承 | gpt-6-astra / max | 消除指纹递归和输入碰撞（F5–F6） | 已完成：T1/T2，已 rebase main 并复核；13 组旧指纹 golden、11 项新 PG 回归及根 PG 1,883 tests 通过，首次失败与兼容限制保留，待协调器集成 |
| [04-namespace-pair-isolation.md](done/04-namespace-pair-isolation.md) | P1 | hard | codex / 继承 | gpt-6-astra / max | cron 与指标按真实 namespace pair 隔离（F7–F8） | 已完成，已 rebase main 并通过复核，待协调器集成 |
| [05-probe-deadline-lifecycle.md](done/05-probe-deadline-lifecycle.md) | P1 | hard | codex / 继承 | gpt-6-astra / max | deadline 后连接和查询的清理（F9–F10） | 已完成：T1–T2，已 rebase main 并复核；局部 92 / 故障 PG 6 / health-pool 4 / 根 PG 1,841 tests 通过，首次失败及 SQL 取消边界保留，待协调器集成 |
| [06-worker-numeric-limits.md](06-worker-numeric-limits.md) | P1 | hard | codex / 继承 | gpt-6-astra / max | runtime timer 和 pool 参数的底层范围（F11–F12） | 待执行 |
| [07-dashboard-query-lifecycle.md](done/07-dashboard-query-lifecycle.md) | P1 | hard | codex / 继承 | gpt-6-astra / max | 分页、凭据切换和终态读取竞态（F13–F15） | 已完成：T1–T3，已 rebase main；局部 103 / 根 PG 1,776 tests 通过，保留首次 waiters 失败及复核记录 |
| [08-run-detail-async-controls.md](done/08-run-detail-async-controls.md) | P1 | medium | codex / 继承 | gpt-6-astra / xhigh | 运行操作的迟到 UI 副作用与复制反馈回归（F16–F17） | 已完成：已 rebase main 并复核，局部 95 / 根 PG 1,818 tests 通过；复制 effect 竞态已受控复现并修复，保留历史首次失败归因边界；待协调器集成 |
| [09-docs-workflow-concurrency.md](done/09-docs-workflow-concurrency.md) | P2 | easy | codex / 继承 | gpt-6-astra / high | 隔离 docs PR 与 main 发布的并发组（F18） | 已完成：PR 按编号取消旧构建，发布串行且权限限于 deploy；本地 docs 与根 gate（PG 1,594 tests）通过 |

## 文件

1. 01-browser-control-origins.md — 依赖：无。
2. 02-core-json-error-boundaries.md — 依赖：无。
3. 03-replay-canonicalization.md — 依赖 02-core-json-error-boundaries.md。
4. 04-namespace-pair-isolation.md — 依赖：无。
5. 05-probe-deadline-lifecycle.md — 依赖 04-namespace-pair-isolation.md（metrics 同文件）。
6. 06-worker-numeric-limits.md — 依赖 04-namespace-pair-isolation.md（orchestrator 同文件）。
7. 07-dashboard-query-lifecycle.md — 依赖：无。
8. 08-run-detail-async-controls.md — 依赖 07-dashboard-query-lifecycle.md。
9. 09-docs-workflow-concurrency.md — 依赖：无。

## 并行、资源与集成

按 README 顺序选择当前可运行任务。首批：01、02、04、07、09。02 合入后开放 03；04 合入后开放 05/06；07 合入后开放 08。依赖须通过复核并集成后才能开工。最多 5 个未集成任务，可按机器资源减少并行。

文件边界见 plan 及各 todo。05 不修改 db pool/pool-config，06 不修改 metrics/dashboard，因此可在 04 之后并行。07 不修改 RunView，08 在其基础上处理控件。02/03 共享 canonicalization API，必须串行。新增的文件重叠须由协调器显式串行安排，不能强行并行。

一个 todo=一个 worktree=一个最终任务 commit。任务 agent 只修改自己的分支，不 merge 原分支、不 push、不创建 PR、不修改其他任务状态；全部验收通过后只归档自己的 todo 到 done/。协调器串行 rebase、独立复核、集成，保留 README 所有已完成行。

## 校验

每个任务的针对性验证见文件；完整仓库 gate：

```sh
bun run lint
bun run typecheck
bun run build
bun run test -- --force
git diff --check
```

新 worktree 缺依赖时先 `bun install --frozen-lockfile`。最终集成在临时 PostgreSQL 上执行上述 tests、19 个 acceptance harnesses、所有 `check:*`、audit self-test 与 docs mermaid；不把 cache hit 或 PG skip 当成对应修复的证据。基线为 1,594 tests / 19 harnesses；一次 copy feedback 失败及后续通过均记录在 plan。

本机无 Docker，有 `/usr/lib/postgresql/16/bin/initdb` 与 `pg_ctl`。需要 PG 的 agent 创建自己的 mkdtemp cluster、随机 loopback 端口和测试用户，在 finally/trap 中清理自己创建的资源；不得复用探索时已清理的 cluster，不使用用户数据库。可遵循 `packages/testing/src/database.ts` 的唯一数据库所有权规则。
