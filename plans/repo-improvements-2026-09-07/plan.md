# Repo improvements · 2026-09-07

## 意图与探索结论

用户调用 `$auto-dev`，没有附加开发需求。本轮进入仓库探索模式：基于当前代码、仓库校验和受控探针，修复已经确认的正确性、资源生命周期和 CI 问题。原分支为 `main`，探索起点为 `b02c04f`；日期按 America/Los_Angeles 记录，工具日志的 UTC 日期为 2026-09-08。

仓库采用 Bun workspace + Turbo，包含零运行时依赖的 core、HTTP SDK、PostgreSQL kernel/db、daemon/embedded worker、React Dashboard、VitePress 文档和验收工具。已阅读 `agent.md`、README、架构定案、构建配置和此前三轮 repo-improvements / ui-improvements 计划；没有发现适用的 AGENTS.md / CLAUDE.md。此前完成的修复不重新入队。

总体基线通过，但测试没有覆盖本轮发现的若干边界：无请求体的浏览器控制请求、合法 JSON 值的转换、重放指纹递归、带斜杠的命名空间、探针超时后的连接、Dashboard 旧请求结果。保留一次真实发生的复制反馈测试失败，不因后续复核通过而删除证据。计划拆为 9 个实现任务；架构和公开契约的后续设计单独列为 roadmap。

## 目标 / 非目标

- 目标：堵住控制路由的来源校验缺口，保留 JSON 数据语义与重放一致性，修正命名空间混淆，约束计时器与连接生命周期，消除 Dashboard 请求跨查询/凭据/组件生命周期提交，以及隔离文档 PR 和部署的并发组。
- 约束：保持 daemon / SDK 分层、core 零运行时依赖、PostgreSQL 唯一生产存储、已有 API 路径和状态机、数据库时钟与锁序。业务实现只由新 Herdr session 执行。
- 非目标：本轮不升级工具链大版本，不部署、不发布包、不 push；不新增鉴权体系、事件原语、fan-in、取消级联；不重构整个状态机，不重写旧计划状态。
- 不因加入来源检查而要求已有 SDK/embedded/curl 客户端发送 Origin；同源 Dashboard（包括代理后的公开 HTTPS 地址）必须继续工作。不得以禁用合法斜杠命名空间来掩盖键碰撞。

## 校验基线与探索方法

所有命令从仓库根运行，包级命令明确写 `--cwd`。遵守 `agent.md`：入口使用 Bun；仓库脚本内部明确执行的 Node 消费者兼容检查保留其含义。

| 命令 / 检查 | 本轮结果 |
| --- | --- |
| `bun run lint` | 通过，9/9 Turbo tasks，7.5s |
| `bun run typecheck` | 通过，14/14 tasks，1.8s；其中 5 项命中缓存 |
| `bun run build` | 通过，7/7 tasks，0.7s；其中 6 项命中缓存，worker 重新构建并验证打包内容 |
| `bun run test -- --force`，移除 DATABASE_URL | 通过，1,494 tests；100 项 PG tests 跳过，24.9s，测试相关任务无缓存 |
| 同一根命令，临时 PostgreSQL 16 | 首次失败，13.4s：web 的复制反馈断言失败，Turbo 随后中止未完成任务；不能当成完整 PG 结果 |
| 同一根命令，临时 PostgreSQL 16，失败后复核 | 通过，156 test files、1,594 tests，42.0s；kernel 59 files / 435 tests；无 PG skip |
| `bun run test:acceptance`，临时 PostgreSQL 16 | 19/19 harnesses 通过，162.6s |
| `bun run check:audit` | 官方 npm advisory endpoint，0 finding / 0 exception |
| `bun run check:audit -- --self-test` | 通过，234 拒绝 fixtures、49 range cases、14 dotenv scenarios |
| `bun run check:deps` / `bun run check:drift` | 均通过 |
| `bun run check:exports` | 通过，artifact guard、publint、attw 全部通过 |
| `bun run check:pkg-meta` | 40/40 通过；实际消费者进程为 Node 24.20.0，本轮不声称另跑过 Node 18/20/22 |
| `bun run --cwd apps/docs check:mermaid` | 12 blocks 通过 |
| TODO / FIXME / XXX / HACK、常见私钥与 token 形态扫描 | 源码中未发现待办注释或匹配的真实密钥形态；这不是完整安全审计结论 |
| `bun outdated --recursive` | 发现 hono/zod/ESLint/类型包等 patch/minor 更新，以及 TS 7、Vitest 5、tsdown 0.23 等跨现有版本范围的升级；现有 weekly Dependabot 已承担常规更新，不据此宣称存在漏洞 |

构建警告原文：`WARN TypeScript 7.0 does not yet have a stable API and is experimental. Some options will be unavailable.`

首次 PG 根测试失败原文：

```text
FAIL test/runView.test.tsx > Inspector content and copy feedback > puts the error before a collapsed large payload and copies the complete hidden content
AssertionError: expected '' to be 'Copied' // Object.is equality
```

没有 Docker；使用现成 `/usr/lib/postgresql/16/bin/{initdb,pg_ctl}` 创建本轮独占的临时 cluster，使用随机 loopback 端口和合成测试用户名。`resetDb` 为 suite/probe 创建唯一库。校验后 cluster 已停止；不得把本次 URL 或端口作为执行器的固定数据库。日志位于 `/tmp/bt-auto-dev-20260907-*.log`，必要失败原文和结果已写入本计划；执行器必须在自己的环境重新生成证据。

排查覆盖正确性、健壮性、安全、性能、测试、工程/DX 和代码质量；采用只读源码追踪、伪 kernel/HTTP 请求、受控 React hooks 探针和独立 PostgreSQL 数据库，没有修改业务文件。

## 完整发现与拆解

以下 F 项全部进入队列；同文件或紧密耦合项合并。P0 问题未发现。

| ID | 优先级 | 难度 | 位置、证据与影响 | 改进方向 / 任务 |
| --- | --- | --- | --- | --- |
| F1 | P1 | medium | `apps/worker/src/routes/runs.ts` 的 cancel/retry 无 body，不经过 `safeJson` 的 JSON Content-Type 校验；`middleware.ts#corsMiddleware` 只决定 CORS 响应头。对伪 kernel 发 Origin=https://untrusted.example、无 body 的 POST，两路均 200，cancel/retry 各实际调用一次，ACAO 为 null。 | 对不安全方法在副作用前检查浏览器来源，保留同源、显式 allowlist 和无 Origin 客户端；01。攻击还需要已知 run id，不能把受控探针描述成发生过真实攻击。 |
| F2 | P1 | medium | `packages/core/src/serialize.ts#canonicalizePlain` 用普通对象逐键赋值。`JSON.parse` 得到的自有 `__proto__` 被当成 setter：输入含该字段和 a=2，成功结果只有 a=2。 | 保留所有 enumerable own string keys，避免触发原型 setter；02。这里证实的是静默丢字段，不是全局原型污染。 |
| F3 | P2 | medium | 同文件声明匹配 JSON.stringify，但 `new Number(7)` 变成 `{}`，`new String('ok')` 变成数字键对象；嵌套 toJSON(key) 收不到属性名，输出发生变化。 | 统一 JSON 值语义、boxed primitives、toJSON 的 key 与每值一次调用，仍递归稳定排序；02。 |
| F4 | P1 | medium | `packages/core/src/errors.ts#serializeError` 的 Error 属性读取和 String(err)，以及 `serialize.ts` catch 内的诊断转换可能再次抛错。无原型 thrown value、抛错 message getter、toJSON 抛无原型值的受控探针均抛出，违反 total/non-throwing 注释。 | 诊断路径独立防护，保证 message 是 string、safeSerializeJson 返回稳定失败；02。 |
| F5 | P1 | hard | `packages/kernel/src/fingerprint.ts` 复制了另一套 canonicalizer，toJSON 返回自身时持续递归。给 toJSON 加 20 次保护仍调用 20 次；未设保护的 Bun 探针持续占 CPU，已终止本轮进程。core 对同形状已有成功测试。 | 与 core 的 JSON 语义统一，消除自返回递归；03，依赖 02。不运行无界复现。 |
| F6 | P1 | hard | 同文件对自有 `__proto__` 也丢字段；含该输入和不含该输入计算出相同 fingerprint `64efbe79330ce334`。 | 普通 JSON 旧 fingerprint 字节兼容；修正误表示输入，补 payload/ledger 回放验证；03。 |
| F7 | P1 | hard | `packages/kernel/src/orchestrator.ts` 约 960 行按 project_id/env 的斜杠拼接分组。`{projectId:'a/b',env:'c'}` 与 `{projectId:'a',env:'b/c'}` 混组。真实 PG 中只有前一组在线 worker，两组却各创建一个 cron run，skippedUnserved=0。 | 用无歧义二元组键，servedTaskIds 严格按原 namespace 查询；04。 |
| F8 | P1 | medium | `apps/worker/src/routes/metrics.ts#queryGauges` 同样拼接斜杠；两组 available=3、7 的探针只输出后一组的 7，前组全部 series 消失。 | 指标 namespace map 保留两组和各自的零值序列；与 F7 合并为 04。CLI 解析第一条斜杠，不能据此声称 CLI 能生成上述两个不同 pair。 |
| F9 | P1 | hard | `routes/dashboard.ts#probeDb` 在 HTTP deadline 后若 connect 才完成，仍执行 SELECT 1；受控探针已返回 503 后 queries=1、releases=0，悬挂 query 将持有连接。 | 明确请求结束状态，迟到 checkout 立即释放且不发查询；05。 |
| F10 | P1 | hard | 同函数把尚未结束的 query client 用无参 release() 归还；受控超时探针得到 releases=['no-argument']。注释和 health 测试误认为 pg 自动销毁该连接；pg 的 API 要求 truthy destroy。metrics 的 Promise.race/single-flight 也只跟随 HTTP deadline，底层操作可能继续。 | 超时淘汰在途连接、迟到结果只清理、single-flight 跟随实际资源生命周期；检查 health/metrics 两条路径；05，依赖 04（metrics 同文件）。 |
| F11 | P1 | hard | `cli.ts` 接受 `--timer-interval-ms 2147483648`；`orchestrator.ts#loop` 直接 setInterval；runtime heartbeat 从无上限 leaseMs 推导。合法解析值可被运行时缩为 1ms，形成高频循环。 | 在 CLI 和直接 runtime/orchestrator/embedded 入口校验实际 timer 范围及衍生 interval；06。 |
| F12 | P1 | medium | `pool-config.ts#derivePoolConfig` 接受 connect/statement timeout=2147483648；`packages/db/src/pool.ts#createPool` 原样交给 pg。连接 timer 可能溢出、PG statement_timeout 可能超出其配置范围。 | 校验 safe integer 和各底层范围，合法的 0=关闭保持；直接 pool options 不能绕过；并入 06，依赖 04（orchestrator 同文件）。 |
| F13 | P1 | hard | `apps/web/src/api/hooks.ts#useRuns` / `useRun` 的分页 generation 只跟 env/filters/run id；不跟 API key version，分页也未传 AbortSignal。受控 hooks：切 key 后旧页 aborted=false，完成后旧 key 的 tail 出现在新查询列表。 | 查询、凭据与组件生命周期统一失效，旧 head/tail/logs 不跨身份提交；07。 |
| F14 | P1 | hard | `useRun` 在 fetcher 中先 setTerminal(true)，发生在 usePoll 的 mounted guard 前。old→new run 后旧请求迟到返回 terminal 的探针显示新请求被 abort，loading=true、data=null。 | terminal 必须派生自已被当前 generation 接受的响应，不能由已退役 fetcher 更新；07。 |
| F15 | P2 | medium | 分页的 loadingMore/loadingOlderLogs 只用 React state，当前渲染闭包在同一轮可进入两次；清理没有 abort/controller ownership，filter/env 切换只丢弃最终数据。源码追踪，尚未把同 tick 双调用描述成真实用户双击事故。 | 同步 single-flight 锁、明确清理与 generation guard；同模块合入 07，补同 tick 调用和卸载测试。 |
| F16 | P1 | medium | `RunView.tsx#RunHeader.runAction` 调用 cancel/retry 不传已有 signal 参数，也不 guard onRetried/recordConnectionError。组件卸载或切 env 后，迟到 retry 成功仍可调用 App 导航，迟到 401 仍可污染当前连接状态。 | 绑定 run/env/key 与挂载生命周期，取消传输并丢弃迟到 UI 副作用；08，依赖 07。取消等待不表示撤销服务器已执行的操作。 |
| F17 | P2 | medium | `apps/web/test/runView.test.tsx:103-118` 的复制反馈在首次 PG 根测试中失败，原样复核通过；具体根因未确认，不能认定仅是机器慢。 | 在 07 的终态生命周期修复后调查卸载/重渲染/异步复制的时序；用确定性测试捕获并修正原因，保留一次失败及复核证据，不直接加大 timeout 或删断言；并入 08。 |
| F18 | P2 | easy | `.github/workflows/docs.yml` 对所有 PR、main push、手动触发使用同一个 pages concurrency group，并 cancel-in-progress=true；不同 PR 或 PR 与 main 的构建/发布可相互取消。 | 按事件与 ref 隔离 PR/build，main 部署保持串行，权限放到需要的 job；09。结论来自配置与 GitHub 并发语义，不是声称查询过实际 Actions 运行。 |

### Roadmap 与已记录的边界（不进本轮队列）

| ID | 优先级 | 难度 | 位置 / 发现 | 后续方向及暂不执行原因 |
| --- | --- | --- | --- | --- |
| R1 | P2 / roadmap | hard | `sdk/src/instance.ts#waitForResult` 每跳 timeout=slice+10000，terminal 检查先于 deadline。timeout=5ms 的合成 fetch 82ms 后返回 completed，即使 throwOnTimeout=true。已有测试明确保留预算耗尽后的最后一次 timeoutMs=0 读取。 | 独立决定 wall-clock 硬期限与传输宽限/最终读取契约，再统一 SDK、kernel 和文档；本轮不偷偷打破现有测试指定的最终读取语义。 |
| R2 | P2 / roadmap | hard | `RunHeader` / `retryIntentKey.ts` 明确在任何请求 settle 后清 key，包括 timeout/连接断开。服务器可能已生成 retry run，下一次点击会用新 key。 | 设计“结果未知、重发原意图、新建意图”的交互再修改；08 保留当前已公开且测试锁定的 intent 语义，仅修生命周期污染。 |
| R3 | P2 / roadmap | hard | `hooks.ts` 的 live head + 固定 tail cursor 明确接受刷新间产生空隙，运行移出 head 后 tail 状态不会刷新；大量新日志可在两次 newest-page 读取间越过 head，用户须补历史。 | 单独设计连续 live cursor、缺口恢复和已加载运行状态更新；当前分页正确性修复不宣称解决流式连续性。 |
| R4 | P2 / roadmap | hard | `worker/src/stats.ts` 的 lastRunAt 查询按 namespace 对全部历史 GROUP BY/MAX；TTL 可摊薄但不会改变冷查询随历史增长的成本。 | 用现有 `bench:stats` 和真实大表 EXPLAIN 建立证据，再评估 task 索引查最新或汇总结构；本轮未做规模基准，不报告未测加速数字。 |
| R5 | P2 / roadmap | hard | `kernel/src/orchestrator.ts` 1,373 行、`queue.ts` 1,137 行、`worker/src/executor.ts` 1,241 行，状态/锁序/策略集中。持久化边界的完整故障注入矩阵仍未交付。 | 单独做行为保持拆分和系统故障矩阵；本轮只为具体 bug 补回归。 |
| R6 | P2 / roadmap | medium | 根 TS ^6.0.3、workspace TS ^7.0.2 混用，构建有 experimental API 警告；outdated 还报告 Vitest 5 / tsdown 0.23。 | 明确工具链与 Node 消费者支持矩阵后专门升级；patch/minor 已有 weekly Dependabot，本轮 audit=0，不做无目标升级。 |
| R7 | P2 / roadmap | hard | 文档中的事件、fan-in、取消级联、virtual time、agent primitives、plugins 仍为后续产品设计；CLI 用第一条斜杠分隔 namespace，不能无歧义表达 projectId 本身含斜杠的所有合法 pair。 | 产品能力及 CLI 转义/结构化输入各自设计；本轮 04 修内部 pair 身份，不更换 CLI 格式。 |

## 方案与任务顺序

先修独立边界，再串行处理同文件依赖。避免两名 agent 同时修改核心文件或共享测试。每个 todo 对应独立 worktree、一个最终任务 commit；只归档自己的 todo，由协调器串行复核和集成 README 状态。

| 顺序 | todo | 优先级 | 难度 | 依赖 | 主要文件所有权 |
| --- | --- | --- | --- | --- | --- |
| 01 | 01-browser-control-origins.md | P1 | medium | 无 | worker app/middleware、对应来源/HTTP 测试 |
| 02 | 02-core-json-error-boundaries.md | P1 | medium | 无 | core serialize/errors、对应 core 测试，必要导出 |
| 03 | 03-replay-canonicalization.md | P1 | hard | 02 | kernel fingerprint、回放/serialization 测试，必要 core 共享入口 |
| 04 | 04-namespace-pair-isolation.md | P1 | hard | 无 | kernel orchestrator 的 namespace 分组、worker metrics 的 namespace map、对应 PG/metrics 测试 |
| 05 | 05-probe-deadline-lifecycle.md | P1 | hard | 04 | worker dashboard/metrics 的 probe 生命周期、health/metrics 测试 |
| 06 | 06-worker-numeric-limits.md | P1 | hard | 04 | CLI/runtime/embedded/pool-config/env-registry、db pool、kernel orchestrator 的配置边界、相关测试 |
| 07 | 07-dashboard-query-lifecycle.md | P1 | hard | 无 | web api/hooks 及相关 hooks/凭据/分页测试 |
| 08 | 08-run-detail-async-controls.md | P1 | medium | 07 | RunView、runActions/runView 测试；保持重试意图协议 |
| 09 | 09-docs-workflow-concurrency.md | P2 | easy | 无 | docs workflow |

首批可并行：01、02、04、07、09。02 合入后可运行 03；04 合入后可运行 05 与 06（前者不改 pool-config/db pool，后者不改 metrics/dashboard）；07 合入后可运行 08。最多 5 个未集成任务，资源紧张时减少并行数，不改变依赖或降档。文档更新按文件所有权协调，多个任务若都需要同一说明文件，由后续任务在已合入的版本上补充，不能覆盖彼此内容。

## 执行偏好

- `default_agent: codex`，来源为本次 Codex 宿主；用户没有全局或单任务覆盖。旧计划中用户指定的 xhigh 仅是旧计划记录，不套用到本次新队列。
- 每个新 todo 使用 `agent: inherit`。模型/推理按已读取的 agent-routing 规则解析：easy → gpt-6-astra/high，medium → gpt-6-astra/xhigh，hard → gpt-6-astra/max。
- 用户未显式指定 default_model / default_reasoning_effort，不在队列写成固定覆盖。
- 协调器使用 Codex + gpt-6-astra + high；每次启动显式加 `--dangerously-bypass-approvals-and-sandbox`。实现任务按自身难度选择强度，不继承协调器的 high。
- 已通过本机 `codex --help` 核对所需参数，模型 metadata 列出 gpt-6-astra 支持 high/xhigh/max。Herdr 支持 codex，当前环境 HERDR_ENV=1。
- 当前 auto-dev 仅产出并提交本目录；随后在当前仓库右侧同级 pane、no-focus 启动新协调器，发送 `$herdr-finish-plan repo-improvements-2026-09-07`。确认 working 后结束当前编排，不在这里等待实现。

## 验收与集成

每个任务先跑自身针对性测试，再跑以下仓库级 gate；协调器 rebase 后按执行 skill 独立复核。新 worktree 缺依赖时先 `bun install --frozen-lockfile`，不在同一 worktree 并行构建和改 dist。

```sh
bun run lint
bun run typecheck
bun run build
bun run test -- --force
git diff --check
```

最终集成在独占临时 PostgreSQL 上运行根 tests（DATABASE_URL 必须传入 Turbo）、`bun run test:acceptance`、所有 `check:*`、audit self-test 和 docs mermaid。确认没有 PG skip。03/04/05/06 额外运行各自与真实 DB/资源生命周期相关的回归。首次 copy feedback 失败必须保留记录；任务 08 需给出确定性证据或明确剩余复现限制，不能简单用第二次通过覆盖第一次失败。

本机可用 PostgreSQL 16，无 Docker：执行 agent 用 mkdtemp 创建自己的 cluster、随机 loopback 端口，并在 finally/trap 中仅停止和清理自己创建的 cluster。共享根校验会启动多个 suite，但各 suite 用现有唯一库 helper。多个 worktree 禁止写同一 dist 或复用固定数据库名。不要打印真实 DATABASE_URL 凭据。

## 风险、假设与参考

- canonicalization 影响已有指纹：为普通既有 JSON 固定 golden vectors；不能无理由把 fingerprint v1 全量升版导致所有在途 run 漂移。以前被丢字段/改变值的特殊输入需要明确兼容说明，不覆盖既有 ledger；BigInt/circular 保持清晰失败或原有无效输入边界，不能意外变成合法 payload。
- 浏览器来源属于 HTTP 边界，namespace 是请求范围而非身份授权。本轮不把 shared API key 升格为多租户 ACL，也不声称防御所有 DNS rebinding / 浏览器私网访问差异。
- timeout 完成不等于底层 SQL 被取消。销毁连接必须 exactly once，迟到 connect/query 不得重新发工作；保留专用 probe pool、健康失败 503 和 metrics 的 db_up=0 契约。
- timer 上限只约束单次进程 timer 和对应 PG 设置；不把 durable wait、retention 时间窗口、Infinity 等待统一限制成约 24.8 天。
- 探针使用合成数据和伪服务；F7 另有真实 PostgreSQL 证据。F15/F16/F18 是源码/配置路径确认，F17 根因尚待定位；相应测试要求写进 todo，不伪装成已完成修复。
- 来源校验设计参考 [Hono CSRF](https://hono.dev/docs/middleware/builtin/csrf)：需要检查不安全方法，不能只省略 CORS 响应头；采用中间件前核对无 body 请求是否在其实际覆盖范围。
- JSON 值语义参考 [JSON.stringify](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify)；连接归还/销毁参考 [node-postgres Pool](https://node-postgres.com/apis/pool)；计时器边界参考 [Node timers](https://nodejs.org/api/timers.html) 和 [PostgreSQL 16 client defaults](https://www.postgresql.org/docs/16/runtime-config-client.html)。
- workflow 并发语义参考 [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)，实际修改以本仓库触发器与权限为准。
