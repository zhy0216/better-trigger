difficulty: medium

# 10 · testing 包 harness 修复与测试补齐

只动 `packages/testing`（该包目前零自有测试），与其他文件不相交，可并行。

## T1 · 超时与轮询语义修复（P2）

- 做什么：
  - `poll.ts:91-104` `waitForStatus` 用 `.catch(() => 通用超时错误)` 吞掉 `waitFor` 的快速失败中止判定（"gave up waiting for … — <reason>"）——到达终态的 run 被误报为超时。catch 里对已是 `AssertionFailure` 的错误直接重抛，只包装纯超时。
  - `daemon.ts:111-118` `waitForHealth` 与 `poll.ts:45` `waitFor` 的 deadline 只在 `cond()` 调用之间检查，探测 `fetch()` 无超时——接受连接但不应答的 daemon 会无限阻塞在 `cond()` 内，`timeoutMs` 形同虚设。给每次探测加 `AbortSignal.timeout(...)`。
- 预计文件：`packages/testing/src/poll.ts`、`packages/testing/src/daemon.ts`、新增 `packages/testing/test/`。
- 验收：中置失败的错误保留原消息；黑盒连接下 `waitForHealth` 在 `timeoutMs` 内返回；新增测试。
- 前置依赖：无。

## T2 · 进程生命周期健壮性（P2）

- 做什么：
  - `daemon.ts:62-67` `spawnDaemon` 在 `serve && opts.port === undefined` 时推 `--port undefined`——抛错或回退 `freePort()`。
  - `daemon.ts:96-106` `Daemon.stop()` 的 `Promise.race` 败方 `sleep(graceMs)`（默认 10s）从不清除，压住事件循环——进程退出侧获胜时清除定时器（或 `unref`）。
  - `daemon.ts:121-125,132-142` `startDaemon` 先 spawn 再等健康，健康失败时子进程无人 kill（`withDaemon` 在 `startDaemon` resolve 后才注册清理）——健康等待包 try/catch，失败先 `daemon.kill()` 再抛。
  - `daemon.ts:84-87` spawn 错误处理器直接 `process.exit(1)`，跳过全部场景清理，违背 `scenario.ts:11-13` 声明的设计（"失败以异常传播，清理照常执行"）——改为向等待方抛异常。
- 预计文件：`packages/testing/src/daemon.ts`、新增测试。
- 验收：无端口时报错明确；`stop()` 后无遗留定时器；健康失败不留孤儿进程；spawn 失败以异常传播；各项有测试。
- 前置依赖：无。

## T3 · 数据库 URL 与连接池修复（P2）

- 做什么：
  - `database.ts:20-29` `baseUrl()` 清 `pathname` 但保留 `search`：`postgres://u@h:5432/bt?sslmode=require` → 派生出 `...:5432?sslmode=require/x` 这类畸形串。同时清 `search`/`hash`（或显式解析 host/auth）。
  - `database.ts:108-110` `resetDb` 在 `migrate` 抛错时泄漏新建的 pool——try/catch 中 `await pool.end()` 再抛。
  - `database.ts:32-35` `portFromEnv` 对非数字 env 返回 `NaN`——校验并回退（或抛错点名该 env 变量）。
- 预计文件：`packages/testing/src/database.ts`、新增测试。
- 验收：带查询串的 DATABASE_URL 派生结果合法；迁移失败无泄漏；坏端口值不产生 `--port NaN`；各项有测试。
- 前置依赖：无。

## T4 · namespace 转发与 injectable clock（P2）

- 做什么：
  - `poll.ts:72-79` `RunStatusReader` 声明 `getRun(runId, namespace?)` 但 `readStatus` 恒调 `reader.getRun(runId)`，非默认 namespace 无法经对象 reader 轮询——给 `waitForStatus` opts 加可选 `namespace` 并转发（或删掉类型里的假承诺）。
  - 为 `waitFor`/`waitForStatus` 注入可选时钟（`now`/`setTimeout` 可替换），使超时、退避、中止语义可确定性测试（为 roadmap 的虚拟时间铺路）。
- 预计文件：`packages/testing/src/poll.ts`、新增测试。
- 验收：对象 reader 可轮询指定 namespace；注入假时钟后可在不真实等待的情况下断言超时/中止/错误吞咽契约。
- 前置依赖：T1（同文件 `poll.ts`）。

## T5 · invariants 单元测试（P2）

- 做什么：`invariants.ts` 的基线逻辑（append-only ledger 比较、终态不可变、最早快照放宽）目前只被验收场景间接覆盖。新增单元测试：completed 行被改写、failed 行 attempt 回退等违例检出；合法演进不误报。
- 预计文件：`packages/testing/test/`（新），`packages/testing/package.json`（补 `test` 脚本，使其进入 `turbo run test`）。
- 验收：`bun run test` 覆盖 testing 包；违例与合法用例各≥2。
- 前置依赖：无。

## 本文件验证

`bun run typecheck && bun run lint && bun run build && bun run test`（testing 包测试脚本接入后随仓库套件运行）。
