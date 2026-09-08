difficulty: hard
agent: inherit

# 重放指纹 canonicalization 一致性

对应 F5–F6。优先级 P1。依赖：02-core-json-error-boundaries.md 合入。必须先读 plan 的 fingerprint 兼容风险，不能全量改版本来绕过回归。

## T1 · 统一 canonical JSON 行为

- 要做什么：消除 `packages/kernel/src/fingerprint.ts` 与 core 的重复但不一致实现，复用 02 的语义或建立明确的共同边界；保留 fnSourceHash、StepFingerprintArgs、v1 和普通输入的结果。明确 BigInt 等本来不会合法持久化的值如何失败/保持原边界。
- 预计修改：`packages/kernel/src/fingerprint.ts`，必要的 core 共享导出；`packages/kernel/test/steps-fingerprint.test.ts` 或新增同目录 canonicalization 测试。
- 验收：toJSON self-return 终止且不会重复调用同一值；含自有 `__proto__` 的有效输入与缺少该字段的输入 fingerprint 不同；键顺序变化、普通 JSON 的 pg roundtrip、已有 codeVersion/label/kind 输入 golden vectors 不变。循环和非法输入不会形成无限 CPU 循环。
- 前置依赖：02 的 T1/T2。

## T2 · 验证 durable 调用的持久化与回放

- 要做什么：检查 executor、child trigger 与 ledger writer 对 payload/fingerprint 的使用，加入能穿过真实持久化边界的回归。旧账本必须只读比较，不能修改以迎合新指纹。
- 预计修改：`packages/kernel/test/steps-fingerprint.test.ts`、`packages/kernel/test/serialization.test.ts`、`packages/kernel/test/pg/` 中相关回归；`apps/worker/test/executor-serialization.test.ts`，必要的 `apps/worker/src/executor.ts` 适配。
- 验收：合法特殊键 payload 经保存和 replay 保留语义；自返回 toJSON 不让 task 挂死；普通已有 ledger replay 不漂移，输入真实改变仍触发 NonDeterminismError；常规失败能正常报告。说明以前被误表示的特殊输入会如何被识别，不宣称无条件向后兼容。
- 前置依赖：本文件 T1。

验证：core tests、kernel 指纹/serialization 测试、worker executor serialization 回归、独占 PG 的相关测试；运行现有 `bun run --cwd examples/basic replay-drift` 与 `bun run --cwd examples/basic e2e`，然后完整仓库 gate。需要隔离 PG，按 README 创建并清理。一个最终任务 commit。

## 完成记录

T1/T2 全部验收通过。基于 `93976c6`，在独立分支 `herdr/plan-repo-20260907-03-replay` 完成；Bun 1.4.2，依赖仅由本 worktree 的 frozen install 安装。未分发 agent，未修改 main、其他任务状态、plan.md、roadmap、依赖或 core 公共入口；未执行 rebase/merge/push/PR/stash/worktree 清理。等待协调器集成通知。

实现仅修改 `packages/kernel/src/fingerprint.ts` 和 `apps/worker/src/executor.ts`；回归修改 `packages/kernel/test/steps-fingerprint.test.ts`、`apps/worker/test/executor-serialization.test.ts`，新增 `packages/kernel/test/pg/replay-canonicalization.test.ts`。另外仅归档本文件并更新 README 的 03 行。

### 逐条验收证据

| 验收项 | 结果与证据 |
| --- | --- |
| T1：共用 canonical JSON | kernel 移除重复递归实现，调用 02 已公开的 core `canonicalStringify`。core 的 getter/toJSON(key)/boxed/Date/特殊键语义和普通 JSON 字节全部继承；不需要修改 core serialize/index，与 06 无共享文件冲突。 |
| T1：自返回终止、不重复重入 | 指纹测试断言 root key `""`、对象 key `"left"`、数组 key `"0"` 每位置调用一次；返回对象不再调用其 toJSON。测试 hook 自带有限次数保护，旧实现也会明确失败而不会占满 CPU。worker 单/批量调用均正常结束执行 pass。 |
| T1：特殊键区分、原型不变 | 根及数组内自有 `__proto__`、`constructor`、`prototype` 保留；含自有字段与缺少该字段的指纹不同。断言 canonical 字节等于 core 存储字节、输入未改、原型仍为 `Object.prototype`。 |
| T1：v1、fnSourceHash、StepFingerprintArgs 保持 | v1 envelope、16 位 sha256、fnSourceHash 实现及 StepFingerprintArgs 均未改变。13 组固定旧指纹覆盖全部 7 种 kind、duration/until、null/空/非空 label/codeVersion、opts、整数索引键、嵌套 JSON、Unicode/转义；另外固定 fnSourceHash 和 input nullish normalization。修复前源码独立复核最终 13/13 goldens，见 `19-final-goldens-old-source.log`。 |
| T1：键顺序及普通 JSON pg roundtrip | 原有键顺序测试保留；普通 payload 经过真实 `runs.payload jsonb` 保存、claim 和 handover 后，仍为旧 `d4934a8d1f4e3e61`。run.codeVersion 为 `v1`，worker deploy 身份为 `deploy-new`，没有把进程版本混入旧账本。 |
| T1：循环与非法输入 | BigInt（含 boxed）、真实循环、self-return 后的循环都拒绝；core 对 root 无 JSON 拼写返回 undefined，kernel 的 string 边界显式抛 TypeError。stepFingerprint 的 nullish input 归一化不变。BigInt 不再制造 `__bigint` marker，仍不能成为合法 payload。 |
| T2：单子任务持久化/回放 | 真实 Executor → waitForChildRun → runs/waits → 子任务 ctx.step/complete 或 fail → wakeParentIfWaiting → claim → 父 Executor replay。子 payload 和完成 output 保留特殊键，wait fingerprint 原样传入完成步骤，父任务只创建一个 child；成功及常规 TypeError 失败都能唤醒并正常结束父任务。 |
| T2：批量持久化/回放 | Executor.durableBatchTrigger 与 kernel batchTriggerChild 两个指纹生产者一致；用 DB 读回的特殊键 payload 重建输入，handover 后返回原 runIds，不重复 fan-out。完成账本所有列逐字比较不变。 |
| T2：旧账本只读比较 | 历史 fixture 写入从旧实现取得的常量指纹，建立后用 `row_to_json(s)::text` 比较全部列。普通 replay、幂等重报以及拒绝漂移均不改 output/fingerprint/attempt/timestamps/label。测试不 UPDATE 历史账本，也没有迁移代码。 |
| T2：真实输入变化仍拒绝 | 将普通输入 `a:true` 改为 `a:false` 后，真实 reportStep 拒绝并抛 NonDeterminismError。以前丢失 `__proto__` 的旧常量碰撞也被拒绝；executor replay 按既有契约终态 AbortError，attempt=1，无新 child，账本原样保留。 |
| T2：常规/异常失败报告 | executor 指纹 catch 改用 02 的 `serializeError(err).message`，无原型且带 BigInt 的 thrown value、抛错 message getter 不会让诊断再次抛错。直接 kernel 仍返回 serialization_error；两类 durable 调用的 BigInt/circular/坏 hook 均在真实 PG 持久化终态诊断，无 child、wait、queue 或步骤残留。常规 hook message、普通任务 TypeError 与原 retry policy 均保留。 |

### 兼容边界

没有全量升级 fingerprint v1，也没有重写旧 ledger。普通既有 JSON 的指纹不变；`ctx.triggerAndWait` 现有 `options:{}` 与直接 executor 的 `options:undefined` 保持各自的旧指纹，二者并未合并。

以前被错误表示的输入不承诺无条件兼容：自有 `__proto__`、boxed primitive、依赖 key 的 toJSON 等现在采用 02 的 JSON 语义，重新计算可能与旧指纹不同。测试中的旧特殊键输入在 ctx 路径曾与 `{a:2}` 同为 `b05c5f4d91b30ec8`；修复后识别该变化，保留旧账本并报告漂移，由新 run 执行新的输入。若旧存储已经丢掉字段，单靠旧 payload/指纹不能恢复丢失信息，也不能承诺自动识别丢失前的意图。NULL 指纹的既有 legacy-lenient 行为未改，仍不可做指纹漂移检测。

“每位置一次”指一次 JSON 序列化的原生调用语义，不是跨 durable 操作缓存 hook 的结果。真实单子调用会分别在指纹中的 `payload` 位置、存储根 `""` 位置调用；batch 还会独立计算 kernel ledger 指纹。自返回稳定值在这些边界都终止并保持语义；有副作用或依赖所在 key 的 hook 仍可能在不同序列化上下文返回不同值，不承诺任意用户 hook 的跨调用稳定性。未做性能基准，沿用 02 的额外 JSON parse/中间树分配成本。

### 全部验证命令、结果与日志

完整日志、旧源码、golden probes 和 PG runner 均保留于 `/tmp/bt-03-replay-evidence-Qzea4L/`，各次运行单独命名，不覆盖首次失败。所有 Turbo 命令使用 `TURBO_CACHE_DIR="$PWD/.turbo/task-03-cache"`；命中的缓存也仅来自本 worktree 本次实际构建，未复用其他 worktree 的 node_modules/dist。

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `bun install --frozen-lockfile` | 通过，588 packages，lockfile 未改 | `01-install.log` |
| `bunx --bun turbo run build --filter=@better-trigger/kernel --filter=better-trigger` | 通过，4/4，0 cached；准备 core/db/kernel/SDK 本地依赖产物 | `02-prepare-build.log` |
| `bun /tmp/bt-03-replay-evidence-Qzea4L/goldens.ts`，修复前 | 记录普通旧指纹和特殊键旧碰撞值；完整最终表另由下方 probe 复核 | `03-old-goldens.log` |
| `bun run --cwd packages/kernel test test/steps-fingerprint.test.ts test/serialization.test.ts`，新回归/旧实现 | **失败**，11 failed / 45 passed，56 tests | `04-kernel-before-fix.log` |
| `bun run --cwd apps/worker test test/executor-serialization.test.ts`，新回归/旧实现 | **失败**，5 failed / 8 passed，13 tests | `05-worker-before-fix.log` |
| `bunx --bun turbo run build --filter=@better-trigger/kernel` | 通过，3/3，2 项使用本地准备阶段缓存 | `06-kernel-build.log` |
| `bun run --cwd packages/core test` | 通过，6 files / 115 tests | `07-core.log` |
| `bun run --cwd packages/kernel test test/steps-fingerprint.test.ts test/serialization.test.ts`，修复后 | 通过，2 files / 56 tests；后来补充第 13 组 ctx golden，在 PG 复核和根 gate 中验证 | `08-kernel-after-fix.log` |
| `bun run --cwd apps/worker test test/executor-serialization.test.ts test/executor-fingerprint.test.ts` | 通过，2 files / 30 tests | `09-worker-after-fix.log` |
| `bun run --cwd packages/kernel typecheck` | 通过，含新增 PG 测试及其 executor 源码引用 | `10a-kernel-typecheck.log` |
| `bun run --cwd packages/kernel test test/steps-fingerprint.test.ts test/serialization.test.ts test/pg`，独占 PG 首次 | **失败**，27 files 中 26 passed / 1 failed；163 passed / 3 failed，166 tests，无 PG skip | `10b-pg-regressions.log` |
| `bun -e` 从保存的修复前源码计算 ctx 路径（`options:{}`）goldens | 普通输入 `d4934a8d1f4e3e61`，旧特殊输入 `b05c5f4d91b30ec8` | `10c-old-ctx-goldens.log` |
| `bun run --cwd packages/kernel test test/steps-fingerprint.test.ts test/pg/replay-canonicalization.test.ts`，夹具校正后、新独占 PG | 通过，2 files / 46 tests（35 指纹 + 11 新 PG），无 skip | `11a-pg-canonicalization.log` |
| `bunx --bun turbo run build --filter=@better-trigger/worker` | 通过，6/6；为现有例子准备本地 worker/web 产物 | `12-example-prerequisites-build.log` |
| `bun run --cwd examples/basic replay-drift`，第三个独占 PG | **30/30 checks 通过**，25.2s | `13a-replay-drift.log` |
| `bun run --cwd examples/basic e2e`，同一独占 PG、不同唯一数据库 | **20/20 checks 通过**，11.5s | `13b-e2e.log` |
| `bun run lint` | 通过，9/9 tasks，0 cached，18.418s | `14-lint.log` |
| `bun run typecheck` | 通过，14/14 tasks，5 项本 worktree 依赖构建缓存，3.678s | `15-typecheck.log` |
| `bun run build` | 通过，7/7 tasks，5 项本 worktree 依赖构建缓存，20.541s | `16-build.log` |
| `bun run test -- --force`，独占 PG，DATABASE_URL 传入 Turbo | **158 files / 1,818 tests 全部通过**；13/13 tasks，0 cached，47.707s；kernel 60 files / 475 tests，新增 PG suite 11/11，**无 test skip** | `17-root-test-pg.log` |
| `git diff --check` | 通过；归档后另检查 staged diff 和文件范围 | `18-diff-check.log`、`20-final-audit.log` |
| `bun /tmp/bt-03-replay-evidence-Qzea4L/check-old-goldens.ts` | 最终 13/13 golden 常量与保存的修复前源码一致 | `19-final-goldens-old-source.log` |

根 tests 的包级统计：core 115、db 78、SDK 174、testing 104、web 225、worker 647、kernel 475，总计 1,818；比当前分支起点的 1,776 增加 42 项（25 指纹、6 worker、11 PG）。本 todo 运行了要求的两个 acceptance harness；完整 19 harnesses 留给协调器最终集成，不将历史基线当作本次执行结果。

PG runner：`bun /tmp/bt-03-replay-evidence-Qzea4L/run-pg.ts <recipe>`，三次 recipe 分别为同目录 `local-pg.json`、`fixed-pg.json`、`gates.json`。使用 mkdtemp、随机 loopback 端口、每次独立合成 role 和本 cluster 内 socket；测试用 resetDb 各自创建唯一数据库。通过 `finally` 停止并删除自己的 cluster：

| 本次独占 cluster | loopback port | 结果 |
| --- | --- | --- |
| `/tmp/bt-03-replay-pg-FUGNPj` | 35295 | 首次局部失败后仍正常停止、清理；`10-local-*.log` 保留证据 |
| `/tmp/bt-03-replay-pg-LM8tvX` | 37829 | 校正后的局部回归通过，正常停止、清理；`11-fixed-*.log` |
| `/tmp/bt-03-replay-pg-Ah7XnN` | 43869 | 两个例子及全部根 gate 通过，正常停止、清理；`13-gates-*.log` |

这些端口/cluster 不是可复用配置。`commands.jsonl` 保留实际命令、退出码和耗时；未使用探索 cluster、用户 DB 或 Docker，未打印真实数据库凭据。

### 首次失败、修复和保留的交接

新增回归对旧实现的 11 项 kernel / 5 项 worker 失败在复用 core 和安全诊断后通过。首次 PG 的 3 项失败来自新测试夹具混用两条现有调用路径：直接 `Executor.triggerAndWait` 的默认 options 是 undefined，而 `ctx.triggerAndWait` 适配一直传 `{}`。校正前夹具分别得到 `644380abaa75f8e8` 和 `1b6070fffc63f3ba`，与 ctx 的旧指纹不一致。已从保存的修复前源码独立计算正确 ctx 常量，并显式保留两条路径的普通 goldens；没有为此修改业务行为或在测试运行中重写历史 ledger。校正后的局部回归及完整 PG 根测试均通过，首次失败日志仍保留。

原计划首次复制反馈失败及后续复核通过记录未改：

```text
FAIL test/runView.test.tsx > Inspector content and copy feedback > puts the error before a collapsed large payload and copies the complete hidden content
AssertionError: expected '' to be 'Copied' // Object.is equality
```

原计划后续复核为 1,594 tests / 19 acceptance harnesses 通过。07 的首次根测试 `waiters.test.ts` 计数失败 `expected 3 to be 2`、受控 25ms 间隔揭示 20ms sweep/5ms 等待假设、后续复核通过的交接也保持原样。本任务根 gate 一次通过不能替代这些首次证据，不声称修复了范围外复制反馈或 waiter 时序问题。

构建仍有既有 TypeScript 7 experimental API 警告，未升级工具链。T1/T2 无剩余验收 blocker；特殊输入兼容限制见上文。实现阶段只创建一个最终本地任务 commit，未进行集成操作。

### 最终声明构建修正与复核

第一轮完整 gate 通过并创建本地任务 commit 后，最终 `git status` 检查发现两个未跟踪的生成文件：`apps/worker/src/executor.d.ts`、`apps/worker/src/observability.d.ts`。Bun 的干净检查以 `error: worktree is not clean` 失败。两者的时间戳位于强制 kernel 声明构建期间；原因是新增 PG 测试静态引用了 worker 源码，tsdown 的声明生成把该包外源码也纳入输出。第一次 staged/文件范围审计没有检查 untracked 文件，因此未捕获；这次失败原样保存在 `21-post-commit-failure.log`，未用后续通过覆盖。

PG 测试改为在 describePg 的 beforeAll 中按 URL 运行时加载真实 Executor，使用只包含所测方法的类型接口，保持 kernel 声明构建独立。仍使用同一真实 Executor 和原有 11 项 PG 断言，不使用 mock。只删除了上述两个本任务产生的声明文件；重新构建不再生成它们，未改 tsdown/tsconfig、依赖或额外源码。加强最终审计，明确拒绝任何未跟踪文件。最终 amend 原任务提交，分支基点以上仍只保留一个任务 commit。

同一日志目录追加以下完整复核记录；原始失败与第一轮通过均保留：

| 命令 | 最终结果 | 日志 |
| --- | --- | --- |
| `bunx --bun turbo run build --filter=@better-trigger/kernel` | 3/3 通过，实际重建 kernel；无包外声明输出 | `22-runtime-consumer-build.log` |
| `bun run --cwd packages/kernel typecheck` | 通过 | `22b-kernel-typecheck.log`（保留终端返回结果） |
| `bun run --cwd packages/kernel test test/steps-fingerprint.test.ts test/serialization.test.ts test/pg/replay-canonicalization.test.ts` | 3 files / **68 tests 通过**（35 指纹、22 serialization、11 PG），无 skip | `23a-pg-runtime-consumer.log` |
| `bun run --cwd examples/basic replay-drift` | **30/30 通过**，23.6s | `23b-replay-drift.log` |
| `bun run --cwd examples/basic e2e` | **20/20 通过**，12.6s | `23c-e2e.log` |
| `bun run lint` | 9/9 tasks，6 项本 worktree 缓存，3.123s | `24-lint.log` |
| `bun run typecheck` | 14/14 tasks，10 项本 worktree 缓存，1.36s | `25-typecheck.log` |
| `bun run build` | 7/7 tasks，6 项本 worktree 缓存，655ms | `26-build.log` |
| `bun run test -- --force` | **158 files / 1,818 tests 全部通过**；13/13 tasks，0 cached，37.099s；kernel 475/475、PG 新回归 11/11，无 test skip | `27-root-test-pg.log` |
| `git diff --check`，完整任务 patch/staged diff 检查、README 其他行/原 todo 文本比较、untracked 检查 | 全部通过，未产生额外声明文件 | `28-diff-check.log`、`29-final-audit.log` |
| amend 后 `git status --porcelain`、`git rev-list --count 93976c6..HEAD` | 工作树干净，只有一个任务 commit | `30-post-commit.log` |

最后一轮使用 `bun /tmp/bt-03-replay-evidence-Qzea4L/run-pg.ts /tmp/bt-03-replay-evidence-Qzea4L/final-gates.json`，另建第四个独占 cluster `/tmp/bt-03-replay-pg-C2ZjGO`，随机 loopback port 46657 和全新合成 role。DATABASE_URL 传入 Turbo，`finally` 停止并删除；`23-final-initdb.log`、`23-final-pg-start.log`、`23-final-postgres.log`、`23-final-pg-stop.log` 保留证据。最终审计确认四个 cluster 都已删除。

### 集成阶段 rebase 复核

协调器持有集成锁并显式通知后，在当前任务分支执行 `git rebase main`，从原任务 HEAD `b2c0d74b7f4a9dd0c474bcb883b323cf5ec9efb2` 重放到最新 main `c709d148cdb5855153aa878b298b5e887e4f70dc`。rebase 一次成功，**没有冲突**；README patch 的上下文自动适配 main 已完成的 05 行。逐文件比较确认五个实现/测试文件与 rebase 前完全相同，main 新合入的 05 probe 生命周期、08 异步控件/复制反馈行为和全部其他 README 行均保留。集成阶段只追加本归档和更新 README 的 03 行，amend 唯一任务 commit；未修改 main 或执行 merge/push/切换原 checkout/worktree 清理。

本阶段完整日志另存 `/tmp/bt-03-rebase-q45YMS/`，`base.json` 保留 rebase 前 HEAD、main 和分支，`01-rebase.log` 保留成功结果。运行 `bun /tmp/bt-03-rebase-q45YMS/run-pg.ts /tmp/bt-03-rebase-q45YMS/checks.json`，为此新建独占 PostgreSQL 16 cluster `/tmp/bt-03-replay-pg-Fz1Ys3`、随机 loopback port 41671 和全新合成 role。DATABASE_URL 显式传给全部命令并通过 Turbo `test.env` 进入测试；使用新缓存目录 `$PWD/.turbo/task-03-rebase-cache`，其缓存只来自本 worktree 本阶段构建。

| 命令 | rebase 后结果 | 日志 |
| --- | --- | --- |
| `bun x --bun turbo run build --filter=@better-trigger/worker` | 6/6 tasks 通过，0 cached，3.185s | `02-prepare-build.log` |
| `bun run --cwd packages/core test` | 6 files / **115 tests 通过** | `03-core.log` |
| `bun run --cwd packages/kernel test test/steps-fingerprint.test.ts test/serialization.test.ts test/pg/replay-canonicalization.test.ts` | 3 files / **68 tests 通过**：35 指纹、22 serialization、11 真实 PG，无 skip | `04-kernel-pg.log` |
| `bun run --cwd apps/worker test test/executor-serialization.test.ts test/executor-fingerprint.test.ts` | 2 files / **30 tests 通过** | `05-worker.log` |
| `bun run --cwd examples/basic replay-drift` | **30/30 checks 通过**，22.9s | `06-replay-drift.log` |
| `bun run --cwd examples/basic e2e` | **20/20 checks 通过**，12.4s | `07-e2e.log` |
| `bun run lint` | 9/9 tasks 通过，0 cached，6.09s | `08-lint.log` |
| `bun run typecheck` | 14/14 tasks 通过，5 项本阶段构建缓存，1.761s | `09-typecheck.log` |
| `bun run build` | 7/7 tasks 通过，5 项本阶段构建缓存，15.387s | `10-build.log` |
| `bun run test -- --force` | **158 files / 1,883 tests 全部通过**；13/13 tasks，0 cached，38.823s；新增 PG suite 11/11，**无 test skip** | `11-root-test-pg.log` |
| `git diff --check`，归档后完整 patch/staged diff、文件边界、README 其他行及 untracked 检查 | 全部通过，无包外声明生成文件 | `12-diff-check.log`、`13-final-audit.log` |
| amend 后 `git status --porcelain`、`git rev-list --count main..HEAD`、父提交和 main 比较 | 工作树干净，main 未变，main 之上只有一个任务 commit | `14-post-amend.log` |

根 tests 包级统计：core 115、db 78、SDK 174、testing 104、web 267、worker 670、kernel 475，共 1,883；相对于本次 main 的 1,841 增加本任务的 42 项。原计划基线 1,594/19 保留，未将 19 harnesses 描述为本任务已全部执行。`pg-pg-stop.log` 确认正常停止，runner 的 finally 删除此 cluster；最终审计也确认该路径和前四个 cluster 均不存在。

本阶段 rebase 和项目验证首次全部通过，没有新增实现修复。既有 TypeScript 7 experimental API 警告仍保留。实现阶段的旧实现回归失败、首次 PG 夹具失败和声明输出检查失败，以及历史 copy/waiters 失败与后续通过记录均原样保留；此前特殊输入的兼容边界仍适用。无剩余验收 blocker，等待协调器集成。
