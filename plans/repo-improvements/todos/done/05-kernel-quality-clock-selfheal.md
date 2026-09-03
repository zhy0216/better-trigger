difficulty: hard

# 05 · kernel 时钟、自愈与质量收尾

内核链最后一环：宿主时钟漂移、wait-graph 检出不自愈、`work` 通知跨 namespace 唤醒、性能小洞与文档漂移。与 04 共享 `orchestrator.ts`/`runs-steps.ts`/`runs-logs.ts`，依赖 04 先行。

## T1 · 写路径改用 DB 时钟（P2）

- 做什么：`available_at`（`runs-internal.ts:302`）、重试 `nextAt`（`runs-terminal.ts:303`）、suspend `resumeAt`（`runs-steps.ts:240-279`）、入队 `new Date()`（`runs-terminal.ts:155`、`orchestrator.ts:583`）都用宿主时钟打标，却由 pg `now()` 裁决（`queue.ts:408/425`、`orchestrator.ts:345`）。宿主钟超前 DB 时，新 run/wait 在漂移时长内不可见。cron 路径已按 p1-09 加固（DB 时钟 + `GREATEST(now()+1s)` clamp）——把同一处理推广到上述写路径：`available_at`/`nextAt` 默认由 DB 时钟计算（如 `now() + ($delay::text||' milliseconds')::interval`）；调用方显式传入的时间（用户指定 delay/until）仍尊重传入值但做同样的相对换算。至少在 `docs/architecture.md` 写清时钟契约。
- 预计文件：`packages/kernel/src/runs-internal.ts`、`runs-terminal.ts`、`runs-steps.ts`、`orchestrator.ts`、内核测试。
- 验收：延迟触发/重试可用时刻相对 DB 时钟生效（测试可模拟宿主钟偏移或至少断言 SQL 使用 `now()`）；既有延迟/重试时序测试全绿；真 PG 复跑。
- 前置依赖：04（同文件串行）。

## T2 · wait-graph 违例自愈（P2，允许降级）

- 做什么：`orchestrator.ts:377-429` 的 `scanNoWaitRuns`/`scanStuckWaits` 只计数+记日志，从不清理——真正丢失的唤醒（p1-37 防御的那个状态）让父 run 永远 `waiting`，只能手工动库。增加有护栏的自愈：对"父 waiting 且子已终态"的 pending run-wait，按子终态事务同样的 `wakeParentIfWaiting` 逻辑补做唤醒，严格遵守 `docs/architecture.md` 的锁序；用计数器/指标暴露每次自愈并限流（如每轮每 namespace 上限），保持可观测。
- 预计文件：`packages/kernel/src/orchestrator.ts`、内核测试（真 PG：构造违例状态后断言自愈触发且无重复唤醒）。
- 验收：植入违例后被唤醒；自愈有计数；锁序与既有唤醒路径一致；若实现中发现语义风险，允许降级为"记录+文档化不自愈"，但必须在 commit 说明降级原因。
- 前置依赖：04（同文件串行）。

## T3 · `work` 通知携带 namespace 并按需唤醒（P2）

- 做什么：`apps/worker/src/main.ts:256-261`、`embedded.ts:318-323`：`terminal` 分发按 `opts.namespaces` 过滤，但 `work` 无条件 `wake.emit()`，且内核的 `work` payload（`packages/kernel/src/notify.ts:31-33`）根本不带 namespace——多 namespace 部署下每次触发唤醒所有 daemon 的所有空闲 claim 循环，空跑一轮 claim 轮询。修法：内核在 `work` payload 中带上 namespace；worker 侧像 `terminal` 一样过滤。payload 是仓库内协议，两端同改；旧消息无 namespace 时回退为唤醒（保持兼容）。
- 预计文件：`packages/kernel/src/notify.ts`、`apps/worker/src/main.ts`、`apps/worker/src/embedded.ts`、`apps/worker/src/notify.ts`（类型）、两侧测试。
- 验收：非本组 namespace 的 `work` 不再唤醒本组 claim 循环；缺省/旧格式消息仍唤醒；`notify` 验收场景（`bun run test:acceptance`）通过。
- 前置依赖：04（内核链串行）。

## T4 · 日志热路径与死代码清理（P2）

- 做什么：
  - `runs-logs.ts:45-57` `truncateUtf8` 对超限消息逐码点调 `utf8Bytes(ch)`（每行最多 ~64k 次 `TextEncoder().encode`）；`prepareLogRow` 还整串编码一次只为量长。改为编码一次、按字节预算切片再解码（或 `Buffer.byteLength` + 二分）。
  - `:22-24` 注释"5001 params"实为 3+5×1000=5003，改正。
  - `runs-internal.ts:406` `getRunRow` 导出但零调用（仅测试引用其 SQL 文本），去掉导出或删除；`orchestrator.ts:341-361` 两阶段扫描 SELECT 的 `WaitRow.child_run_id` 二阶段从未读取，去掉。
  - `orchestrator.ts:35-37` 注释"no peer can be holding the runs row"不成立（`appendLogs` 故意只拿 runs 行，`runs-internal.ts:68-79`）；`:106-108` "100 rows per 10s tick"实为每 namespace 100 行/tick。改正。
- 预计文件：`packages/kernel/src/runs-logs.ts`、`runs-internal.ts`、`orchestrator.ts`、`runs.ts` barrel、内核测试（截断行为回归）。
- 验收：`truncateUtf8` 单测（含多字节边界、超限截断字节数正确）；行为不变（既有日志测试全绿）；死代码移除后 typecheck 通过。
- 前置依赖：04（同文件串行）。

## T5 · backend-contract.md 回写（P2）

- 做什么：`docs/backend-contract.md` §2/§3.5 与代码声称由其治理的 schema 漂移：§2 `workers` 缺 `namespaces` 列；`runs` 缺 `fencing_token`；幂等唯一键缺 `(project_id, env)` 前缀；schedules 仍写 `task_id UNIQUE`；queue 索引表仍列已删的 `(available_at, priority desc)`；waits 索引缺 `waits_run_idx`/`waits_pending_step_uniq`；logs 索引仍写 `(run_id, id)`；§3.5 step 2 描述 claim 写入顺序与代码相反（`queue.ts:488-544` 注释明确"先翻 runs"）；step 3 ledger SELECT 缺 `fingerprint`。按 `packages/db/src/schema.ts` 与代码逐条回写（含 03 新增索引落地后的最新状态）。
- 预计文件：`docs/backend-contract.md`。
- 验收：§2 各表块与 schema.ts 一致；§3.5 与 `queue.ts` 实际顺序一致；评审时逐条可核对。
- 前置依赖：03（索引清单以其落地结果为准）、04（内核链串行，避免文档与在途改动打架）。

## 本文件验证

`bun run typecheck && bun run lint && bun run build && bun run test`；设置 `DATABASE_URL` 真 PG 复跑；`bun run test:acceptance` 验证通知路径。
