difficulty: hard
agent: inherit

# Worker 计时器与连接配置的数值边界

对应 F11–F12。优先级 P1。依赖：04-namespace-pair-isolation.md（orchestrator 同文件）。不改 metrics/dashboard，不重做 SDK wait/result 契约。

## T1 · 在资源创建前校验实际进程 timer

- 要做什么：覆盖 CLI timer/cron/reaper/gc/stranded interval、直接 `startOrchestrator` 参数、runtime/embedded lease 推导的 heartbeat interval，以及相关直接 timer 输入。检查单次 setInterval/setTimeout 的有效范围，拒绝 NaN/Infinity/unsafe integer/溢出值。
- 预计修改：`apps/worker/src/cli.ts`、`runtime.ts`、`embedded.ts`、必要的 `waiters.ts` / `env-registry.ts`，`packages/kernel/src/orchestrator.ts`；对应 config-validation/runtime-validation/env-registry/kernel orchestrator 测试。保持 04 的 namespace 改动。
- 验收：2147483648 作为单次 interval 在开始任何循环/数据库注册前失败，不被缩为 1ms；有效上界与下界通过。lease 依据其派生 timer 和日期/存储边界设限，不能随意把所有 durable duration 限制为 24.8 天。保留 lease 最小值、有效默认值和禁用循环语义，错误明确命名参数。
- 前置依赖：04 合入。

## T2 · pool timeout/max 的直接调用与 env 保持一致

- 要做什么：校验 derivePoolConfig 和 createPool 选项的 finite/safe integer、连接 timer 范围、PG statement_timeout 范围；0=关闭的既有语义保留。配置在分配 pool/连接前失败，直接传 poolOptions 不能绕开。
- 预计修改：`apps/worker/src/pool-config.ts`、`apps/worker/test/pool-config.test.ts`、`packages/db/src/pool.ts`、`packages/db/test/pool.test.ts`；配置说明和 env-registry 对应规则。必要文档由本任务统一负责 CLI/env 相关内容，避免别的任务同改。
- 验收：错误类型、负值、分数、Infinity、unsafe integer、2147483648 timeout 被稳定拒绝；0 和默认值行为不变；可接受配置确实被 PG 接受。不要给 pool max 发明缺乏依据的任意业务上限。
- 前置依赖：无；与 T1 一起收敛配置边界。

验证：worker config/runtime/pool/env tests、db pool tests、kernel orchestrator tests；使用独占 PG 验证关键连接选项，最后完整仓库 gate 与 `bun run check:exports`。定时器边界优先使用 fake timers/构造函数 spy，不真实运行 1ms 洪泛。一个最终 commit。

## 完成记录 · 2026-09-08

T1/T2 全部完成，基点 `93976c6`（01/02/04/07/09 已集成），当前分支
`herdr/plan-repo-20260907-06-limits`。未分发 agent，未执行 rebase/merge、push、PR、
stash 或 worktree 清理；只创建本地任务 commit，等待协调器集成通知。
没有修改 main、plan.md、其他任务状态、metrics/dashboard 源码、core/SDK 或 roadmap。

### 修改文件

- Worker 实现：`apps/worker/src/{cli,runtime,embedded,waiters,pool-config,env-registry}.ts`；
  新增包内 `apps/worker/src/numeric-config.ts`，供 worker 入口共享 timer/lease 校验。
  不增加 core 公共入口；kernel 直接入口保持自身校验，避免跨包内部路径依赖。
- Worker 测试：`apps/worker/test/{config-validation,runtime-validation,embedded,waiters,pool-config,env-registry}.test.ts`。
- DB：`packages/db/src/pool.ts`、`packages/db/test/pool.test.ts`。
- Kernel：`packages/kernel/src/orchestrator.ts`、`packages/kernel/test/orchestrator.test.ts`。
- CLI/env 数值文档：`.env.example`、`apps/worker/README.md`、
  `apps/docs/reference/cli-and-env.md`、`apps/docs/zh/reference/cli-and-env.md`。
  01 的 CORS 段落逐字保留，未修改根 README。
- 协调器补充授权的 05 说明同步：同一 worker README 的探针/metrics 段落及
  `packages/db/src/pool.ts` 的 createHealthPool 注释，详见下节；不改 pool 行为或 routes。
- 任务记录：本归档及 `todos/README.md` 的 06 行；其他行逐字保留。

### 逐条验收证据

| 验收条目 | 实现与验证证据 |
| --- | --- |
| CLI 五类 interval 在启动前拒绝溢出 | config-validation 覆盖 timer/cron/reaper/gc/stranded 五个 flag：0、负数、分数、NaN、Infinity、2147483648、unsafe integer 均失败且命名 flag；1 和 2147483647 通过。五个真实 Bun CLI 子进程在解析阶段以 code 1 拒绝 2147483648，不出现连接错误或 timer overflow warning。 |
| 直接 orchestrator 参数不能绕过 | 所有显式 interval 在任何 `setInterval` 之前一起校验。fake timers + spy 验证每个参数的非法类型/数值不创建任何 timer、不调用 pool query/connect，防止前面的循环启动后才被后一个参数拒绝。上下界原样交给全部五个 timer。 |
| runtime/embedded 校验顺序 | runtime 在 registerWorker 前检查 lease 及 orchestrator interval；embedded 在 acquireSlot、createPool、migration、createKernel、worker 注册和 timer 之前检查。embedded 的直接 request timeoutMs 同样检查 1..2147483647 整数。测试验证失败后 SDK globals 未安装、下一次合法 embedded 启动仍成功。 |
| lease 的最小值、派生上界和默认值 | 保留最小 1500ms 和默认 60000ms；heartbeat=`max(500, floor(leaseMs / 3))`，故最大 lease 为 3×2147483647+2=6442450943ms，6442450944 拒绝。fake timers 验证 runtime 的 1500/default/2147483648/6442450943 和 embedded 的上下界；claim/heartbeat 接收原 lease，不截断为单个 timer 的上限。 |
| 日期及存储范围 | 独占 PG 通过真实 register→trigger→claim→heartbeat→complete 路径，逐项验证 1500、60000、2147483648、6442450943。`extract(epoch FROM (lease_until - locked_at))*1000` 与 lease 精确相等，读回 Date 有效；将 lease_until 改为过去后 heartbeat 实际续租成功。约 75 天的派生上界比 JS Date 和 PG interval/timestamp 存储上限更紧。 |
| durable duration 与禁用循环语义 | CLI retention/prune 的 `365d` 仍接受；kernel 可用该 retention 配置 GC。未改 result/wait timeout 的 Infinity、0、deadline 分段和最后读取契约；原有 waiter 长等待/Infinity 回归通过。默认 timer/cron/reaper/offline 仍为 1000/1000/10000/30000；GC/stranded 默认关闭，显式布尔关闭不创建 timer。0 interval 不作为关闭开关，关闭循环时显式传入的非法 interval 仍拒绝。 |
| derivePoolConfig 的直接参数与 env | concurrency 必须为正安全整数；`concurrency + 8` 也必须安全，显式 pool max 覆盖仍优先。三种 env 拒绝空/空白、错误类型、负数、分数、NaN、Infinity、unsafe integer；两个 timeout 额外拒绝 2147483648。env-registry 的范围、默认值和 parser 一致。 |
| createPool / embedded poolOptions 不能绕过 | `createPool` 在 Pool 构造前检查全部三个 numeric options。错误类型抛 TypeError，非法数值抛 RangeError，均命名参数。构造器 spy 验证拒绝时分配数为 0。embedded 通过实际 DB factory（不是成功 stub）验证每个 poolOptions 字段失败后无 migration/kernel/worker 注册，且可再次启动。 |
| timeout 的 0、默认值和范围 | connectionTimeoutMillis / statementTimeoutMs 接受整数 0..2147483647；0 仍为无限等待/关闭，undefined 不传给 pg。worker 默认仍 max=concurrency+8、connect=10000、statement=30000；单测检查 0、1、2147483647 原样传入。 |
| pool max 不附加任意业务上限 | max 接受 1..Number.MAX_SAFE_INTEGER；0 拒绝。测试检查 2147483648 与 9007199254740991 可以创建空 pool（totalCount=0，延迟建连），不会按 max 预分配。 |
| 可接受选项确实被 PG 接受 | 独占 PG 分别使用 0/0 timeout、2147483647/2147483647 timeout + MAX_SAFE_INTEGER max、worker 默认连接配置；实际连接并查询 pg_settings，核对 statement_timeout 的实际 setting、min_val=0、max_val=2147483647、unit=ms，全部通过。 |
| 保持依赖任务正确行为 | 04 的 wait/cron SQL、锁序、namespace 二元组分组与三元组告警签名逐字保持；原 cron/namespace 单测与 PG 回归通过。CORS 段落、历史 waiter 计数用例及其断言逐字保持。范围审计日志见下。 |

底层范围已核对安装的 pg 8.23.0 / pg-pool 3.14.0 实现、
[Node timers 文档](https://nodejs.org/api/timers.html#timers_setinterval_callback_delay_args) 和
[PostgreSQL 16 的 statement_timeout 定义](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/utils/misc/guc_tables.c)。
最终以真实 PG 的 pg_settings 及 lease 存储回归补足运行证据。

### 验证命令与日志

全部项目命令使用 Bun 1.4.2。日志目录：`/tmp/bt-06-limits-BmvdTd`。
依赖在本 worktree frozen install；所有构建强制执行，不恢复其他 worktree 的 dist。
根 lint/typecheck/build 设置 `TURBO_FORCE=true` 和本任务独占的
`TURBO_CACHE_DIR=/tmp/bt-06-limits-BmvdTd/turbo-cache`；根 tests 使用 `--force`。

下表 W1/W2/K 的完整命令紧随表格；PG 命令均经独立包装器
`bun /tmp/bt-06-limits-BmvdTd/with-pg.ts <日志前缀> bun ...` 执行。
各轮日志独立保留，不覆盖首次失败。

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `bun install --frozen-lockfile` | 588 packages，通过，lockfile 未改 | 01-install.log |
| `bun run build -- --force --filter=@better-trigger/kernel --filter=better-trigger --filter=@better-trigger/db --filter=@better-trigger/testing` | 本 worktree 构建依赖，4/4、0 cached | 02-build-dependencies.log |
| W1 去掉 env-registry/embedded 两个文件，修复前回归 | 19 failed / 96 passed；有意的 red 证据 | 03-worker-red.log |
| `bun run --cwd packages/kernel test -- test/orchestrator.test.ts`，修复前 | 5 failed / 11 passed，fake timers 捕获拒绝缺口 | 04-kernel-red.log |
| `bun run --cwd packages/db test -- test/pool.test.ts -t 'numeric option boundaries'`，修复前 | 6 failed；另 15 项因名称过滤未执行，该次不作为 PG 验收 | 05-db-red.log |
| 同一依赖构建命令，修改 DB/kernel 后 | 4/4、0 cached，通过 | 06-build-dependencies.log |
| W1，第一轮修复后 | 6 files / 128 passed | 07-worker-targeted-first.log |
| W2，补齐 CLI 子进程、embedded poolOptions 等回归后 | 9 files / 159 passed | 08-worker-targeted.log |
| `bun run --cwd packages/db test -- test/pool.test.ts`，独占 PG | 1 file / 21 passed，无 skip | 09-db-pg-command.log |
| K，独占 PG | 9 files / 67 passed，无 skip | 10-kernel-pg-command.log |
| `bun run lint` | 首次通过，9/9、0 cached，6.660s | 11-root-lint.log |
| `bun run typecheck` | 首次通过，14/14、0 cached，10.319s | 12-root-typecheck.log |
| `bun run build` | 首次通过，7/7、0 cached，17.502s，含中英文文档 | 13-root-build.log |
| W2，补 env-registry 规则并复核 | 9 files / 160 passed | 14-worker-targeted-final.log |
| 同一 DB pool 命令，修正日志捕获后，新独占 PG | 1 file / 21 passed，无 skip | 15-db-pg-final-command.log |
| K，修正日志捕获后，新独占 PG | 9 files / 67 passed，无 skip | 16-kernel-pg-final-command.log |
| `bun run test -- --force`，新独占 PG | 首次完整通过，157 files / 1829 passed，13/13、0 cached，47.831s，无 skip | 17-root-tests-pg-command.log |
| `bun /tmp/bt-06-limits-BmvdTd/audit-scope.ts` | 分支、文件所有权、01/04/07 保留行为检查通过 | 18-scope-audit.log |
| `bun run check:exports` | 通过：worker artifact guard、五包 publint / attw 全部通过 | 19-check-exports.log |
| `git diff --check` | 通过；归档、暂存及提交后另作最终检查 | 20-diff-check.log |
| Bun 日志/cluster 审计 | 五个独占 cluster 均停止并移除；7 包 157 files / 1829 tests，无跳过 | 21-pg-and-test-audit.log |

W1：

```sh
bun run --cwd apps/worker test -- \
  test/config-validation.test.ts test/runtime-validation.test.ts \
  test/pool-config.test.ts test/env-registry.test.ts \
  test/embedded.test.ts test/waiters.test.ts
```

W2 为 W1 后追加 `test/concurrency-env.test.ts test/runtime.test.ts test/runtime-shutdown.test.ts`。
K：

```sh
bun run --cwd packages/kernel test -- \
  test/orchestrator.test.ts test/orchestrator-counters.test.ts \
  test/orchestrator-cron-poison.test.ts test/orchestrator-gc.test.ts \
  test/orchestrator-recovery.test.ts test/orchestrator-waits.test.ts \
  test/cron-unserved.test.ts test/pg/cron-unserved.test.ts test/namespace-isolation.test.ts
```

根测试分项：core 115、db 87、SDK 174、testing 104、web 225、worker 676、kernel 448。
本任务新增 53 项测试，当前基点 1776 → 1829；原计划的 1594 tests / acceptance 19
基线仍保留。本 todo 未另行运行最终集成专属的 19 acceptance harnesses。

### PostgreSQL 生命周期与日志捕获

包装器每次用 mkdtemp 创建新的专属 cluster、OS 分配的随机 loopback 端口和合成测试用户名，
仅监听 127.0.0.1。DATABASE_URL 显式传给 child，Turbo 的 test.env 声明保证传到所有包；
没有使用探索 cluster 或用户数据库。finally 中 pg_ctl fast stop，再删除自身 cluster。
五个 cluster 路径都以 `/tmp/bt-06-limits-pg-` 开头，后缀分别为 `HAcEBd`、`5IzE3R`、
`XztSdi`、`rAwgSR`、`inU4Q0`；init/start/stop/server、*-lifecycle.log 及清理审计均保留。

09/10 首轮 PG 包装器把 stdout/stderr 分别打开为同一 Bun.file，导致少量命令行日志被覆盖；
退出状态和测试通过计数可见，但不视其为完整双流记录。修正为同一个文件描述符并以 wx 创建
日志后，用新 cluster 执行 15/16 复核，完整日志通过；没有覆盖 09/10 的原始文件。
根 17 从一开始就使用修正后的日志捕获。

### 协调器补充 · 05 探针生命周期说明

首次任务提交后，协调器明确授权本任务在已有文件所有权内同步 05 交付后的说明。
只读核对 `/home/ubuntu/.herdr/worktrees/better-trigger/herdr-plan-repo-20260907-05-probes`
中的 `apps/worker/src/routes/db-probe.ts`、health/metrics 调用路径和
`plans/repo-improvements-2026-09-07/todos/done/05-probe-deadline-lifecycle.md`；
没有复制 helper/routes、修改 05 worktree 或提前 rebase/merge。

- worker README 的健康探针/metrics 说明和 createHealthPool 注释保留专用 pool 的
  max=2、1s connectionTimeoutMillis、1s statement_timeout；明确 health 与 metrics
  各自持有一个底层 checkout/query flight。HTTP 2s 超时后，迟到 checkout 不查询而直接归还，
  在途 query 使用 release(true)，底层 promise 结算前新请求共享失败结果。
- 删除“服务端 timeout 必定先于 HTTP deadline 完成并归还连接”的资源保证。
  HTTP timeout 和客户端销毁都不证明服务端 SQL 已取消；网络故障或 statement_timeout=0
  时 SQL 仍可能执行。05 的首次真实 PG 故障记录 `07-real-pg-faults` 和后续
  `08-real-pg-faults` 明确观察了已销毁 client、pool 可恢复但旧 backend 仍为
  `state=active, wait_event=PgSleep`；该证据属于 05，本任务只读引用，未删改其首次失败。
- 按协调器要求修正 kernel orchestrator 测试文件头，区分纯 cron / fake timer 测试与
  使用独占数据库的真实 PG lease suite。此次新增改动仅说明/注释及本归档；01 CORS 段落保持原样。

补充验证全部通过，日志仍在同一个任务目录；原日志与首次失败完整保留。
`Bun.Transpiler` 去除格式/注释后的输出比较确认两个 TS 文件的可执行内容与已通过完整 gate
的首次提交完全一致，因此原 PG/typecheck/build/test/check:exports 结果覆盖最终行为。

| 补充命令 | 结果 | 日志 |
| --- | --- | --- |
| `bun /tmp/bt-06-limits-BmvdTd/audit-coordination.ts` | 只改四个获授权的说明/注释文件，可执行输出未变，仍只有一个任务 commit | 28-coordination-audit.log |
| `TURBO_FORCE=true TURBO_CACHE_DIR=/tmp/bt-06-limits-BmvdTd/turbo-cache bun run lint` | 9/9、0 cached，通过，7.161s | 29-coordination-root-lint.log |
| `bun /tmp/bt-06-limits-BmvdTd/audit-scope.ts` | 所有权、01 CORS、04 namespace、07 原断言及其他 README 行全部保持 | 30-coordination-scope-audit.log |
| `git diff --check` | 通过，amend 前后再复核 | 31-coordination-diff-check.log |

### 失败保留、风险与交接

- 修复前 red：CLI 的 2147483648 未被拒绝、runtime 先走到 registerWorker、kernel/waiter
  创建非法 timer、derivePoolConfig 接受空 env/溢出、createPool 放过错误类型/范围。
  03/04/05 的完整失败保留；随后入口校验修复，对应完整局部验证通过。没有真实运行 1ms 洪泛。
- 根 lint/typecheck/build/tests/check:exports 均首次通过，没有用复跑通过覆盖根失败。
  局部 PG 的第二轮为修复日志捕获问题，原始通过结果和日志保留。
- 原计划首次复制反馈失败完整保留，未声称此任务解释或修复 F17：
  `AssertionError: expected '' to be 'Copied' // Object.is equality`；随后 1594 tests / 19 acceptance
  通过的基线记录未变。07 的首次 waiter 计数失败 `AssertionError: expected 3 to be 2` 及受控
  25ms 间隔探针、后续复核通过记录均仍在 07 归档；其原始断言逐字保留。
- 本次仍有既有构建警告：`WARN TypeScript 7.0 does not yet have a stable API and is experimental. Some options will be unavailable.`
  不升级依赖。早期只读检索曾用到不存在的 node_modules 路径/配置 glob，已用 rg 定位正确文件；
  一次多文件 tail 的旧式参数被拒绝，改用 `tail -n` 完成读取，与项目验证失败无关。
- Numeric helper 仅在 worker 包内部使用；kernel 入口用对应的本地校验，两个入口均有完整矩阵回归。
  显式非法 interval 即使循环关闭也会报错；pool 空 env 不再被 Number('') 当成 0。
  嵌入式 request timeout 也要求整数；SDK 的独立 client/result 契约未修改。
- 本任务无剩余验收 blocker。只在当前分支保留一个本地任务 commit，未进行集成操作。

### 集成阶段 rebase 复核 · 2026-09-08

协调器持有集成锁并明确授权后，在当前任务分支执行 `git rebase main`，将原任务
`1fa953f123a3be5a487e5b25864c8fa032f19130` 重放到最新 main
`b740fdc2ae14a233c89ec6228074880d5c7b03d6`（已包含 03、05、08）。
唯一冲突在 todos README 的 05/06 相邻行：保留 main 中 05 的 done 链接、完整完成状态和
SQL 取消边界说明，保留本任务 06 的 done 链接与完成状态。03、08 和其他已完成行保持 main
原文；`git rebase --continue` 成功。首次冲突退出码 1、冲突原文和后续成功分别保存在
`01-rebase.log`、`01-readme-conflict.md`、`02-rebase-continue.log`。

逐文件审计确认本任务全部源码、测试和产品文档与 rebase 前逐字相同；main 已合入的
canonical/executor、probe helper/routes、web 异步控件、其他任务归档及 README 其他行均完整
保留。05 的说明同步已随原任务提交带入，与现已合入的 helper 一致。无实现修复；本轮只追加
本节和更新 README 的 06 行，amend 唯一任务 commit，不修改 main，不 merge/push、切换原
checkout 或清理 worktree。

本轮完整日志独立保存在 `/tmp/bt-06-integration-3vmmeV`，没有覆盖此前任何日志和首次失败。
`base.json` 保存原 HEAD、main、分支和 Bun 1.4.2；依赖声明及 bun.lock 未变，继续使用本
worktree 的安装。`run-command.ts` 以 wx 创建独立日志，`commands.jsonl` 记录命令、退出码和
耗时，所有 Turbo 命令强制执行并使用该目录下的独占 turbo-cache，无缓存结果替代测试。

| 集成阶段命令 | 结果 | 日志 |
| --- | --- | --- |
| `git rebase main` / `GIT_EDITOR=true git rebase --continue` | 仅 README 冲突，人工按上述规则解决；rebase 成功 | 01-rebase.log、02-rebase-continue.log |
| `bun /tmp/bt-06-integration-3vmmeV/audit-rebase.ts`、`bun /tmp/bt-06-integration-3vmmeV/audit-scope.ts` | main 未变、直接父提交为 main、一个任务 commit；文件边界、原实现、README 其他行与历史证据全部保持 | 03-rebase-audit.log、04-scope-audit.log |
| `bun run build -- --force --filter=@better-trigger/kernel --filter=better-trigger --filter=@better-trigger/db --filter=@better-trigger/testing` | 本 worktree 重建依赖，4/4 tasks、0 cached | 05-build-dependencies.log |
| W3（下方完整命令） | 13 files / 259 passed，覆盖本任务及 03/05 的 worker 交互 | 06-worker-local.log |
| `bun run --cwd packages/db test -- test/pool.test.ts`，新独占 PG | 1 file / 21 passed，无 skip | 07-db-pg-command.log |
| K2（下方完整命令），新独占 PG | 12 files / 135 passed，含 lease/namespace 与 03 的真实 replay 回归，无 skip | 08-kernel-pg-command.log |
| `bun run lint` | 9/9、0 cached，5.709s | 09-root-lint.log |
| `bun run typecheck` | 14/14、0 cached，4.531s | 10-root-typecheck.log |
| `bun run build` | 7/7、0 cached，16.263s，含 docs 与 worker artifacts | 11-root-build.log |
| `bun run test -- --force`，第三个新独占 PG | 首次完整通过：158 files / 1,936 tests，13/13、0 cached，38.162s，无 skip | 12-root-tests-pg-command.log |
| `bun run check:exports` | worker artifact guard、五包 publint / attw 全部通过 | 13-check-exports.log |
| `bun /tmp/bt-06-integration-3vmmeV/audit-validation.ts` | 局部/根统计、无 skip、强制执行、DATABASE_URL 传递及三个 PG cluster 清理全部通过 | 14-validation-audit.log |
| `git diff main..HEAD --check` | 通过；归档及 amend 前后另检查工作区与 staged diff | 15-pre-archive-diff-check.log |

W3：

```sh
bun run --cwd apps/worker test -- \
  test/config-validation.test.ts test/runtime-validation.test.ts \
  test/pool-config.test.ts test/env-registry.test.ts \
  test/embedded.test.ts test/waiters.test.ts test/concurrency-env.test.ts \
  test/runtime.test.ts test/runtime-shutdown.test.ts \
  test/health.test.ts test/metrics.test.ts \
  test/executor-serialization.test.ts test/executor-fingerprint.test.ts
```

K2：

```sh
bun run --cwd packages/kernel test -- \
  test/orchestrator.test.ts test/orchestrator-counters.test.ts \
  test/orchestrator-cron-poison.test.ts test/orchestrator-gc.test.ts \
  test/orchestrator-recovery.test.ts test/orchestrator-waits.test.ts \
  test/cron-unserved.test.ts test/pg/cron-unserved.test.ts \
  test/namespace-isolation.test.ts test/steps-fingerprint.test.ts \
  test/serialization.test.ts test/pg/replay-canonicalization.test.ts
```

上述命令统一通过 `bun /tmp/bt-06-integration-3vmmeV/run-command.ts <tag> bun ...` 记录；
PG 命令进一步包在 `bun /tmp/bt-06-integration-3vmmeV/with-pg.ts <tag> bun ...` 中。
每次 mkdtemp 创建新的专属 PostgreSQL 16 cluster、随机 loopback 端口及合成用户；
DATABASE_URL 显式传到 child 并由既有 Turbo test.env 传入所有测试包。finally 中停止并移除
自己的 cluster，07/08/12 的 runner、init、start、server、stop 日志保留。三个目录分别为
`/tmp/bt-06-integration-pg-CEb4Hw`、`/tmp/bt-06-integration-pg-xeW6WC`、
`/tmp/bt-06-integration-pg-hfF4Kv`，审计确认全部已清理，没有复用旧 cluster 或用户 DB。

根测试分项：core 115、db 87、SDK 174、testing 104、web 267、worker 705、kernel 484，
共 1,936；相对本次 main 的 1,883 仍只增加本任务的 53 项。原计划 1,594 tests / 19 acceptance
基线及复制反馈/waiters 首次失败、各任务首次失败与后续复核记录均原样保留；未将历史 19
harnesses 当作本轮执行结果。除已解决的 README rebase 冲突外，本轮所有项目校验首次通过，
没有新增测试失败或实现修复。既有 TypeScript 7 experimental API 警告和历史 F17/waiters
证据边界保留，无剩余验收 blocker，等待协调器集成。
