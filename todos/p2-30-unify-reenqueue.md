# P2-30 — `scanWaits` 开码重写 re-enqueue,与 `enqueue()` 的 ON CONFLICT 分支不一致

- 优先级:P2(可维护性,"重新入队"在 kernel 里有两种含义)
- 区域:kernel
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」kernel #10 附带)

## 现状

`packages/kernel/src/orchestrator.ts:439-445` 的 wait 恢复路径没有调用 `queue.ts:67-107` 的 `enqueue()`,而是自己写了一条 INSERT … ON CONFLICT——两者对冲突分支写什么(`priority` / `concurrency_key` 是覆盖还是保留幸存行的值)**不一致**。同一个概念"把 run 放回队列"存在两份实现、两种语义。

## 影响

行为分叉在边角处显形:带 priority/concurrency_key 的 run 经 wait 恢复后与经正常入队,queue 行的字段可能不同;下次有人改 `enqueue()`(比如 p1-10 的 notify 逻辑若挂在入队侧)会漏掉 scanWaits 这条私货路径。

## 实现方案

1. `enqueue()` 增加显式选项(如 `onConflict: 'keep' | 'overwrite'`,或语义化的 `{ preserveSurvivor: true }`),把 scanWaits 需要的"保留幸存行的 priority/concurrency_key"分支收编进来。
2. `scanWaits` 改调 `enqueue()`,删除开码 SQL。
3. stub 测试:两条路径的 SQL 收敛为同一模板;wait 恢复用例断言冲突分支语义与选项一致。
4. 顺带核对其他 re-enqueue 调用点(retry 退避入队、resume)是否都已走 `enqueue()`,有漏网一并收编。

## 验收标准

- grep `INSERT INTO queue` 在 kernel 中只剩 `enqueue()` 一处。
- wait 挂起→恢复的 e2e(含 priority/concurrency_key 的 run)行为不回归;notify、concurrency 验收场景绿。

## 涉及文件

- `packages/kernel/src/orchestrator.ts:439-445`
- `packages/kernel/src/queue.ts:67-107`
- `packages/kernel/test/`
