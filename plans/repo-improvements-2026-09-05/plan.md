# Repo improvements · 2026-09-05

## 意图与探索结论

用户调用 `auto dev`，未给具体功能需求，因此按仓库探索模式检查当前 `main`（起始 HEAD `905a840`），补充前两份已完成计划没有覆盖的实际问题。项目是 Bun workspace + TypeScript + PostgreSQL 的 durable execution runtime，包含 core、db、kernel、SDK、worker、dashboard、文档和验收工具。当前主要执行链路测试通过；本轮集中修复请求生命周期、等待取消/超时、验收可信度、测试数据库隔离及数值边界，不推断“全部测试通过等于没有 bug”。

**执行配置是用户明确要求，覆盖所调用技能的默认值：协调器、实现、修复、rebase 均使用 Codex CLI + YOLO + `gpt-6-astra` + `xhigh`。不得启动 OpenCode，不得按 difficulty 切换 flash/max，不得静默降级。** 本机 Codex 帮助支持相应参数，本机模型目录列出了 `gpt-6-astra` 与 `xhigh`。

```sh
herdr agent start <agent-name> --kind codex --pane <pane-id> -- \
  --dangerously-bypass-approvals-and-sandbox \
  --model gpt-6-astra -c 'model_reasoning_effort="xhigh"'
```

### 探索方法与现有基线

- 已读 `agent.md`、根 README、workspace/build 配置、现有计划与完成记录，并按模块检查现有实现和测试。
- 按用户检索规则先对绝对根路径做一次 zvec 语义探测；返回 `INDEX_MISSING`。后续使用 `rg` 精确定位，没有创建或重建索引。
- 所有脚本通过 `bun run` 调用。不要把 `bun run --bun test` 等强制改变底层解释器的命令当成标准基线。
- `bun run build` 通过；构建包含文档站。部分输出来自 Turbo 缓存，worker build 按配置不缓存。
- `bun run lint`、`bun run typecheck` 标准命令通过；探索末尾已复核。
- `bun run test -- --force --continue` 通过：1,260 tests passed，94 PostgreSQL tests skipped；显式绕过缓存，避免旧结果掩盖问题。
- 在本轮独占的临时 `postgres:16-alpine` 容器中显式传入 `DATABASE_URL`，kernel 全套（含 PG）通过，约 30.1s。完整 acceptance 结果见文末最终基线。
- `check:audit`、`check:deps`、`check:drift`、`check:pkg-meta` 通过；重建后标准 `bun run check:exports` 通过。
- 额外强制 Bun 解释器的实验使 SDK edge-import 的两项 Node 假设测试失败，schema suite 报 `TypeError: undefined is not an object (evaluating 'z.object')`。Turbo 随后终止尚在构建的 worker，一次 exports 检查因此报 `dashboard entry is missing: public/index.html`；重新标准构建后恢复。此实验不计为标准命令回归。
- 构建警告原文：`TypeScript 7.0 does not yet have a stable API and is experimental. Some options will be unavailable.`；缓存日志还带 `ExperimentalWarning: Type Stripping is an experimental feature and might change at any time`。列入 roadmap，不以禁用警告掩盖问题。
- 精确扫描未找到匹配所查私钥/长期 token 模式的 tracked source；这只说明该扫描未命中，不代表完整安全审计。

## 目标 / 非目标

目标：修复下表全部非 roadmap 项；新增能复现实际失败的回归测试；保持 public SDK 导出兼容、core 零运行时依赖、SDK 只依赖 core、Postgres 为唯一运行时基础设施。每个 todo 一个 worktree、一个最终任务 commit，协调器串行复核、rebase、校验并快进合入原分支。

非目标：不实施 events、agent layer、cancel cascade 等新产品能力；不做状态机大拆分或全面依赖升级；不配置 npm/GitHub 外部账户、不发布、不 push、不创建 PR；不修改全局技能文件。上轮 npm trusted publisher 外部验证仍是已记录的 deferred 项，本轮不扩大授权范围。

## 完整发现与拆解

| ID | 优先级 | 难度 | 位置与实际问题 | 改进方向 / todo |
|---|---|---|---|---|
| F1 | P1 | medium | `apps/web/src/api/client.ts#request` 收到响应头即清除 10s timer，`res.json()` 在保护区外；成功和错误正文都可永久悬挂，堵住 usePoll。合成慢正文探针得到 `bodyPending=true, activeTimeouts=0`。 | 超时覆盖完整响应体，取消与超时分类明确，轮询可恢复；01。 |
| F2 | P2 | medium | 同一函数给调用者 signal 加匿名 abort listener，仅用 `once`，请求成功后不移除。探针得到 added=1、removed=0。预取消也仍调用 fetch。 | 具名 listener + finally 清理，预取消不派发；并入 01。 |
| F3 | P1 | hard | `apps/worker/src/waiters.ts#register` 只在首次 read 之前检查 stopped。`register → stop → read resolves(running)` 后出现 pending=1，轮询已停，promise 不再结算。 | 关闭与在途注册的线性化、清理和确定性竞态测试；02。 |
| F4 | P1 | hard | `waiters.ts#sweep` 数据库错误直接 return，deadline 只在查询成功后检查。5ms budget、持续 DB 错误的探针 30ms 后仍 pending；挂住的 sweep 同样阻止期限结算。 | 每个注册等待有独立可清理的期限机制，以最后观测状态结算；保留批量查询和 single-flight；02。 |
| F5 | P1 | medium | `packages/testing/src/scenario.ts#runScenario` 用 `crash ? 1 : 0` 判断是否抛错。`throw null` 实测输出 `0 failed`，exit 0；`false/0/undefined/''` 同类。 | 独立记录是否发生异常，任何抛值都失败；03。 |
| F6 | P1 | medium | `ScenarioImpl.runTeardown` 只警告 cleanup 失败，最终仍成功。合成 cleanup throw 实测 exit 0，与“ANY failure”契约矛盾。 | LIFO 全部尝试，收集清理错误、保持原始错误、非零退出；03。 |
| F7 | P1 | easy | `runScenario` 输出完整 `db.url`。带合成密码的探针原样打印密码，真实连接凭据可能进入 CI/终端日志。 | 只打印脱敏连接身份，测试使用假凭据验证输出；03。 |
| F8 | P1 | hard | `packages/testing/src/database.ts#resetDb` 对固定名字执行 `DROP DATABASE ... WITH (FORCE)`；`packages/kernel/test/pg/helpers.ts` 的名字跨 checkout 相同。并行 worktree 的相同 suite 会相互删库、终止连接。 | 默认每次调用分配唯一、受本次调用所有权约束的数据库，清理只能作用于自己创建的资源；04。 |
| F9 | P1 | medium | `database.ts#baseUrl` 丢弃整个 query，包括 `sslmode=require` 等连接级配置；现有测试还把此行为锁定。派生 admin/测试连接改变了用户传输配置。 | 用 URL pathname 替换库名，保留支持的连接/传输参数，移除 fragment，更新旧断言；04。 |
| F10 | P2 | medium | `assertIdentifier` 接受大写与超长名字，但 SQL 未 quote，返回的 URL 又保留原样。存在大小写折叠/63-byte 截断导致的实际名字不一致；migrate 失败只 end pool，留下已创建数据库。 | 最终名称受长度约束且 URL/SQL/返回值一致，迁移失败清理本次已创建资源；04。 |
| F11 | P1 | medium | `packages/core/src/duration.ts` 字符串分支可返回 Infinity，`durationToDate` 未拒绝无效 from；实测 310 位数字+w→Infinity、invalid from→Invalid Date。`backoff.ts` 的 `0 * 2^1024`→NaN，`maxAttempts=2147483648` 通过验证但目标列是 PostgreSQL integer。 | 补有限值/Date/存储边界与零 backoff 溢出保护，保持已有 jitter 语义；05。 |
| F12 | P2 | medium | `packages/sdk/src/client.ts#assertTimeoutMs` 允许大于 int32 timer 范围的值。`2147483648` 被运行时变为 1ms timer，实测约 7ms 就报 timeout。 | 单次请求 timeout 明确有效范围并在派发前拒绝，更新 SDK 文档；06。 |
| F13 | P1 | hard | `packages/kernel/src/runs-read.ts#waitForResult` 未处理同一 options 类型的 signal/throwOnTimeout，未校验 NaN timeout；`Date.now()+pollMs>=deadline` 会提前一个 poll 返回。预取消 + throwOnTimeout + timeout=0 的探针仍查一次 DB 并 resolve running。HTTP 无 registry fallback 也未转发请求 signal。 | 补 kernel 等待契约、取消睡眠/在途等待、合法 timeout、最后不足一个 poll 的等待；共享 ResultTimeoutError 实现，保持 SDK 导出与 instanceof 兼容；07。 |
| F14 | P1 | medium | `scripts/check-audit.mjs#main` 仅以 stdout 可解析判断审计成功，没有验证子进程 status/error/signal 和响应结构。模拟 status=2 + stdout `{}` 实测报告 `audit clean`。 | 验证进程结果与 advisory schema；异常输出不得绿色通过；08。 |
| F15 | P1 | medium | 同脚本 range parser 会短路跳过后续非法项：version `3.0.0`、range `<2.0.0 garbage` 实测返回 false，违反注释承诺的 fail-closed。compareVersions 还直接丢弃 prerelease，未定义 advisory 对预发布版本的规则；这不是已确认的现实 advisory 漏报。 | 先完整解析再匹配，无法解释时失败；明确并测试 prerelease 策略，不能丢弃版本后缀；08。 |
| F16 | P2 | medium | `turbo.json` 已声明 worker build dependsOn web build，但 `apps/worker/scripts/copy-public.mjs` 无条件再次 `bun run build` web。cache hit 也重新编译 dashboard，冷构建重复编译。 | 由单一 build orchestration 管理 web 构建；保留直接 worker build 的可用性和新鲜度，不能靠“dist 存在”判断新鲜；09。 |
| F17 | P2 | medium | 标准 tests 通过但 `runtime-outcomes.test.ts`、`runtime-cancel.test.ts`、`crash-context.test.ts` 的 fake kernel 缺 releaseClaims/deregisterWorker，正常 stop 产生 TypeError 并被容错吞掉。 | 补真实生命周期 stub 和成功 shutdown 断言，保持真实错误分支测试；10。 |

### Roadmap（只记录，不进队列）

| ID | 优先级 | 难度 | 位置 / 发现 | 后续方向 |
|---|---|---|---|---|
| R1 | P2 / roadmap | hard | `orchestrator.ts`、`queue.ts`、`executor.ts` 仍为千行级状态机，事务/锁序/策略混杂；延续上轮发现。 | 独立行为保持重构，不与本轮修复混合。 |
| R2 | P2 / roadmap | hard | `packages/testing` / `kernel/test/pg` 尚无每个持久化边界的系统故障注入和覆盖趋势基线。 | 建立故障矩阵；本轮新增 regression 只覆盖具体问题，不等于完成该 roadmap。 |
| R3 | P2 / roadmap | medium | 根 TypeScript `^6.0.3` 与部分 workspace `^7.0.2` 混用，bundler 声明 TS7 API experimental；强制全 Bun 解释器的测试兼容性实验失败，但标准脚本通过。 | 明确工具链支持矩阵后专门评估收敛；本轮不静默升级/降级或修改 Node 消费者测试含义。 |
| R4 | P2 / roadmap | hard | 文档 roadmap 中 events、fan-in、cancel cascade、virtual time、agent primitives 与插件仍是产品规划。 | 单独设计，不能把探索模式当成这些新功能的产品决策授权。 |

## 方案与依赖

1. 请求/等待的 deadline 必须独立于慢 I/O 能否成功；成功、错误、取消和 shutdown 都要清理监听器和 timer。不能用删测试、吞错、无限等待解决问题。
2. kernel 与 SDK 的 `ResultTimeoutError` 放到 transport-neutral 的 core 再由 SDK 原路径重导出，保持同一构造器身份；kernel 不依赖 SDK。07 在 02/05/06 合入后实施，避免共享文件和语义冲突。
3. 测试数据库默认使用唯一实际名称、仅 CREATE 自己的库。env override 作为逻辑命名前缀保留可辨识性，不能默认拿它 FORCE DROP 他人的库。私有 testing API 的这一变化写进说明；debug 保留应显式选择。并行执行期间即使 04 尚未落地，也必须给数据库校验提供独占临时 PG，不能共享固定库名。
4. audit 是离线逻辑校验 + 在线真实 advisory 两层；允许必要且范围明确的 root devDependency，但不得为此给 core/SDK 加运行时依赖。
5. build 优化不能破坏直接 worker build、Docker、健康版本号、资源 graph 和 clean-pack 不变量。复用缓存必须有可证明的输入依赖，不能以输出存在冒充新鲜。

| 顺序 | todo | 优先级 | 难度 | 依赖 |
|---|---|---|---|---|
| 01 | dashboard-request-lifetime | P1 | medium | 无 |
| 02 | waiter-lifecycle-deadlines | P1 | hard | 无 |
| 03 | scenario-verdict-redaction | P1 | medium | 无 |
| 04 | isolated-test-databases | P1 | hard | 03（scenario cleanup/日志接口） |
| 05 | core-numeric-boundaries | P1 | medium | 无 |
| 06 | sdk-request-timeout-range | P2 | medium | 无 |
| 07 | kernel-wait-contract | P1 | hard | 02、05、06 |
| 08 | audit-fail-closed | P1 | medium | 无 |
| 09 | dashboard-build-deduplication | P2 | medium | 无 |
| 10 | runtime-test-lifecycle-stubs | P2 | medium | 无 |

首批最多 `{01,02,03,05,06}`；有槽位就按编号补可运行项（04 需 03 已合入）。07 需三个前置合入。todos README 是并行任务共同修改的唯一允许重叠点，rebase 时逐行保留已合入状态。实现分支禁止修改其他 todo 的状态。所有难度均使用相同 `gpt-6-astra / xhigh`。

## 校验

每个任务先运行自己的针对性测试，再由协调器在 rebase 后的 worktree 独立执行：

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run build
bun run test -- --force
git diff --check
```

只在新 worktree 缺依赖或 lock 有变化时 install；不要与同一 worktree 的其他构建同时运行上述命令。根标准测试不能静默改成仅一个包，也不能把之前 cache hit 当作新修复的测试证据。无 PG 的标准测试会跳过 PG suites，必须明确记录。

04、05、07 额外在独占临时 PostgreSQL 上跑 kernel PG；04 跑全 acceptance，07 跑 embedded/notify 与相关 kernel wait suites。08 跑 `check:audit -- --self-test` 和真实 `check:audit`，非法输入 fixtures 必须失败。09 跑 artifact graph、双 SHA rollover、clean pack/exports 并检查 build 次数。最终集成至少跑一次全部 acceptance 和所有 `check:*`（exports/pkg-meta 前先完成 build）；保留原始失败，不扩大测试到不相关改动。

临时 PostgreSQL 使用本机已有 `postgres:16-alpine`，随机分配 loopback port，唯一容器名，记录 id，退出后只删除本次容器。不得使用用户现有数据库做 destructive reset。不要在计划、提示或日志中复制真实 DATABASE_URL 凭据。

## 风险与假设

- 这是新的探索计划，不修改两份旧计划的归档状态。没有新增功能需求，默认修复证据明确的工程问题。
- timer 的 int32 限制属于单次 setTimeout；durable wait 持久化日期、SDK `waitForResult(Infinity)` 不能因此一并被限制为 24.8 天。
- timeout=0 在 kernel/registry 可保留一次即时状态读取语义；SDK waitForResult 已拒绝 0，不偷偷破坏已公开差异。Infinity 是否允许必须按路径原契约保留，NaN/错误类型必须拒绝。
- 取消等待不等于取消 run；只释放等待方资源。driver 不提供真正 query cancel 的路径，要处理迟到结果并有连接/statement 超时，不能声称已取消服务端 SQL。
- TestDatabase 命名策略变化会影响调试时寻找固定库名，应在测试工具文档打印实际脱敏库身份。明确保留时不得误标清理已完成。
- 当前 auto-dev 仅写并提交本目录，随后启动新 Herdr Codex 协调器；业务实现留给该执行 session，不在当前 session 等待执行完成。

## 最终基线与资源记录

- kernel（含真实 PostgreSQL）：58 test files、388 tests 全部通过，30.1s。
- `bun run test:acceptance`：19/19 harnesses 通过，161.8s。
- 本轮临时容器 `40bcb07394bc2606fd4e7d6ff55dd0f1e07ffc395ff6a90c69efce1ddc786787` 已成功删除，没有保留测试数据库服务。
- 探索日志保存在本机 `/tmp/better-trigger-auto-dev-*.log`，不作为源码提交；上面已写明可重现命令和必要错误原文。
