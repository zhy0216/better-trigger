# todos — 代码审阅结论(2026-07-30)

审阅范围:`packages/{core,kernel,db,sdk}`、`apps/{worker,web}`、`examples/basic`、
`docs/architecture.md`、`docs/backend-contract.md`。约 13k 行。

阅读方式:每条都是**现象 / 位置 / 影响 / 建议**。凡是 `docs/architecture.md`
的分阶段计划里已经列过的,标注 `[roadmap]` 并只补充"实际代价是什么" ——
不重复它已经写好的计划。

## 总体判断

内核部分是这份代码里质量最高的地方:锁序在 `packages/kernel/src/runs.ts` 文件头
写成了不变量并在每个 tx 里遵守;fencing token 放在 `runs` 行而不是 queue 行,
这个选择是对的,并且注释解释了为什么(suspend/resume 会删除并重建 queue 行);
幂等靠部分唯一索引而不是先读后写。这些是很多同类项目做错的地方。

问题集中在**内核之外**:进程生命周期、默认安全姿态、索引、数据保留、以及最重要的
—— 没有任何可以在 PR 上重跑的自动化测试。README 声称"50 项验收跑通",但那些
验收是 `examples/basic/scripts/*.ts` 手动执行的,没有 CI,没有测试框架。

## 优先级

| # | 条目 | 文件 |
|---|---|---|
| P0 | 没有 CI / 没有测试框架,验收无法重跑 | [05-tests-and-dx.md](05-tests-and-dx.md#t1) |
| P0 | 默认绑 `0.0.0.0` + `CORS: *` + 默认无鉴权 | [04-security.md](04-security.md#s1) |
| P0 | pg Pool 没有 `error` 监听 → 空闲连接被断开时进程崩溃 | [03-operability.md](03-operability.md#o1) |
| P0 | 关停不释放 claim、不标记 worker offline | [01-correctness.md](01-correctness.md#c3) |
| P1 | `migrate()` 无 advisory lock,多 daemon 同时启动会打架 | [01-correctness.md](01-correctness.md#c5) |
| P1 | reaper 全表扫 queue(缺 `lease_until` 索引)且扫描无 `LIMIT` | [02-performance.md](02-performance.md#pf1) |
| P1 | 无数据保留策略:runs / run_steps / logs / workers 只增不删 | [02-performance.md](02-performance.md#pf6) |
| P1 | heartbeat 不上报 lease 丢失 → 旧 executor 白跑到下一次写 | [01-correctness.md](01-correctness.md#c2) |
| P1 | `LICENSE` 文件缺失(sdk 已声明 MIT) | [05-tests-and-dx.md](05-tests-and-dx.md#t3) |
| P2 | 其余(claim 索引/N+1、CORS 收紧、错误信息脱敏、`ctx.signal` …) | 各文件 |

## 文件

- [01-correctness.md](01-correctness.md) — 正确性与竞态(8 条)
- [02-performance.md](02-performance.md) — 索引、claim 路径、保留策略(7 条)
- [03-operability.md](03-operability.md) — 进程生命周期、可观测性(6 条)
- [04-security.md](04-security.md) — 默认姿态、输入边界(5 条)
- [05-tests-and-dx.md](05-tests-and-dx.md) — 测试 / CI / 开发体验(8 条)
