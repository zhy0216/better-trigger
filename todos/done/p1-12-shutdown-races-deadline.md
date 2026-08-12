# P1-12 — 停机三漏:drain 期间仍领新 run、shutdown 无兜底超时且二次信号无效、信号 handler 装得太晚

- 优先级:P1(可靠性/运维)
- 区域:worker
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#12)

## 现状

1. **drain 期间领新 run**:`apps/worker/src/runtime.ts:233-292`——`stop()` 只对已在 `inFlight` 的 executor 调 `markShuttingDown()`(`:333`)。正阻塞在 `await kernel.claimRuns(...)`(`:236`)的槽在 `stopping` 置位后照样拿到 run 并执行;`stopping` 只在 while 头部和错误分支(`:253`)复查,**成功分支没有**。新领的 run 收不到 shutdown abort。
2. **无兜底、二次信号无效**:`apps/worker/src/main.ts:703-711`——`shutdown()` 是 `if (exiting) return; exiting = true; await handoff(); process.exit(...)`:没有备份定时器,第二次 SIGINT/SIGTERM 是 no-op。对比 `crash()` 路径特意有 `CRASH_HANDOFF_MS = 10_000`(`:739`)。handoff 内部只有 drain 有界,`heartbeatTick`、`handBack()`(releaseClaims + deregisterWorker)、`pool.end()` 都无界——池又没有超时(p1-11)。
3. **handler 晚装**:`main.ts:1060-1061`——SIGINT/SIGTERM 注册是 `main()` 的最后两句;之前的 `loadTasks`、`migrate`、`registerWorker` 全程是 Node 默认信号处置(立即终止,无 handoff)。crash handler 却在模块加载时就装好(`:755-756`),不对称显然非有意。

## 影响

1. 每次部署最多 `concurrency` 个 run 在 drain 窗口内被新领、执行满 30s 后被 `handBack()` 中途丢弃——`markShuttingDown` 快速路径的意义被自己击穿。
2. PG 半死(TCP 通、无响应)时 SIGTERM 永远挂着、Ctrl-C 连按无效,运维只能 SIGKILL——恰好落回 abandoned-lease、`workers` 行滞留 online 的下场,C3 hand-back 想避免的一切。
3. 大库 migrate 中途 SIGTERM:进程直接死,刚插的 workers 行滞留 online 约 2 分钟,池不被 end。

## 实现方案

1. claim 成功分支加 `if (stopping) { 释放刚领的 claim(releaseClaims 单个); break; }`,在构造 Executor 之前。
2. `shutdown()` 加兜底:`setTimeout(() => process.exit(1), SHUTDOWN_DRAIN_MS + 15_000).unref()`;`exiting` 已置位时的第二次信号改为立即 `process.exit(1)`(打一行 "second signal, exiting immediately")。
3. SIGINT/SIGTERM 注册移到模块加载处(紧挨 crash handler);`handoff()` 对 `daemon.*` 各字段已 null-safe(注释自述),验证后直接前移。
4. 更新 `apps/worker/test/runtime-shutdown.test.ts`:现有用例只盖"已 in-flight",补齐下述场景。

## 验收标准

- 测试:让 `claimRuns` 在 `stopping` 置位后才 resolve,断言 run 被释放、executor 不构造、drain 不被拖长。
- 测试:handoff 永不 resolve(stub 卡死),断言进程在兜底时限内退出;第二次信号立即退出。
- 手工/脚本:boot 早期(migrate 前)发 SIGTERM,进程干净退出且无残留 online worker 行。
- graceful-restart 验收场景全绿,drain 语义(不烧 attempt)不回归。

## 涉及文件

- `apps/worker/src/runtime.ts:233-292`、`:323-350`
- `apps/worker/src/main.ts:703-711`、`:739-752`、`:1060-1061`
- `apps/worker/test/runtime-shutdown.test.ts`
