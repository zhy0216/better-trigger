difficulty: medium
agent: inherit

# Run 详情异步操作与复制反馈

对应 F16–F17。优先级 P1。依赖：07-dashboard-query-lifecycle.md。不改变 retryIntentKey 在请求 settle 后结束意图的现有协议，结果未知时保留 key 的新交互属于 roadmap R2。

## T1 · 防止旧 run 操作影响当前界面

- 要做什么：RunHeader 的 cancel/retry 持有 AbortController 和同步 pending/generation 所有权，把已有 signal 参数传给 API。卸载或 run/env/key 身份改变时退役请求；在 onRetried、recordConnectionError、pending/error 更新前验证身份。
- 预计修改：`apps/web/src/features/run/RunView.tsx`、`apps/web/test/runActions.test.tsx`，必要的 `retryIntentKey.ts` 身份生命周期适配（保留 settle 协议）。API 已支持 cancel/retry signal，优先直接使用，不扩大改动面。
- 验收：发 retry 后离开详情/切 env/key，迟到成功不跳走当前页面，迟到 401 不把新凭据标坏；旧 finally 不清新操作状态。当前界面的合法 retry 仍导航新 run；同 tick 重复入口最多派发一个操作，现有 idempotency header/明确新意图测试通过。取消传输不显示成服务器操作已撤销。
- 前置依赖：07 合入。

## T2 · 查明并稳定复制反馈的时序

- 要做什么：在 07 的当前响应/终态逻辑上复核 plan 记录的 copy test 失败，追踪 CopyButton 的 value effect、request ref、Inspector 重挂载和 clipboard deferred completion。确定性地覆盖发现的时序，再做最小修复；如问题由 07 已修，补充证明并保留原始失败信息。
- 预计修改：`apps/web/src/features/run/RunView.tsx`、`apps/web/test/runView.test.tsx`。
- 验收：完整 hidden payload 被复制并可见 Copied；拒绝访问显示 Copy failed；切 span/run 后旧复制不得更新新目标。新测试能控制导致失败的时序，不能仅增加 waitFor timeout、删断言或靠无解释重复通过。若仍不能复现具体根因，明确报告证据边界，协调器不得伪称已找到根因。
- 前置依赖：07 合入；与 T1 同组件统一验证。

验证：`bun run --cwd apps/web test -- test/runActions.test.tsx test/runView.test.tsx test/logStream.test.tsx test/hooks.test.tsx`；完整仓库 gate；最终含 PG 的根 tests 由协调器执行并记录。无需为复制按钮增加新的产品功能。一个最终 commit，满足全部条目后归档。

## 完成记录 · 2026-09-08

T1–T2 验收完成，基于已集成 07 的 `93976c6`。实现仅修改 `RunView.tsx`；`retryIntentKey.ts` 仅同步 holder 所有权注释，函数和 settle 协议不变。回归仅修改 `runActions.test.tsx`、`runView.test.tsx`，共新增 42 项测试。另归档本 todo、更新 README 自己行。未修改 hooks/API、其他任务或 plan；未执行 roadmap R1–R7、rebase/merge、push/PR 或其他分支写操作。Bun 1.4.2，在本 worktree frozen install，无依赖升级或跨 worktree 的 node_modules/dist 复用。

### 逐条验收证据

- [x] **T1：请求生命周期和身份。** RunHeader 按 run/env/API key version 建立 generation，在 layout cleanup 中退役并 abort 自己的 controller；retry/cancel 均传递已有 API signal。外部 key version 在每次提交前直接读取，覆盖 key 已改变但 React 尚未提交的窗口。状态快照也绑定 generation，切换时立即清空旧 pending/error。
- [x] **T1：迟到结果不能导航、报错或污染凭据。** 两类操作分别覆盖换 run、换 env、换 key、撤销 key、离开详情、卸载 × 迟到成功/401，fetch 故意忽略 abort。断言传输已 aborted、onRetried 未触发、无旧 alert、连接未变 unauthorized。延迟订阅通知的两个独立测试，在 signal 仍未 aborted 时完成旧成功/401，证明外部 key version 检查本身有效。
- [x] **T1：旧 finally 不清新操作。** 对两类操作分别受控保持 RunHeader 挂载，执行 run/env/key A→B→A；新请求无需等待旧 promise，旧 401 settle 后新按钮仍 disabled/pending、新 signal 未 abort、无旧 error/unauthorized。新请求合法完成后恢复按钮；合法 retry 仅导航当前返回的新 run。
- [x] **T1：同步 single-flight 和现有意图。** 根 StrictMode 下同一 act/tick 两次 click 只派发一次 retry/cancel。原有 Idempotency-Key header、holder 复用/clear、成功 settle 后新 key、失败 settle 后新 key、合法 retry 导航和当前 401 上报用例全部通过。每个已派发操作持有自己的 holder，旧 finally 只清自己的 key；任何 settle 仍结束该意图，没有实现 R2 的结果未知重发交互。
- [x] **T1：传输取消不冒充服务器撤销。** fetch 遵守 abort 的离开详情用例不显示错误或 Canceled；即使 cancel HTTP 成功，状态也仍由原有 poll 读取服务器状态，不乐观宣称服务器已取消。
- [x] **T2：完整隐藏内容及失败反馈。** 原始 collapsed payload 测试保持原断言和默认 timeout，完整 JSON 传给 clipboard 并显示 Copied；拒绝访问显示 Copy failed，切 span 清空反馈。没有新增产品功能。
- [x] **T2：确定性复现与最小修复。** `preserves a copy started after DOM commit but before passive effects` 同步提供已接受详情，在父 layout effect 点击已提交的 Copy Payload，clipboard 用 deferred promise 控制完成。在未修复的 RunView 上确定性得到 `expected '' to be 'Copied'`，修复后通过，且断言原 payload DOM 仍 connected。只将 CopyButton 的 value effect 从 useEffect 改为 useLayoutEffect，使初始化/退役先于按钮激活。
- [x] **T2：value、Inspector 和异步完成各自有证据。** 同值详情重渲染保持同一个 Output section 和 pending copy；值改变后旧拒绝不得清新 pending。span/run × 旧成功/失败四项测试确认旧 Inspector DOM 已断开，新 copy 持续 pending，只有新 promise 完成才显示 Copied；run 切换用相同 output 字节验证不能只按 value 判定目标。

### F17 时序结论与证据边界

受控复现中，旧代码的 request ref 起始为 0：layout 阶段点击使它变为 1；随后挂载的被动 value effect 把它加到 2 并将 status 设回 idle；clipboard 完成仍携带 request=1，因此被丢弃。这一序列不需要 value 变化或 Inspector 重挂载。改成 layout effect 后，初始化先发生，click 取得后续 request，合法完成能显示反馈。

**该受控竞态已复现并修复，但不能据此宣称已经证明计划中首次 PG 根测试失败的历史根因。** 原失败没有 effect/DOM/request 轨迹，本任务也没有在原始未改测试中再次自然观察到它。07 的当前响应/终态行为保留，原复制测试在本任务修改前 53/53 基线、修改后所有局部与根测试中均通过。没有用延长 timeout、删除断言或无解释重复通过替代证据；协调器交接时须继续保留这一归因边界。

原始计划的首次失败原文保持不变：

```text
FAIL test/runView.test.tsx > Inspector content and copy feedback > puts the error before a collapsed large payload and copies the complete hidden content
AssertionError: expected '' to be 'Copied' // Object.is equality
```

原计划后续复核为 1,594 tests / 19 acceptance harnesses 通过；这些是历史基线，不是本任务另跑的 acceptance。07 的首次根失败及后续通过同样保留：

```text
FAIL test/waiters.test.ts > waiter registry > a terminal notification settles every waiter of that run with output/error
AssertionError: expected 3 to be 2 // Object.is equality
```

07 用受控 25ms 间隔复现其 20ms sweep/5ms 等待计时假设，后续根复核及协调器 gate 通过。本任务未修改 waiters，也不把本次根通过当作消除该既有计时风险的证明。

### 验证命令、结果与首次失败

原始日志、PG runner 和清理证据全部保存在 `/tmp/bt-08-controls-UNPLIj/`，每次运行使用不同文件。下表 `L` 为本 todo 指定的完整四文件局部命令：

```sh
bun run --cwd apps/web test -- test/runActions.test.tsx test/runView.test.tsx test/logStream.test.tsx test/hooks.test.tsx
```

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `bun install --frozen-lockfile` | 通过，588 packages，锁文件未变 | `01-install.log` |
| `L`，修改前基线 | 4 files / 53 tests 通过 | `02-local-baseline.log` |
| `L`，新增回归、业务源码未修复 | 29 失败 / 60 通过；同 tick 双派发、未 abort、复制反馈空字符串均确定性复现 | `03-regressions-original-source.log` |
| `L`，首轮业务修复后 | 4 files / 89 tests 通过 | `04-local-after-fix.log` |
| `bun run --cwd apps/web lint` | 通过 | `05-web-lint-first.log` |
| `L`，补充身份往返后 | 4 files / 94 tests 通过 | `06-local-final.log` |
| `git diff --check`，源码阶段 | 通过 | `07-diff-check-source.log` |
| `TURBO_FORCE=true bun run lint`，首次 | 9/9 tasks 通过，0 cached | `08-root-lint.log` |
| `TURBO_FORCE=true bun run typecheck`，首次 | 失败：两个新增测试使用 web lib 不支持的 Array.at，TS2550 | `09-root-typecheck.log` |
| `TURBO_FORCE=true bun run build`，首次 | 同一 TS2550 失败；未改变配置，以 pop 替换两处 at | `10-root-build.log` |
| `L`，新增提交前窗口断言后 | 2 失败 / 93 通过；断言 signal 未 abort 时实际为 true，证明原测试安排没有控制住 React 提交；失败时伴随 act 环境警告 | `11-local-after-type-fix.log` |
| `TURBO_FORCE=true bun run lint`，类型修复后 | 9/9 tasks 通过，0 cached | `12-root-lint-final.log` |
| `L`，显式延迟 key 订阅通知后 | 4 files / 95 tests 通过，保留 signal 未 abort 断言；无 act 警告 | `13-local-notification-controlled.log` |
| `TURBO_FORCE=true bun run lint`，最终 | 9/9 tasks 通过，0 cached | `14-root-lint-final.log` |
| `TURBO_FORCE=true bun run typecheck`，最终 | 14/14 tasks 通过，0 cached | `15-root-typecheck-final.log` |
| `TURBO_FORCE=true bun run build`，最终 | 7/7 tasks 通过，0 cached，worker artifacts 验证通过 | `16-root-build-final.log` |
| `bun run test -- --force`，独占临时 PostgreSQL 16 | 首次完整通过：157 files / 1,818 tests；web 267、kernel 439；13/13 tasks，0 cached，无测试 skip | `17-root-test-pg-first.log` |
| `L`，最终指定命令 | 4 files / 95 tests 通过 | `18-local-prescribed-final.log` |
| Bun 日志/PG 清理审计 | 核实 1,818 tests、无测试 skip、独占目录已删除 | `19-pg-audit.log` |
| `git diff --check`，最终源码与归档 | 通过 | `20-diff-check-source-final.log`、`21-diff-check-archive-final.log` |

PG 通过 `bun /tmp/bt-08-controls-UNPLIj/run-pg.ts 17` 运行：mkdtemp 创建本任务独占 cluster，系统随机 loopback 端口、合成测试用户名，URL 通过已有 `turbo.json` 的 `test.env` 传入所有测试任务。finally 中 pg_ctl stop 成功并删除自己的目录；`17-pg-runner.log`、`17-{initdb,start,postgres,stop}.log`、`17-cleanup.json` 记录全过程。没有复用探索 cluster 或用户数据库。最终集成含 PG 根 tests 和 acceptance 仍由协调器独立执行。

保留现有构建警告 `WARN TypeScript 7.0 does not yet have a stable API and is experimental. Some options will be unavailable.` 未升级工具链。无未完成验收或实现 blocker；剩余限制为上述历史 F17 归因边界、既有 waiters 计时风险，以及计划明确延后的 R2 交互。当前任务分支仅创建一个本地任务 commit，等待协调器集成通知。

## 集成阶段复核 · 2026-09-08

协调器持有集成锁并明确授权后，在当前任务分支执行 `git rebase main`。当时 main 最新提交仍为 `93976c68f929be687ebcc6a2a65a15785649c15e`，Git 返回 `Current branch herdr/plan-repo-20260907-08-controls is up to date.`，无需重放提交，没有冲突。四个业务/测试文件与原任务提交 `f205a387ab0750b8913f47ab1d79a0e449b1ac15` 完全一致，无需实现修复；所有已合入任务的源码、说明和 README 完成行保持不变。

本轮原始日志独立保存于 `/tmp/bt-08-rebase-dbRG9F/`，未覆盖此前日志或首次失败。

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `git rebase main` | 已是最新基线，无冲突 | `01-rebase.log` |
| `bun run --cwd apps/web test -- test/runActions.test.tsx test/runView.test.tsx test/logStream.test.tsx test/hooks.test.tsx` | 4 files / 95 tests 通过 | `02-local.log` |
| `TURBO_FORCE=true bun run lint` | 9/9 tasks 通过，0 cached | `03-lint.log` |
| `TURBO_FORCE=true bun run typecheck` | 14/14 tasks 通过，0 cached | `04-typecheck.log` |
| `TURBO_FORCE=true bun run build` | 7/7 tasks 通过，0 cached，worker artifacts 验证通过 | `05-build.log` |
| `bun run test -- --force`，新建独占 PG cluster | 本轮首次完整通过：157 files / 1,818 tests；web 267、kernel 439；13/13 tasks，0 cached，无测试 skip | `06-root-test-pg-first.log` |
| `bun /tmp/bt-08-rebase-dbRG9F/audit.ts` | 总数/无 skip/PG 清理通过；四个源码测试文件未变，README 除 08 行外与 main 相同，原归档证据完整保留 | `07-audit.log` |
| `git diff --check`、`git diff main --check`、`git diff --cached --check` | 通过 | `08-diff-check.log`、`09-staged-check.log` |

PG runner 为 `bun /tmp/bt-08-rebase-dbRG9F/run-pg.ts 06`：再次用 mkdtemp 创建独占目录、随机 loopback 端口和合成用户，通过现有 Turbo test.env 传入 DATABASE_URL。finally 正常停止并删除本轮 cluster，`06-pg-runner.log`、`06-cleanup.json` 与 `07-audit.log` 核实清理；未复用上轮 cluster 或用户 DB。

本轮无新增失败。既有 TypeScript 7 experimental API 警告、原 copy/waiters 首败与各次复核记录全部保留；F17 历史首败归因边界仍成立。仅将本节复核证据及 README 的 08 行 amend 入当前任务 commit，保持 main 之上一个最终任务 commit，未 merge、push、切换原 checkout 或清理 worktree。
