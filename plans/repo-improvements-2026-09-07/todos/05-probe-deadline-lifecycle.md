difficulty: hard
agent: inherit

# 数据库探针超时后的资源生命周期

对应 F9–F10。优先级 P1。依赖：04-namespace-pair-isolation.md（metrics 文件）。本任务不修改 db pool/pool-config 的配置解析，避免与 06 冲突。

## T1 · 让健康探针结束状态覆盖迟到 checkout/query

- 要做什么：修复 `probeDb`，使 HTTP deadline 后收到的连接立即被妥善归还且不发 SELECT；已经发出的 query 未结束时，不能无参 release 后供其他请求复用。所有路径 exactly once 清理并处理迟到拒绝。
- 预计修改：`apps/worker/src/routes/dashboard.ts`、`apps/worker/test/health.test.ts`；可抽取 worker 内部 probe helper，范围仅限这两类探针。
- 验收：分别控制 connect/query 的 deferred promise，验证 deadline 先到、成功先到、查询抛错、迟到成功/失败；迟到 connect 查询次数=0，连接归还一次；在途 query 超时使用明确 destroy 语义，不 double release，不出现 unhandled rejection。正常深探针 200，失败/超时 503。
- 前置依赖：04 合入。

## T2 · 同步修正 metrics 和 single-flight 的资源边界

- 要做什么：检查 `gaugesOrNull` / inflightGauges / inflightProbe，使共享探针不会因每次 HTTP race 结束而积累仍未结束的底层操作；必要时共享明确拥有 checkout 的 helper。更新误称无参 release 自动销毁连接的注释和测试。
- 预计修改：`apps/worker/src/routes/metrics.ts`、`apps/worker/test/metrics.test.ts`、`apps/worker/test/health.test.ts`、本文件 T1 的 helper。
- 验收：多批并发请求跨过多个 deadline 时底层工作仍受界限约束；业务 pool 不被探针借用；恢复后可再次成功查询；metrics 在 DB 失败时仍返回 200 + db_up=0 和进程计数。测试断言 release 的参数和所有权，不能只统计一次调用。
- 前置依赖：本文件 T1；沿用 04 namespace 修复。

验证：health/metrics tests、独占 PG 的现有 `bun run --cwd examples/basic health-pool`；必要的真实 pg 故障探针证明 pool 可恢复，再跑完整仓库 gate。不可暂停用户数据库、不可把 HTTP 超时当 SQL 已取消。一个最终 commit。
