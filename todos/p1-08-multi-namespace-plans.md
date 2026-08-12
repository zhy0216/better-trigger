# P1-08 — 配置两个以上 namespace 时,`IN (VALUES …)` 让所有热路径索引失效

- 优先级:P1(性能,文档支持的配置触发数量级劣化)
- 区域:kernel
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#8)

## 现状

`packages/kernel/src/queue.ts:38-49` 的 `namespacePredicate` 统一生成 `(alias.project_id, alias.env) IN (VALUES ($n,$m), …)`,用于 claim(`queue.ts:276`)、waits/cron/reaper 扫描(`orchestrator.ts:245-249`)等所有热路径。

- **单对** VALUES:Postgres 把单行 VALUES 拉平成常量等值,索引前导列可绑——`claim-scan-bench.ts:96-97` 也只测了 `['default','prod']` 这一对,才断言得出 `Index Scan using queue_claimable_idx`、无 Sort 节点。
- **两对及以上**:VALUES RTE 无法拉平,变 semi-join;`(project_id, env, …)` 前缀失去等值约束,`ORDER BY q.priority DESC, q.id ASC LIMIT n` 无法从索引直接回答。
- 另外 `claimRuns` 的谓词打在 `r`(runs)上而非索引所在的 `q`(queue)上(`queue.ts:276`),queue 索引前导列只能靠等值类传播间接可达。

## 影响

`--namespace a/prod --namespace b/prod` 是文档支持的部署形态。它让每个执行槽每 300ms–2s 一次的 claim poll 变成对整个 claimable 积压的 top-N 排序,waits/cron/reaper 扫描同步退化。同一份代码、同一份数据,计划相差数量级,且无任何告警。

## 实现方案

1. `namespacePredicate` 对 `namespaces.length === 1` 直接发平铺等值:`alias.project_id = $n AND alias.env = $m`——单 namespace(绝大多数部署)从此不依赖 planner 的 VALUES 拉平。
2. `claimRuns` 的谓词同时打在 `q` 上(保留 `r` 侧以维持语义),让 queue 索引前导列直接可绑。
3. 多 namespace 的热路径改为**逐 namespace 扫描**:claim 按 namespace 轮转分配剩余 limit(简单公平:顺序扫,claim 满即止);waits/cron/reaper 每 namespace 一条 LIMIT 查询。冷路径(dashboard 读)保留 VALUES 形式即可。
4. `claim-scan-bench.ts` 增加 ≥2 namespace 的用例:断言每条子查询仍是 Index Scan、无 Sort;固定进 CI 可跑的断言(bench 已有 EXPLAIN 断言机制)。

## 验收标准

- 单 namespace:bench 断言不回归(Index Scan、无 Sort)。
- 双 namespace、6 万积压:claim 与三个扫描循环的 EXPLAIN 全部 Index Scan;claim 延迟与单 namespace 同数量级。
- 语义不变:跨 namespace 不会互相认领(现有 C2 隔离测试与 namespace sweep 全绿);(p1,e1)+(p2,e2) 的 worker 不匹配 (p1,e2)(`namespacePredicate` 注释里的笛卡尔积陷阱保持被防住)。

## 涉及文件

- `packages/kernel/src/queue.ts:38-49`(namespacePredicate)、`:276`(claim 谓词位置)、`:488`
- `packages/kernel/src/orchestrator.ts:245-249`
- `examples/basic/scripts/claim-scan-bench.ts:70-97`
