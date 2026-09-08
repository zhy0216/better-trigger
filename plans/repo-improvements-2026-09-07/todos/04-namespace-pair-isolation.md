difficulty: hard
agent: inherit

# cron 与指标的 namespace pair 隔离

对应 F7–F8。优先级 P1。前置依赖：无。修内部 pair 身份，不改 CLI 格式，不禁止合法斜杠，不改 SQL advisory lock 协议。

## T1 · cron 的服务能力查询按无歧义二元组分组

- 要做什么：修复 `startOrchestrator` 中 dueNs 的斜杠拼接 key，使每组 servedTaskIds 查询使用确切 projectId/env。检查相关 in-memory identity key，区分身份键与仅供显示的文本。
- 预计修改：`packages/kernel/src/orchestrator.ts`；`packages/kernel/test/cron-unserved.test.ts`、`packages/kernel/test/pg/cron-unserved.test.ts` 或同目录独立 namespace 回归。
- 验收：使用 `{projectId:'a/b',env:'c'}` 与 `{projectId:'a',env:'b/c'}`、相同 task id，仅一组有 online worker 时只该组创建 cron run；另一组计入 skippedUnserved 并正常推进 next_run_at。换序、恢复 worker、空队列场景保持隔离。真实 PG 必须验证，保留现有锁序、DB clock、poison isolation。
- 前置依赖：无。

## T2 · 指标中的 namespace series 不碰撞

- 要做什么：修复 `queryGauges` 的 Map 初始化和查询键，保证不同 namespace pair 不相互覆盖。
- 预计修改：`apps/worker/src/routes/metrics.ts`、`apps/worker/test/metrics.test.ts`。
- 验收：上述两组 available=3/7 都输出正确的独立 series；空组输出自己的零值；请求顺序不影响标签和值。namespace/assertNamespace 合法输入继续接受，不用减少支持范围解决问题。
- 前置依赖：无。

验证：`bun run --cwd apps/worker test -- test/metrics.test.ts`、kernel cron/namespace 相关测试和独占 PG 回归，随后完整仓库 gate。后续 05/06 会分别修改 metrics/orchestrator，完成后先复核集成，不能并行抢改文件。一个最终 commit。
