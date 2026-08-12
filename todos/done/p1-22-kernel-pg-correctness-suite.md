# P1-22 — kernel 真 PG correctness suite:承重不变量目前只有 stub 测试与手动脚本

- 优先级:P1(测试基建,architecture.md P2 的核心交付)
- 区域:kernel / db / testing
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」测试盲区)

## 现状

`packages/kernel/test` 与 `packages/db/test` 的全部 vitest 都是 stub(fake PoolClient 记录 SQL 文本),从不连 Postgres;真实行为只靠 `examples/basic/scripts/` 的验收脚本。本轮多个 bug(p1-05 的 NULLS 排序、p1-06 的索引失配)正是"断言 SQL 字符串"这种测试形态天然看不见的。无自动化断言的核心不变量:

- **fencing 拒绝**:`assertOwnedRunning`(`runs.ts:478-499`)三个分支——过期 fencingToken → `StaleLeaseError`、外来 workerId 拒绝、非 running 状态 → `RunNotRunningError`。引擎最承重的谓词,唯一覆盖是 fencing.ts 脚本。
- **suspend / waitForChildRun 状态机**:wait 行写入、`status='waiting'`、queue 行删除三者同事务;`resumeAt` 已过期分支(`resumed: true`、step 行落账、claim 保留)。
- **cancelRun**:终态 no-op 早退、waits→canceled 清扫、cancel-vs-claim 锁序(cancel 阻塞在 claim 持有的 queue 行上)。
- **幂等键冲突单 run 路径**(`runs.ts:641-653` "no row returned → 读现有 run、不入队"——只有 batch 路径被测过)。
- **孤儿 wait 优先于到期 timer**(p1-05 的行为断言)、**cron next_run_at 单调性**(p1-09)、**≥2 namespace 的 claim 计划**(p1-08)。
- **索引访问路径**:`schema-indexes.test.ts` 只钉 queue 两个索引的 DDL 文本;waits / run_steps 的热查询没有 plan 钉住(p1-06 因此隐形)。

## 实现方案

1. 测试基建:kernel 增加 `test-pg/`(或 `test/pg/`)目录,vitest 以 `DATABASE_URL` 门控(未设则 skip 整目录);复用 `packages/testing` 的 per-scenario database 建库/清库工具(如需导出,顺手补 p2-35 要的 `freePort` 同批导出)。CI 已有 postgres service,把该目录纳入 `bun run test`(或独立 `test:pg` script + CI step)。
2. 按上面清单逐条落用例;每条不变量一个 describe,直接驱动 kernel API(claimRuns/reportStep/completeRun/…)+ SQL 断言行状态。
3. plan 钉住:对 waits 唤醒/清扫、run_steps 快照、claim 三类热查询跑 `EXPLAIN (FORMAT JSON)`,断言节点类型是 Index Scan(阈值数据量下);沿用 claim-scan-bench 的断言手法但进 vitest。
4. 与本轮修复的关系:p1-04/05/06/08/09 各自的"真 PG"验收标准落在这里——**建议本文件排在它们之前或并行首先做**,后续文件直接往里加用例。
5. `docs/architecture.md` P2 的 "vitest + 真 PG 的 correctness suite" 标记为部分交付(fault-injection harness 与 LISTEN/NOTIFY 专项仍留在 P2)。

## 验收标准

- `DATABASE_URL` 存在时 `bun run test` 跑过全部 pg 用例;未设置时干净 skip。
- 上述每条不变量至少一个失败即红的用例(人为破坏可验证:如注释掉 fencing 校验,套件必红)。
- CI 时长增幅可控(< 2 分钟);README Development 小节补充说明。

## 涉及文件

- `packages/kernel/test-pg/`(新建)、`packages/kernel/package.json`
- `packages/testing/src/`(工具导出)
- `.github/workflows/ci.yml`、`README.md`、`docs/architecture.md`
