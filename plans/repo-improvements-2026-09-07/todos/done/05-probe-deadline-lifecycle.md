difficulty: hard
agent: inherit

# 数据库探针超时后的资源生命周期

对应 F9–F10。优先级 P1。依赖：04-namespace-pair-isolation.md（metrics 文件）。本任务不修改 db pool/pool-config 的配置解析，避免与 06 冲突。

## T1 · 让健康探针结束状态覆盖迟到 checkout/query

- 要做什么：修复 `probeDb`，使 HTTP deadline 后收到的连接立即被妥善归还且不发 SELECT；已经发出的 query 未结束时，不能无参 release 后供其他请求复用。所有路径 exactly once 清理并处理迟到拒绝。
- 预计修改：`apps/worker/src/routes/dashboard.ts`、`apps/worker/test/health.test.ts`；可抽取 worker 内部 probe helper，范围仅限这两类探针。
- 验收：分别控制 connect/query 的 deferred promise，验证 deadline 先到、成功先到、查询抛错、迟到成功/失败；迟到 connect 查询次数=0，连接归还一次；在途 query 超时使用明确 destroy 语义，不 double release，不出现 unhandled rejection。正常深探针 200，失败/超时 503。
- 前置依赖：04 合入。

## T2 · 同步修正 metrics 和 single-flight 的资源边界

- 要做什么：检查 `gaugesOrNull` / inflightGauges / inflightProbe，使共享探针不会因每次 HTTP race 结束而积累仍未结束的底层操作；必要时共享明确拥有 checkout 的 helper。更新误称无参 release 自动销毁连接的注释和测试。
- 预计修改：`apps/worker/src/routes/metrics.ts`、`apps/worker/test/metrics.test.ts`、`apps/worker/test/health.test.ts`、本文件 T1 的 helper。
- 验收：多批并发请求跨过多个 deadline 时底层工作仍受界限约束；业务 pool 不被探针借用；恢复后可再次成功查询；metrics 在 DB 失败时仍返回 200 + db_up=0 和进程计数。测试断言 release 的参数和所有权，不能只统计一次调用。
- 前置依赖：本文件 T1；沿用 04 namespace 修复。

验证：health/metrics tests、独占 PG 的现有 `bun run --cwd examples/basic health-pool`；必要的真实 pg 故障探针证明 pool 可恢复，再跑完整仓库 gate。不可暂停用户数据库、不可把 HTTP 超时当 SQL 已取消。一个最终 commit。

## 完成记录 · 2026-09-08

在 `herdr/plan-repo-20260907-05-probes` 完成，基点 `93976c6`，已经包含 01/02/04/07/09 的集成。只修改下列五个源码/测试文件、本归档和 README 的 05 行；未改 pool/pool-config、依赖、其他任务状态、plan.md 或 roadmap。此阶段未 rebase/merge、未操作 main 或其他任务分支，未 push/PR，保留一个本地任务 commit，等待协调器集成通知。

- `apps/worker/src/routes/db-probe.ts`：两类探针共用的内部 helper，每个实例拥有一个 checkout/query。HTTP 结果先结束时仍持有 single-flight，直到底层 promise 真正结算；迟到 checkout 直接归还，未完成 query 明确销毁连接。清理前转移所有权，接住迟到拒绝和借出 client 的 error 事件，清除 timer/listener。
- `apps/worker/src/routes/dashboard.ts`：深健康探针使用 helper，保持 SELECT 1、200/503、脱敏错误和业务 pool stats。
- `apps/worker/src/routes/metrics.ts`：通过显式 checkout 执行 gauge SQL，single-flight 与 helper 的资源生命周期一致。保持原 SQL、04 的 JSON namespace 二元组映射、200/db_up=0 及每次 scrape 的进程计数。
- `apps/worker/test/health.test.ts`：两个路由共用 deferred checkout/query 时序矩阵，新增 22 项回归；release 同时断言参数、次数和 this 所属 client，并验证迟到拒绝、error listener 与 timer 清理。
- `apps/worker/test/metrics.test.ts`：stub 使用真实 EventEmitter 形状的借出 client；100 次超时 scrape 断言底层仅一次 query；新增混合 health/metrics storm，验证各一条操作、独立所有权及恢复。原 04 的 namespace 回归保留。

## 逐条验收

- [x] T1 · deadline 前成功：分别释放 deferred connect/query 后所有共享 health 请求为 200，SELECT 1 一次，client.release 的参数记录为 `[[]]`，this 是该 client；不遗留 timer/listener。
- [x] T1 · checkout 失败：同步 throw、异步 reject 均折叠为 health 503/query_failed；无借到的 client，也无 release；并发请求仍共用一次 checkout。
- [x] T1 · 迟到 checkout：HTTP 已 503/timeout 后再 resolve/reject；成功时 query 次数为 0，即使该 query 被设成永久 pending 也不会启动，release 为 `[[]]` 且仅归还该 client 一次；拒绝被观察。四批各 12 个请求跨 8s fake time 仍仅一次 checkout，结算后下一次探针恢复 200。
- [x] T1 · query 失败/超时：同步 throw、异步 reject 使用 `release(true)`；在途 query 超时时参数为 `[[true]]`，四批请求跨多个 deadline 仍只发一次 query。迟到成功或失败均不 double-release；后续新 client 的查询未结束前不会被旧路径释放，完成后以 `[[]]` 正常归还。
- [x] T1 · 错误事件与迟到拒绝：借出 client 发 error 时立即返回 query_failed 并 destroy 一次，single-flight 等该 query 结算后才开放。所有新矩阵用例验证无 unhandledRejection、无遗留 timer/error listener。旧注释中无参 release 自动销毁连接及无需测迟到失败的表述已修正。
- [x] T2 · 两路边界：上述矩阵同样覆盖 metrics；DB 失败/超时均保持 200 + db_up=0、业务 pool timeout 计数 7，并省略未知 queue gauges。业务 pool 的 connect/query 均为 0 次，probe pool.query 也为 0 次，证明 checkout 由 helper 明确拥有。
- [x] T2 · storm 与恢复：100 次挂起 scrape 只有一次 query；混合 health/metrics 的三批并发请求跨 deadline 后总共两个 checkout/两个 query，各自销毁一次，两个底层 promise 结算后使用两个新 client 成功恢复。04 的两种 namespace 顺序、SQL 行换序、空队列与恢复仍通过。
- [x] 真实 PG · 6 个场景通过：health/metrics 各验证等待 checkout、HTTP query deadline、主动终止本任务 backend 后的恢复。真实 max=1 故障 pool 的三批各 12 请求跨 >6s 只有一个 pending checkout；迟到 checkout query=0/release=`[[]]`。在途 query destroy=`[[true]]`，pool total/idle 回到 0，新 backend 查询成功后 idle=1/waiting=0；业务连接仍可 SELECT 1。无 unhandled rejection/idle pool error。
- [x] 现有 health-pool · 4/4 checks 通过：server statement_timeout=1000、四轮 57014 取消后可查询、max=2 下六个并发 pg_sleep、daemon 的十个并发 metrics 共享被锁查询并恢复，随后十个 deep health 全 200。
- [x] 根 gate · lint/typecheck/build/test/diff-check 全通过。157 files / 1,799 tests，较本分支起点 1,776 增加 23；kernel 439、worker 664、web 225、core 115、db 78、sdk 174、testing 104。真实 PG 共 102 tests（kernel test/pg 24 files / 99 tests，retry-policy-validation 的 1 项 PG test，testing/database.pg 的 2 tests），无 skip。

## 验证命令与日志

独立日志目录：`/tmp/bt-05-probes-13mOCh`。每次执行单独命名，失败原文、初版故障脚本及修正版本全部保留。所有项目命令使用 Bun 1.4.2；依赖在本 worktree 安装，构建未复用其他 worktree 的 node_modules/dist。

`L` 为下列局部命令：

```sh
bun run --cwd apps/worker test -- \
  test/health.test.ts test/metrics.test.ts test/metrics-wiring.test.ts \
  test/namespace-routes.test.ts test/namespace-cli.test.ts
```

| 命令 | 结果 / 日志 |
| --- | --- |
| `bun install --frozen-lockfile` | 通过，588 packages；01-install.log |
| `bun run build -- --force --filter=@better-trigger/kernel --filter=better-trigger --filter=@better-trigger/testing` | 4/4 tasks，0 cached；02-build-dependencies.log |
| `bun run --cwd apps/worker test -- test/health.test.ts test/metrics.test.ts`（新增初版回归、旧实现） | 19 failed / 47 passed，保留 destroy 参数、跨 deadline、显式 checkout 等失败；03-probes-red.log |
| 同上（helper 修复后） | 2 files / 66 passed；04-probes-green.log |
| `bun run --cwd apps/worker typecheck` | 首次失败，测试 mock 的 TS2769；05-worker-typecheck.log。修复显式函数类型后由根 typecheck 验证通过 |
| `L`（增加直接迟到 checkout 回归后） | 5 files / 91 passed；06-probes-final-local.log |
| `bun /tmp/bt-05-probes-13mOCh/with-pg.ts 07-real-pg-faults bun /tmp/bt-05-probes-13mOCh/real-pg-probes.ts` | 初版真实 PG 验证失败于 old backend exit 的错误假设；07-real-pg-faults-{runner,test}.log；见下节 |
| `bun /tmp/bt-05-probes-13mOCh/with-pg.ts 08-real-pg-faults bun /tmp/bt-05-probes-13mOCh/real-pg-probes-v2.ts` | 6/6 故障与恢复场景通过；08-real-pg-faults-{runner,test}.log |
| `bun run --cwd examples/basic health-pool`（独占 PG，经 with-pg.ts 包装） | 4/4 checks；09-health-pool-{runner,test}.log |
| `L`（最终混合 storm 回归） | 5 files / 92 passed，health 38、metrics 31；10-probes-final-local.log |
| `git diff --check`（局部后） | 通过；11-pre-gate-diff-check.log |
| `TURBO_FORCE=true bun run lint` | 9/9 tasks，0 cached；12-root-lint.log |
| `TURBO_FORCE=true bun run typecheck` | 14/14 tasks，0 cached；13-root-typecheck.log |
| `TURBO_FORCE=true bun run build` | 7/7 tasks，0 cached；14-root-build.log |
| `bun run test -- --force`（独占 PG，经 with-pg.ts 包装） | 首次通过，13/13 tasks、0 cached、157 files / 1,799 tests、无 skip；15-root-tests-pg-{runner,test}.log |
| `git diff --check`（根 gate 后） | 通过；16-root-diff-check.log；归档及暂存后再次检查 |
| `bun /tmp/bt-05-probes-13mOCh/audit.ts` | 通过：文件边界、README 其他行、plan/04 映射、原 todo 全文、1,799 tests/0 skip、四个 cluster 已清理和首次失败保留；17-final-audit.log |

每次 PG 执行由日志目录中的 `with-pg.ts` 用 mkdtemp 创建自己的 cluster、随机 loopback 端口和合成用户名；DATABASE_URL 只指向该 cluster 并显式传给子进程，Turbo 的 test.env 已包含它。四次 cluster（包括首次失败）均在 finally 中成功 stop 并移除；对应目录后缀 o4C5yL、GhnRfr、hWRjpM、tXxSoK，initdb/start/stop/postgres 日志随各次前缀保留。没有复用探索 cluster 或用户数据库。

## 首次失败、边界与协调器交接

1. 旧实现对在途 query 无参 release，回归得到 `[[]]` 而期望 `[[true]]`；跨 deadline 后重新发起 checkout，甚至返回新操作的 200；metrics 仍使用 pool.query，显式 checkout/所有权断言失败。初版 red 的 19 项还包括改成 checkout fixture 后旧 metrics 无 DB gauge 的过渡失败，不将它们计为 19 个独立缺陷。helper 修复后通过；没有删除验收断言。
2. 局部 typecheck 的首次 TS2769 是 `ReturnType<typeof vi.fn>` 同时容纳构造器和函数，不能作为 process 事件监听器。改为显式函数 mock，完整根 typecheck 通过，首次日志保留。
3. 真实 PG 初版脚本在已证实 client socket 结束、pool 可用新 backend 成功查询之后，额外要求旧 backend 在 5s 内消失，报 `timed out: old backend exit`。该故障 pool 特意设 statement_timeout=0，并在 health 的 driver 边界把 SELECT 1 注入为真实 pg_sleep(30)，用来穿过 HTTP 2s deadline；SQL 可能继续执行，原断言把客户端销毁误当 SQL 取消。v2 明确记录旧 backend 的 `state=active, wait_event=PgSleep`，保持客户端回收、fresh backend、release 参数和 pool counters 的全部断言，再仅对本任务该 backend 执行 pg_terminate_backend 并验证清理。没有放宽产品 deadline 或通过放大测试 timeout 掩盖失败；生产的 1s server timeout 另由未改动的 health-pool harness 验证。**HTTP timeout 和 release(true) 都不是 SQL 已取消的证据。** pg 的销毁接口依据：[Pool releasing clients](https://node-postgres.com/apis/pool#releasing-clients)。
4. worker README 的探针说明和 `packages/db/src/pool.ts` 的部分注释仍把资源安全归因于服务端 statement_timeout，未明确网络故障下的客户端生命周期边界。已向协调器报告；这些文件不在本任务授权边界内，本次未修改，交协调器安排说明同步，尤其避免与 06 冲突。
5. 本任务根 gate 首次全部通过。plan.md 中原复制反馈失败 `AssertionError: expected '' to be 'Copied' // Object.is equality`、后续 1,594 tests 复核通过及 acceptance 19/19 基线完整保留；07 归档中的 waiters 首次失败 `expected 3 to be 2`、受控 25ms 时序复现和后续根复核记录也未改动。本轮 waiters 61 和 runView 5 tests 通过，不据此声称修复或解释 F17 / 原 waiters 调度假设。
6. 保留已有 `WARN TypeScript 7.0 does not yet have a stable API and is experimental. Some options will be unavailable.`，未升级依赖。本任务只运行指定 health-pool acceptance，19/19 是计划基线；最终集成的完整 acceptance/check:* 由协调器执行。无剩余实现/验收 blocker。

## 集成阶段复核 · 2026-09-08

收到协调器持有集成锁的授权后，在当前任务分支执行 `git rebase main`，基点更新为 `27249c76d6d929d38709a0c791e2fa4aa4d49ea2`（新增已合入的 08）。rebase 自动完成，没有冲突。五个探针源码/测试文件与原任务提交 `b529f05fa1a11224ade1776806fc87c86914d902` 逐字一致，无需代码修复；其他 main 文件、08 的实现及归档、README 除 05 行外的全部内容均保留。复核后仅把本节和 README 的 05 行 amend 入现有任务提交，保持 main 之上一个任务 commit。

本轮日志独立保存于 `/tmp/bt-05-probes-integration-Z7ClkY/`，没有覆盖原 `/tmp/bt-05-probes-13mOCh/` 的任何日志、首次失败或故障脚本版本。本轮全部校验首次执行通过，无新增失败。

| 命令 | 集成后结果 / 日志 |
| --- | --- |
| `git rebase main` | 无冲突；01-rebase.log |
| Bun rebase 内容与分支审计 | main 未变、父提交等于 main、仅一个任务提交；五个源码/测试文件与原提交一致，README 其他行和 main 其他文件保持不变；02-rebase-audit.log |
| `bun run build -- --force --filter=@better-trigger/kernel --filter=better-trigger --filter=@better-trigger/testing` | 当前 worktree 重建，4/4 tasks、0 cached；03-build-dependencies.log |
| 上方局部命令 `L` | 5 files / 92 passed；04-worker-local.log |
| `bun run --cwd apps/web test -- test/runActions.test.tsx test/runView.test.tsx test/logStream.test.tsx test/hooks.test.tsx` | 4 files / 95 passed，复核新合入 08 的行为；05-web-local.log |
| `bun /tmp/bt-05-probes-integration-Z7ClkY/with-pg.ts 06-real-pg-faults bun /tmp/bt-05-probes-integration-Z7ClkY/real-pg-probes.ts` | 新建独占 PG，6/6 故障与恢复场景通过；06-real-pg-faults-{runner,test}.log |
| `bun run --cwd examples/basic health-pool`（经本轮 with-pg.ts 包装） | 新建独占 PG，4/4 checks；07-health-pool-{runner,test}.log |
| `TURBO_FORCE=true bun run lint` | 9/9 tasks、0 cached；08-root-lint.log |
| `TURBO_FORCE=true bun run typecheck` | 14/14 tasks、0 cached；09-root-typecheck.log |
| `TURBO_FORCE=true bun run build` | 7/7 tasks、0 cached，worker artifacts 验证通过；10-root-build.log |
| `bun run test -- --force`（经本轮 with-pg.ts 包装） | 新建独占 PG，13/13 tasks、0 cached；157 files / 1,841 passed，无 skip；11-root-tests-pg-{runner,test}.log |
| `git diff --check`、`git diff main..HEAD --check` | 通过；12-diff-check.log；暂存和 amend 后再次检查 |
| `bun /tmp/bt-05-probes-integration-Z7ClkY/audit.ts` | 通过：分支/文件边界、原证据和 README 其他行保留，测试总数/无 skip，三个 PG cluster 清理；13-final-audit.log |

根测试分项：core 115、db 78、sdk 174、testing 104、web 267、worker 664、kernel 439；1,841 比上轮 1,799 增加 42，来自已合入的 08，本任务仍新增 23 项回归。真实 PG 共 102 tests：kernel test/pg 的 24 files / 99 tests、retry-policy-validation 的 1 项 PG test，以及 testing/database.pg 的 2 tests。namespace 二元组、来源校验、JSON 契约及 web 生命周期修复随根测试全部通过。

三次 PG 分别以 mkdtemp 创建 `/tmp/bt-05-probes-pg-6TvpIv`、`/tmp/bt-05-probes-pg-NUggIh`、`/tmp/bt-05-probes-pg-hVur0C`，使用随机 loopback 端口和合成用户，显式传入 DATABASE_URL；Turbo 的 test.env 继续包含该变量。每次均在 finally 中成功 stop 并删除自己的 cluster，initdb/start/postgres/stop 日志保留，审计确认目录均不存在。故障脚本沿用已验证的 v2，不把 HTTP timeout/client 销毁当成 SQL 取消，并清理自己的残留故障会话；没有复用旧 cluster 或用户数据库。

原 05 的首次 red、mock 类型失败和 backend exit 假设失败保留；plan 及 07/08 的原 copy/waiters 首次失败和各次复核记录也未改动。本轮 waiters 61、runView 11 tests 通过，不扩张 08 已记录的历史 F17 归因边界。TypeScript 7 experimental API 警告仍保留。范围外探针说明文字的交接保持不变，未触及 pool/pool-config 或与 06 争用文件；没有新增实现/验收 blocker。未 merge、push、切换原 checkout 或清理 worktree。
