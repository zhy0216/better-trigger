# Correctness TODOs

## C1 — 为 durable step 增加 replay fingerprint

**现状**

`apps/worker/src/executor.ts` 当前只用 `seq + kind + label` 判断缓存是否属于当前调用点；默认 `replay: 'lenient'` 时，发现 drift 仍会继续使用旧结果。`run_steps` 也没有 fingerprint 列。

这意味着下面这种修改可能静默返回旧值：

```ts
// 旧代码
await ctx.step('charge', () => chargeCard({ amount: 10 }));

// 新代码：label 和 kind 没变，但输入语义已经变了
await ctx.step('charge', () => chargeCard({ amount: 20 }));
```

**修复方向**

1. 在 `run_steps` 增加 `fingerprint text`，提交 migration 和 schema drift 更新。
2. 对每个 durable primitive 计算稳定 fingerprint，至少包含：
   - primitive kind
   - label
   - 可持久化的输入/选项 hash
   - task 自身的 replay schema/version
3. 首次写入时保存 fingerprint，重放时严格比较。
4. 已有旧数据的 `fingerprint IS NULL` 需要兼容策略：
   - 旧 run 可显式走 lenient/迁移兼容路径
   - 新 run 默认 strict
5. 对相同 `(run_id, seq)` 的 completed row：
   - fingerprint 相同：重复报告视为幂等成功
   - fingerprint 不同：拒绝覆盖，记录 `NonDeterminismError`
6. 逐步把 `--pin-code-version` 变成生产推荐默认值，避免不兼容代码接管旧 ledger。

**验收标准**

- 相同 label 但输入变化时，run 不会返回旧 step output。
- step reorder、kind 变化、label 变化都能得到稳定且可识别的错误。
- crash/retry/重复 report 不会改变已经 completed 的 step row。
- 旧版本没有 fingerprint 的 run 有明确兼容日志和迁移策略。

涉及文件：

- [apps/worker/src/executor.ts](/Users/yang/workspace/better-trigger/apps/worker/src/executor.ts:325)
- [packages/kernel/src/runs.ts](/Users/yang/workspace/better-trigger/packages/kernel/src/runs.ts:581)
- [packages/db/src/schema.ts](/Users/yang/workspace/better-trigger/packages/db/src/schema.ts:103)

## C2 — 明确并实现 `env` / `project_id` 隔离

**现状**

`TriggerOptions.env` 被公开为“Environment scope”，schema 也给业务表都加了 `env` 和 `project_id`，但当前执行路径并没有形成真正的 namespace：

- task 主键只有 `id`，没有 project/env 维度
- 幂等唯一索引只有 `(task_id, idempotency_key)`
- claim 只按 task id 过滤，不按 env/project 过滤
- task、schedule、worker 注册和多数 Dashboard 查询也没有统一 scope
- project_id 基本固定为 `default`

所以同一个 task 在 `prod` 和 `staging` 中并不是两个独立任务；相同 idempotency key 也可能跨环境命中旧 run。

**修复方向**

先做产品决策：

### 方案 A：v1 明确单 namespace

- 暂时隐藏或限制 `project_id/env` 的公开语义
- 文档明确 env 只是 metadata/filter，不是安全隔离
- 不再让用户误以为它支持多环境部署

### 方案 B：完整实现 namespace

1. 将 `projectId` / `env` 加入 SDK、Kernel、worker registration 和 HTTP request context。
2. 统一所有 SQL 的 scope 条件，尤其是：
   - task lookup
   - queue claim/reaper
   - concurrency advisory lock
   - idempotency lookup
   - schedule scan
   - Dashboard/metrics
3. 重新设计主键和唯一键，例如：
   - `(project_id, env, task_id)`
   - `(project_id, env, task_id, idempotency_key)`
   - `(project_id, env, task_id)` schedule unique
4. 将 namespace 组合进 concurrency key，避免不同环境互相限流。
5. 为现有 `default/prod` 数据提供迁移和回滚说明。

**验收标准**

- prod/staging 相同 task + 相同幂等键可以独立创建 run。
- staging worker 不会 claim prod run，反之亦然。
- 不同 project 的 task、schedule、metrics 和日志互不可见。
- 所有关键查询都能通过 SQL review 或测试验证 scope 条件存在。

涉及文件：

- [packages/db/src/schema.ts](/Users/yang/workspace/better-trigger/packages/db/src/schema.ts:27)
- [packages/core/src/types.ts](/Users/yang/workspace/better-trigger/packages/core/src/types.ts:104)
- [packages/kernel/src/queue.ts](/Users/yang/workspace/better-trigger/packages/kernel/src/queue.ts:227)

## C3 — 统一 JSON 序列化错误和大小边界

**现状**

payload 在 [runs.ts](/Users/yang/workspace/better-trigger/packages/kernel/src/runs.ts:366) 有大小限制，但多个持久化路径直接调用 `JSON.stringify`：

- circular object / `BigInt` 可能抛出普通 `TypeError`
- HTTP 层会把它表现成 500
- SDK 甚至可能把本地 stringify 失败误报成“worker daemon 不可用”
- step output、run output、log data 没有与 payload 对等的上限

**修复方向**

1. 在 core 或 kernel 提供 `safeSerializeJson(value, limit, field)`：
   - 成功返回 JSON 字符串和 byte length
   - 循环引用、BigInt、不可序列化值转换为稳定的 `bad_request`/`serialization_error`
2. 对以下对象分别设置可配置限制：
   - run payload
   - step output/error
   - run output
   - 单条 log message/data
   - 单次 log batch
3. 对超大结果提供 object storage/reference 的文档路径。
4. 给 HTTP、子任务、batchTriggerChild、日志 flush 都走同一套 helper。

**验收标准**

- circular/BigInt 输入不会产生 500 或误导性的 transport error。
- 超限输入统一返回稳定错误码和字段名。
- 子任务和内部 durable step 不能绕过大小限制。
- 日志 flush 失败时有明确计数和诊断信息。

## C4 — 修正 cron 注册和版本更新竞态

**现状**

每次 worker 注册都会 upsert task 和 schedule；enabled schedule 的 `next_run_at` 会被重新计算。多 daemon 滚动部署时，旧 worker 重新启动可能覆盖新 worker 的 task metadata/code version，也可能把一个已经 due 的 schedule 推迟掉。

**修复方向**

- task metadata 使用带版本/发布时间的注册记录，避免“最后写入者”天然胜出。
- schedule 只有在 cron pattern/timezone 真正变化时才重算 `next_run_at`。
- 对同一 namespace 的 task registration 引入明确的 owner/version 规则。
- 增加双 worker、滚动部署、旧版本重新注册的测试。

**验收标准**

- worker 重启不会无故跳过已经 due 的 cron fire。
- 旧版本 worker 不能把新版本 task metadata 回写成旧版本。
- 同一 schedule 在多 daemon 下仍然最多产生一个 run。

## C5 — 增加数据库级引用和状态约束

**现状**

目前只有 `run_steps` 和 `logs` 对 `runs` 有 cascade FK；queue、waits、parent/child 和 schedules 的多数关联依靠应用代码维护。状态和 kind 也主要是自由文本。

**修复方向**

- 为 `queue.run_id`、`waits.run_id`、`waits.child_run_id`、`runs.parent_run_id`、`schedules.task_id` 设计 FK 和合理的 cascade/restrict 行为。
- 为 status/kind、attempt/max_attempts、priority 等增加 CHECK constraint。
- 迁移前先做 orphan 数据扫描，migration 中提供清理/失败策略。

**验收标准**

- 手工删除或异常写入不能留下 orphan queue/wait/schedule。
- 非法状态无法进入数据库。
- prune、cancel、retry 和 cascade 行为有真实 PostgreSQL 测试覆盖。
