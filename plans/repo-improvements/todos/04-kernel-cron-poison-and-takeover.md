difficulty: hard

# 04 · kernel cron 投毒隔离与接管守卫

本文件覆盖 `packages/kernel` 的调度正确性：单条毒 schedule 不得停摆全局、C4 接管守卫对旧版 manifest 归一、fan-out 不留无主孤儿、served 语义统一。与 02 共享 `queue.ts`/`workers.ts`/`runs-steps.ts`，故依赖 02 先行。

## T1 · cron 投毒隔离（P1）

- 做什么：`packages/kernel/src/orchestrator.ts:725-883` `scanCron` 用单个事务覆盖所有 namespace 的全部到期 schedule；`nextCronAt`（`:116-119`）对不可解析 pattern/未知时区抛错。今天注册路径挡得住毒行，但 croner 升级、dashboard/手工改 `schedules.cron_pattern`/`cron_tz`、tz-data 改名都会制造毒行：每个 tick 抛错 → ROLLBACK → 所有到期 schedule 的 `next_run_at` 永不推进 → **整片 namespace 的 cron 全部停摆**，只在 `loopErrors.cron` 里留痕。修法：在 `scanCron` 内对每条 schedule 的 `nextCronAt` 计算单独 try/catch——失败时仍推进该 schedule 的 `next_run_at`（或置 NULL 并 warn + 计数 `cronPoisoned`），使其余 schedule 不受牵连；必要时用 savepoint 隔离单条事务失败。保持既有批量事务的效率路径。
- 预计文件：`packages/kernel/src/orchestrator.ts`、`packages/kernel/test/orchestrator*.test.ts`（新增毒 schedule 用例，含多 schedule 共存时健康者仍触发）。
- 验收：植入一条非法 pattern 的 schedule 后，同批其余 schedule 照常推进并触发；毒行被计数/告警且不导致整事务回滚；既有 `orchestrator.test.ts` 对 `nextCronAt` 抛错的断言语义如需调整，须同步更新并在 commit 说明。
- 前置依赖：02（同仓库内核文件串行约束）。

## T2 · C4 接管守卫归一旧版 manifest（P2）

- 做什么：`packages/kernel/src/workers.ts:222-232` 的"仍被服务"子查询用精确包含 `w.tasks @> jsonb_build_array(jsonb_build_object('id', ..., 'codeVersion', ...))`，只匹配"对象对"格式；旧版 build 写入的 workers 行是裸字符串数组。其他读取方都做了双形态归一（`orchestrator.ts:145` 用 `COALESCE(e->>'id', e #>> '{}')`，`queue.ts:815-816` 用 `COALESCE(e->>'codeVersion', w.code_version)`），`workers.ts:68-73` 的注释也声称"所有读取方都归一"——唯独守卫本身没有。从旧格式 build 滚动升级期间，在线旧 worker 对守卫不可见，新注册可以接管旧 worker 正在服务的任务的 `latest_code_version`/重试策略/cron——正是 C4 要防的回滚。修法：守卫内归一，例如 `EXISTS (SELECT 1 FROM workers w CROSS JOIN LATERAL jsonb_array_elements(w.tasks) e WHERE online + 心跳窗口 + namespace AND COALESCE(e->>'id', e #>> '{}') = tasks.id AND COALESCE(e->>'codeVersion', w.code_version) = tasks.latest_code_version)`。
- 预计文件：`packages/kernel/src/workers.ts`、`packages/kernel/test/`（新增真 PG 注册测试，播种旧形态行；现有 stub 测试只镜像规则、测不到 SQL 本身）。
- 验收：真 PG 下：在线旧格式（`["id"]`）worker 存在时，携带新 codeVersion 的注册被拒（保持旧行为对"对象对"格式成立）；既有接管/注册测试全绿。
- 前置依赖：02（同文件 `workers.ts` 串行）。

## T3 · batchTriggerChild 不留无主孤儿（P2）

- 做什么：`packages/kernel/src/runs-steps.ts:553-561` 传 `requireTask: false`；任务行只在有 worker 注册过才存在，缺行意味着无人能 claim。`triggerAndWait` 对同场景刻意 `requireTask: true`（`:370-381`，注释明说"否则永久搁浅"）。更糟：这些 run 的 `code_version = NULL`，而 `scanStrandedRuns` 过滤 `r.code_version IS NOT NULL`——它们连指标/告警都不出现，只在队列里堆积。修法：`batchTriggerChild` 改 `requireTask: true`（fan-out 随即像其他 `task_not_found` 一样非重试终止）。
- 预计文件：`packages/kernel/src/runs-steps.ts`、内核测试（含 item 指向未注册任务时 fan-out 以 task_not_found 非重试失败）。
- 验收：未注册任务 id 的 batch item 使该步骤非重试失败且不留无主 run；合法 fan-out 路径行为不变。
- 前置依赖：02（同文件 `runs-steps.ts` 串行）。

## T4 · served 语义统一 + 心跳窗口常量归一（P2）

- 做什么：`queue.ts:810-819` `servedTaskIds` 要求 `status='online' AND last_heartbeat_at > now() - 2min`，`orchestrator.ts:136-148` `scanStrandedRuns` 只要求 `status='online'`——停跳心跳的 worker 在 2 分钟内对两个观测面给出相反结论。给 `scanStrandedRuns` 加同样的心跳窗口谓词。同时 `'2 minutes'` 窗口在 `orchestrator.ts:143` 与 `workers.ts:227` 两处硬编码 SQL，与常量 `WORKER_OFFLINE_MS`（`orchestrator.ts:70`，只被 `markOfflineWorkers` 用）三处并行——导出常量并像 `markOfflineWorkers` 一样以参数绑定（`now() - ($n::text || ' milliseconds')::interval`）。
- 预计文件：`packages/kernel/src/orchestrator.ts`、`packages/kernel/src/queue.ts`、`packages/kernel/src/workers.ts`、内核测试。
- 验收：停跳心跳的在线行在窗口过后不再被 stranded 扫描视为 served；两处 SQL 窗口由同一常量驱动（测试或代码检视可证）；既有用例全绿。
- 前置依赖：02（`queue.ts` 串行）。

## 本文件验证

`bun run typecheck && bun run lint && bun run build && bun run test`；**必须**设置 `DATABASE_URL` 在真 PG 下复跑内核套件（T1/T2 的行为都在 SQL 里）。涉及并发路径，实现前先读 `docs/architecture.md` 的锁序与 C4 约定。
