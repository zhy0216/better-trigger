# P1-10 — 并发受限任务完成时不发 `work` 通知,下一个 run 白等一个空闲退避周期

- 优先级:P1(延迟,PF2 的遗漏路径)
- 区域:kernel
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#10)

## 现状

`packages/kernel/src/runs.ts` 的 `completeRun`(`:1625-1630`)与 `failRun` 终态分支(`:1664-1671`):`notifyTerminal` 总是发,`notifyWork` 只在 `run.parent_run_id` 非空时发。

而 `claimRuns` 对 concurrency 达上限的候选是**跳过且不改任何行**(`queue.ts:336-359`)——被跳过的 run 不会因任何事件变得可认领,只能等某个执行槽的空闲退避(300ms→2s)自然到期再扫一遍。

## 影响

`concurrency_limit: 1` 且队列有积压的 task:run N 结束不产生任何唤醒,run N+1 的启动延迟 = 剩余退避时长(最坏 2s+jitter)。串行化任务链的每一环都吃一次。这正是 PF2("通知优先、轮询兜底")要消除的延迟类别,且被轮询兜底掩盖——功能正确、延迟默默变差。

## 实现方案

1. `completeRun` / `failRun` 终态分支 / `cancelRun`(取消同样释放并发额度)在 `run.concurrency_key` 非空时**同时**发 `notifyWork`(RunRow 已带 `concurrency_key`,零额外查询)。现有注释风格照搬:"多发的 work 通知无害——claim 扫描空手而归而已"。
2. 保持 `parent_run_id` 触发的 notifyWork 不变,两个条件取或。

## 验收标准

- stub 测试:completeRun/failRun(终态)/cancelRun 对带 concurrency_key 的 run 断言 notifyWork 被调用;无 key 无 parent 时不调用(维持现状)。
- `examples/basic/scripts/concurrency.ts` 增加延迟断言:limit=1、预入队 3 个 run,测量相邻 run 的 finish→start 间隔,应远小于 `IDLE_POLL_BASE_MS`(如 < 200ms),而不是落在退避区间。
- notify 验收场景全绿。

## 涉及文件

- `packages/kernel/src/runs.ts:1625-1630`、`:1664-1671`、cancelRun 终态路径
- `packages/kernel/test/notify.test.ts`
- `examples/basic/scripts/concurrency.ts`
