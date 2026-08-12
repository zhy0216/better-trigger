# P2-35 — 验收基建:两对场景共享默认端口;`acceptance.ts` 无 per-harness 超时

- 优先级:P2(flake 风险与可诊断性)
- 区域:testing / examples
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」web #10)

## 现状

- 端口冲突对:`code-version-pinning.ts:51` 与 `graceful-restart.ts:60` 都默认 **4905**;`concurrency.ts:70` 与 `stats.ts:28` 都默认 **4906**。`health-pool.ts:46` 自带一个 `freePort()` 却是私有函数,没进 `@better-trigger/testing`。
- `acceptance.ts:113-124` 的 `run()` 是 `spawn` + `proc.on('exit')`,无定时器:一个挂死的场景吃满 CI `timeout-minutes: 20`,报错是 job 超时而不是点名哪个 harness。

## 影响

顺序执行 + 干净退出时无害;但一个残留进程或 TIME_WAIT 就让每对的后者 `EADDRINUSE`,且归因到错的场景;端口共享也结构性堵死并行化(header 只以 lease 时序为由排除并行)。挂死场景的 CI 失败无指向。

## 实现方案

1. 把 `freePort()` 提升进 `packages/testing` 导出;`spawnDaemon`(或各场景的 port 取值)默认用它,`BT_*_PORT` env 覆盖逻辑保留。
2. 四个写死默认端口的场景改走 freePort。
3. `acceptance.ts` 的 `run()` 加 per-harness 超时(宽松,如 5 分钟;env 可调):到时 kill 子进程、以非零结果收场并**打印 harness 名**。
4. 顺手:`examples/basic/package.json` 补齐 `code-version-pinning` / `rolling-deploy` / `migration` 三个缺失的 per-scenario 快捷 script(14/17 → 17/17)。

## 验收标准

- 连续两遍 `bun run test:acceptance` 无 EADDRINUSE;任一场景人为 `while(true)` 挂死时,套件在超时后失败并点名该场景。
- CI 全绿,时长不显著变化。

## 涉及文件

- `packages/testing/src/`(freePort 导出)、`examples/basic/scripts/health-pool.ts:46`
- `examples/basic/scripts/{code-version-pinning,graceful-restart,concurrency,stats}.ts`
- `examples/basic/scripts/acceptance.ts:113-124`、`examples/basic/package.json`
