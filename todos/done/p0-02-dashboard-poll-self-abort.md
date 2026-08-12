# P0-02 — Dashboard 轮询每 2s abort 上一个请求,慢响应永远完成不了

- 优先级:P0(可用性,dashboard 核心路径)
- 区域:web
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#2)

## 现状

`apps/web/src/api/hooks.ts:116-136` 的 `usePoll`:

```ts
const run = async () => {
  controller?.abort();               // 每次 tick 先杀上一个 in-flight 请求
  controller = new AbortController();
  ...
};
void run();
const timer = setInterval(run, POLL_MS);   // POLL_MS = 2000,无条件触发
```

catch 里 `if (e.name === 'AbortError') return;` —— 被 abort 的请求不设 `error`、不清 `loading`。

## 影响

任何超过 2s 的响应(大 run 的 detail:REPEATABLE READ 快照里 4 条查询 + 200 行日志;或 retention 关闭后变大的 `/runs`)被永远中断:`data` 停在 `null`、`loading` 停在 `true`、`error` 停在 `null`,页面钉死在 "Connecting to server…",无报错、无恢复路径。同时浏览器 abort 并不取消服务端语句,daemon 每 2s 重新执行一遍被抛弃的查询——dashboard 越慢,daemon 负载越大,恶性放大。

## 实现方案

1. `usePoll` 增加 in-flight 守卫:`run()` 开头 `if (inFlight) return; inFlight = true`,`finally` 里复位。或者等价地改为自我重排的 `setTimeout`:请求完成(`finally`)后再 `setTimeout(run, POLL_MS)`,天然不重叠。推荐后者——同时消除了"响应耗时 1.9s 时下一次请求 0.1s 后就到"的抖动。
2. `controller.abort()` 只保留在 effect cleanup(unmount / 依赖变化 / enabled 翻转)里,不再出现在 `run()` 内。
3. cleanup 里除 `clearInterval`/`clearTimeout` 外保持现有 `mounted` 守卫不变。
4. 顺手:AbortError 分支加一行注释说明"只有 cleanup 会 abort,所以静默返回是安全的"。

## 验收标准

- 新增 `apps/web/test` 用例(fake timers + mock fetch):
  - fetcher 耗时 3×POLL_MS 时,请求不被中断、最终 `data` 落地、期间不产生第二个并发请求;
  - unmount 时 in-flight 请求被 abort 且不触发 setState;
  - 正常快速响应下轮询节奏不回退(仍约每 2s 一次)。
- 手工验证:构造一个 >2s 的 `/runs/:id`(大量日志行),run detail 页能渲染而不是停在 Connecting。
- 现有 `hooks.test.tsx` 全绿。

## 涉及文件

- `apps/web/src/api/hooks.ts:105-144`
- `apps/web/test/hooks.test.tsx`
