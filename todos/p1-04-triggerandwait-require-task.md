# P1-04 — `triggerAndWait` 打错 task id:父 run 永久 waiting,无任何诊断

- 优先级:P1(正确性/可诊断性)
- 区域:kernel
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#4)

## 现状

`packages/kernel/src/runs.ts:1308-1315`:`waitForChildRun` 调 `createRunIn` 时**不传 `requireTask`**(对比:`trigger` 路径 `runs.ts:690` 传 `true`,`batchTriggerChild` `runs.ts:1400` 显式传 `false` 且有注释说明)。`createRunIn` 的守卫是 `if (!task && args.requireTask)`,所以未注册的 taskId 照样建行。同一事务里:子 run 创建、wait 行插入、父 run 翻 `waiting`、父的 queue 行删除。

`retryRun`(`runs.ts:1755-1772`)同样不传 `requireTask`,对已卸载 task 的 run 重试会入队一个没人认领的 run。

## 影响

`ctx.triggerAndWait('typo-task', …)`:子 run 没有任何 worker 会认领(`claimRuns` 按注册 task id 过滤),父 run 卡在 `waiting`、无 queue 行、无超时、无日志。stranded 扫描也看不见它——它要求 `r.code_version IS NOT NULL`,而未注册 task 的 run 恰好是 NULL。唯一解法是恰好部署一个带那个 id 的 worker。一个拼写错误 = 静默永久挂起。

## 实现方案

1. `waitForChildRun` 的 `createRunIn` 调用加 `requireTask: true` → 拼写错误在调用点立刻得到 `TaskNotFoundError`。
2. `apps/worker/src/executor.ts:92-97` 的 `isUnfixableKernelError` 加入 `task_not_found`:父 run 以 `AbortError` 终止而不是烧重试次数(错的 task id 重试多少次都一样)。
3. `retryRun` 同样传 `requireTask: true`;HTTP 侧 `POST /runs/:id/retry` 对未注册 task 返回 `404 task_not_found` 而不是入队死 run。
4. 兜底可观测性(小):stranded 扫描的 metric/日志说明里注明 `code_version IS NULL` 的 run 不在其覆盖内,或放宽条件把"无注册 task 的 queued run"计入一个独立 gauge——二选一,以不引入误报为准。

## 验收标准

- kernel 测试:`waitForChildRun` 对未注册 taskId 抛 `TaskNotFoundError`,事务回滚(父 run 状态不变、无 wait 行、无子 run 行)。
- worker 测试:executor 收到 `task_not_found` 时父 run 走 AbortError 终态,`attempt` 不增加。
- `retryRun` 对未注册 task 返回 404,不产生 queue 行。
- 验收脚本(e2e 或 constraints 场景)补一个 typo-task 用例:父 run 进入 failed 终态且错误信息点名 task id。

## 涉及文件

- `packages/kernel/src/runs.ts:1308-1315`(waitForChildRun)、`:1755-1772`(retryRun)、`:520,571`(requireTask 守卫)
- `apps/worker/src/executor.ts:92-97`(isUnfixableKernelError)
- `packages/kernel/test/`、`examples/basic/scripts/`
