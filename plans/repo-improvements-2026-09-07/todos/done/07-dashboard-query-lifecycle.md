difficulty: hard
agent: inherit

# Dashboard 查询、分页与凭据生命周期

对应 F13–F15。优先级 P1。前置依赖：无。本任务处理 hooks/API 数据层，不修改 RunView；其控件在 08 中完成。

## T1 · 所有数据请求共享当前查询身份

- 要做什么：把 env/filter/runId/API key version 纳入明确的 generation。切身份立即清空不再属于当前查询的数据、分页游标和错误；loadMore/loadOlderLogs 拥有 controller 并传入已有 API signal 参数，卸载、换 key、换查询时取消；迟到结果无论是否遵守 signal 都不得提交。
- 预计修改：`apps/web/src/api/hooks.ts`，必要的 `apps/web/src/api/client.ts`；`apps/web/test/hooks.test.tsx`、`apiAuth.test.tsx`、`envPropagation.test.tsx`，必要分页测试。
- 验收：key A 的 pending page 在切 key B 时 signal aborted，迟到 page 不进入 B 的 head/tail/logs；prod→staging→prod、run A→B→A 同样安全。凭据撤销/更换后旧数据不以当前身份继续展示；卸载立即释放控制器，旧 finally 不清新 spinner。保留有意暂停时的当前身份画面。
- 前置依赖：无。

## T2 · 终态只来自已接受的当前响应

- 要做什么：移除 fetcher 在 usePoll guard 前更新 terminal 的副作用，终态暂停从当前已接受数据或受 generation 保护的 commit 派生。
- 预计修改：`apps/web/src/api/hooks.ts`、`apps/web/test/hooks.test.tsx`。
- 验收：旧 run 的迟到 completed/failed/canceled 不能 abort 新 run 请求或让新 run 永远 loading；合法终态到达后停止轮询且保持完整详情；run/env/key 变化后重新获取。用受控 deferred promise 复现，不依赖真实时间等待。
- 前置依赖：本文件 T1。

## T3 · 分页使用同步 single-flight 所有权

- 要做什么：为两类分页增加渲染之外可立即生效的请求锁，与 generation/controller 生命周期一起清理；保留独立 tail cursor、去重和错误重试能力。
- 预计修改：上述 hooks 与测试。
- 验收：同一 act/tick 调两次 loader 最多派发一次请求；新 generation 可立即重新加载；旧 promise 完成/失败不会释放新 generation 的锁。已加载数据不重复、顺序不变，合法失败可重试。
- 前置依赖：本文件 T1。

验证：`bun run --cwd apps/web test -- test/hooks.test.tsx test/apiAuth.test.tsx test/envPropagation.test.tsx test/mergeRuns.test.ts test/runView.test.tsx test/logStream.test.tsx`，然后完整仓库 gate。保留 plan 中首次 copy feedback 的失败记录；若 T2 已解释/解决，给 08 明确复现和修复证据。一个最终 commit。

## 完成记录 · 2026-09-07

T1–T3 全部验收通过。实现仅修改 `apps/web/src/api/hooks.ts`；测试修改 `hooks.test.tsx`、`apiAuth.test.tsx`，新增必要的 `pagination.test.tsx`。未修改 client、RunView、其他任务状态、plan 或 roadmap，也未升级依赖。Bun 1.4.2，当前独立 worktree 自行 frozen install；构建全部强制执行，未恢复其他 worktree 的 dist。

### 逐条验收证据

- [x] **T1：统一身份及立即清空。** `useQueryGeneration` 将 env、实际使用的 filter/runId 和 API key version 合入一个共享 generation；不同对象区分 A→B→A。`useQueryState` 在切身份的 render 清空 head、tail、日志、游标、错误及分页 spinner，排队的状态更新也绑定原 generation。分页测试用 layout effect 记录提交的画面，确认切换后的第一帧即为空。
- [x] **T1：取消与迟到结果。** generation 在 layout cleanup 中 abort 所有在途 controller；两种分页均传递 API 的 signal。`pagination.test.tsx` 覆盖 key 更换/撤销、prod→staging→prod、run A→B→A、filter 往返、status/taskId/limit 各自改变，以及同时在途 head/page 的卸载。模拟 fetch 故意忽略 signal，其迟到成功/失败不能写当前数据、游标、错误或连接状态；保存的旧 loader 在换身份/卸载后也不能派发。
- [x] **T1：暂停和其他读取。** 有意暂停保留当前 runs head/tail，并停止轮询；暂停期间换 key 立即清空，恢复后按新 key 获取。`apiAuth.test.tsx` 逐一验证 tasks/schedules/workers 的凭据更换/撤销、旧错误清空和迟到 401 丢弃。终态详情换 key/env/run 也重新获取。
- [x] **T2：只有已接受响应决定终态。** 移除详情 fetcher 的 `setTerminal`；`usePoll` 在生命周期/凭据/signal guard 后接受完整响应，再派生停止轮询条件。三个 deferred 用例分别让旧 run 返回 completed/failed/canceled，确认新 run 请求未 aborted、能够结束 loading 并继续轮询；三个合法终态用例确认 payload、output、steps、logs 全部保留，后续 timer/visibility 不再派发，换 key/env/run 重新获取。根 StrictMode 的 effect 清理重放也有独立 deferred 回归；不依赖真实时间等待。
- [x] **T3：同步 single-flight 和所有权。** 分页 controller ref 在 loader 调用时立即占锁。同一 act 连续调用两次仅派发一次；新 generation 不等待已 abort 但仍未 settle 的旧 promise。旧成功/失败/finally 均不能释放新锁或清除新 spinner。失败重试继续使用原 cursor；跨页重叠去重、顺序、独立 tail cursor 和 head 刷新后仍保持耗尽均通过两种分页的回归。

### 验证命令与日志

完整原始日志保留于 `/tmp/bt-07-queries-QLz4up/`；表中为相应文件名。`L` 表示本 todo 上文指定的六文件局部命令；`L+` 为同一命令增加 `test/pagination.test.tsx`。新增 45 项回归，根测试从基线 1,594 增为 1,639。

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `bun install --frozen-lockfile` | 通过；588 packages，锁文件未变 | `01-install.log` |
| `L`，修改前基线 | 6 files / 58 tests 通过 | `02-local-baseline.log` |
| `L+`，首轮新增回归 | 87 通过、1 失败：嵌套 StrictMode 没有重放 effect | `03-local-regressions-first.log` |
| `bun run --cwd apps/web lint`，首次 | 失败：generation 的可变 active 字段触发 immutability | `04-web-lint-first.log` |
| `L+`，修复上述问题 | 7 files / 94 tests 通过 | `05-local-regressions-after-fixes.log` |
| `bun run --cwd apps/web lint`，修复后 | 通过；生命周期标记改为 ref，未禁用规则 | `06-web-lint-after-fix.log` |
| `bun run --cwd apps/web test -- test/hooks.test.tsx test/pagination.test.tsx test/apiAuth.test.tsx`，临时恢复原始 hooks 的对照 | 39 失败、36 通过；trap 已恢复修复版源码 | `07-original-source-regression.log` |
| `L+`，补齐 head 往返及各 filter 独立回归后 | 7 files / 103 tests 通过 | `08-local-final.log` |
| `bun run lint` | 9/9 tasks 通过；7 个未改 workspace 命中 lint 缓存，web/root 实际执行 | `09-root-lint.log` |
| `TURBO_FORCE=true bun run typecheck` | 14/14 tasks 通过，0 cached | `10-root-typecheck-first.log` |
| `TURBO_FORCE=true bun run build` | 7/7 tasks 通过，0 cached；worker artifacts 验证通过 | `11-root-build.log` |
| `bun run test -- --force`，第一个独占 PG cluster | 首次失败：worker waiters 断言；web 225/225 通过，Turbo 中止了未完成的 kernel suite，不能计为完整 PG 结果 | `12-root-test-pg-first.log` |
| `bun run --cwd apps/worker test -- test/waiters.test.ts` | 61/61 通过 | `13-waiters-recheck.log` |
| `bun /tmp/bt-07-queries-QLz4up/waiters-timing-probe.ts` | 受控 25ms 间隔复现 SELECTs=3、pending=2，证实下述真实计时假设问题 | `14-waiters-timing-probe.log` |
| `bun run test -- --force`，新建独占 PG cluster 复核 | 157 files / 1,639 tests 通过；13/13 tasks，0 cached；kernel 59 files / 435 tests；无测试 skip | `15-root-test-pg-recheck.log` |
| `L`，最终指定命令 | 6 files / 71 tests 通过 | `16-local-prescribed.log` |
| `git diff --check` | 源码与归档后均通过 | `19-diff-check-source-final.log`、`20-diff-check-archive-final.log` |

两次 PG 都由 `mktemp -d` 建立独占 cluster，随机 loopback 端口、合成测试用户；通过现有 `turbo.json` 的 `test.env` 将 `DATABASE_URL` 传入 Turbo。runner 的 EXIT trap 停止并删除各自 cluster，初始化/启动/数据库/清理日志分别保存在 `12-*`、`15-*`。清理复核确认两者均已移除（`18-pg-cleanup-audit.log`）；首次辅助日志解析将 PostgreSQL 的 `Unix socket` 错写为小写匹配而报 `Missing owned cluster path`，修正匹配后确认清理成功，此错误不是 cluster 停止失败。

保留既有构建警告：`WARN TypeScript 7.0 does not yet have a stable API and is experimental. Some options will be unavailable.` 本任务不升级工具链。19 个 acceptance harnesses 是计划基线与协调器最终集成 gate，本任务未另行执行，不把基线计为本次运行。

### 首次失败、修复与协调器交接

开发期首次失败均保留：StrictMode 测试改用测试库的根 `reactStrictMode: true` 选项；generation 生命周期所有权改为 ref，lint 通过。对原始 hooks 的对照确认三个迟到终态均会把新请求的 signal 变为 aborted，分页同 tick 会多派发请求，且换 key 继续暴露旧画面；修复版本对应回归全部通过。

本次首次根测试另有范围外失败，未修改相关 worker 源码或测试：

```text
FAIL test/waiters.test.ts > waiter registry > a terminal notification settles every waiter of that run with output/error
AssertionError: expected 3 to be 2 // Object.is equality
test/waiters.test.ts:125:23
```

该用例创建 20ms sweep，再用真实 `setTimeout(5)` 等待注册，假定只发生两次初始 SELECT。临时 probe 在注册和设定 5ms timer 之间施加受控 25ms 间隔，稳定得到 3 次 SELECT、2 个 pending waiter；这证实计数断言依赖调度时序，不声称已观测首次失败时的实际调度间隔。局部复核及第二次完整根测试通过，均不能删除或替代首次失败。此既有测试时序风险交协调器处理。

给 08 的 F17 交接：plan 中的原始失败及后续基线复核保持原样，本任务不声称 T2 已解释或修复复制反馈根因：

```text
FAIL test/runView.test.tsx > Inspector content and copy feedback > puts the error before a collapsed large payload and copies the complete hidden content
AssertionError: expected '' to be 'Copied' // Object.is equality
```

原始基线后续复核为 1,594 tests / 19 acceptance harnesses 通过；本任务修改前六文件基线 58/58、修改后指定局部 71/71、根 web 225/225 均通过，均包含未修改的 runView 复制测试。T2 的确定性复现与修复证据在 `hooks.test.tsx` 的三个 `ignores a retired ... response` 用例和上述原始 hooks 对照日志；F17 仍由 08 调查复制请求、value effect 与组件挂载/DOM 引用的时序，不加大 timeout、不删断言。

本任务实现无未完成验收或 blocker；保留上述范围外 waiters 时序风险及 F17 的复现限制。R1–R7 未执行。

## 集成阶段复核 · 2026-09-08

协调器持有集成锁并授权后，在当前任务分支执行 `git rebase main`，基于 `af56074636c2de8e22d650d8fc0922ee9b1a6c7c`。rebase 无冲突；逐项比较确认 hooks 和三个测试文件与原任务提交 `b3ce49e` 完全一致，无需代码修复。main 已集成的 01、02、04、09 实现和文档保持不变；README 除自己的 07 行外，全文与 main 一致，包含全部已有完成行。

本轮日志独立保存在 `/tmp/bt-07-rebase-OAIOfG/`，未覆盖此前任何日志或首次失败记录。

| 命令 | rebase 后结果 | 日志 |
| --- | --- | --- |
| `bun run --cwd apps/web test -- test/hooks.test.tsx test/apiAuth.test.tsx test/envPropagation.test.tsx test/mergeRuns.test.ts test/runView.test.tsx test/logStream.test.tsx test/pagination.test.tsx` | 7 files / 103 tests 通过 | `01-local-tests.log` |
| `TURBO_FORCE=true bun run lint` | 9/9 tasks 通过，0 cached | `02-lint.log` |
| `TURBO_FORCE=true bun run typecheck` | 14/14 tasks 通过，0 cached | `03-typecheck.log` |
| `TURBO_FORCE=true bun run build` | 7/7 tasks 通过，0 cached | `04-build.log` |
| `bun run test -- --force`，新建独占 PG cluster | 首轮完整通过：157 files / 1,776 tests；13/13 tasks，0 cached；web 225、kernel 439；无测试 skip | `05-root-test-pg-first.log` |
| `git diff --check`、`git diff main --check`、`git diff --cached --check` | 通过 | `08-diff-check.log` |

本轮重新使用 mktemp cluster、随机 loopback 端口和合成用户，通过现有 Turbo `test.env` 传递 `DATABASE_URL`。EXIT trap 已停止并删除本轮 cluster，`07-pg-audit.log` 核实清理与测试总数。根测试总数增加来自 main 新合入的测试，本任务仍为新增 45 项回归。本轮无新增失败；此前 waiters 首次失败、原始 copy feedback 失败与各次复核结果均保留。只将本节复核证据和 README 自己行 amend 入当前任务提交，保持 main 之上一个最终任务 commit。
