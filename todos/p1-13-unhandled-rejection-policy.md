# P1-13 — 任意 `unhandledRejection`(包括用户 task 代码的)直接杀死 daemon

- 优先级:P1(可靠性)
- 区域:worker
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#13)

## 现状

`apps/worker/src/main.ts:755-756`:

```ts
process.on('unhandledRejection', (reason) => crash('unhandledRejection', reason));
```

`crash()` 无条件置 `fatal` 并 `process.exit(1)`。daemon 自身代码对此很干净(executor 的 flushLogs、waiter sweep、心跳 IIFE 都自兜),但 daemon 的本职是 `await import()` 并**进程内执行用户 task 模块**(`loader.ts:61`)——用户代码的 promise 卫生不受控。注释以 "continuing to serve is not an option after an uncaught exception" 论证,这对 `uncaughtException` 成立,对一个游离的 rejected promise 不成立。

## 影响

某个 task 里一句 `void sendMetric()`(偶发 500)就放倒整个 daemon:最多 `concurrency` 个无关 in-flight run 被丢给 lease reaper,每个恢复烧一次 `recoveries` 预算;纯本地多 agent 场景下 = 全部 agent 同时中断。

## 实现方案

1. `unhandledRejection` 改为:记一条带 crash 上下文的 error 日志 + `/metrics` 计数器 `better_trigger_unhandled_rejections_total`,**不退出**。
2. `uncaughtException` 保持 fatal 不变(状态可能已损坏,退出是对的)。
3. 加 env 门控 `BETTER_TRIGGER_FATAL_UNHANDLED_REJECTION=1` 恢复旧行为(有人想要 fail-fast 语义时可选),`--help`/README 记入(接 p2-26)。
4. 日志文案指向责任方:打出 reason 的 stack 并提示"多半来自 task 代码中未 await 的 promise"。

## 验收标准

- 测试(spawn 真 daemon 或 harness):task 内 `void Promise.reject(new Error(...))`,断言 daemon 存活、后续 run 照常执行、计数器 +1、日志含提示。
- 设 `BETTER_TRIGGER_FATAL_UNHANDLED_REJECTION=1` 时行为回到 exit(1)。
- crash 验收场景(SIGKILL 路径)不受影响。

## 涉及文件

- `apps/worker/src/main.ts:720-756`
- `apps/worker/src/metrics.ts`(或等价文件)
- `apps/worker/README.md`、`.env.example`
