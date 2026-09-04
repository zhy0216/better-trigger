# Plan: repo-improvements（第四轮全仓库探索，2026-09-04）

## 意图与探索结论

本仓库前三轮改进已经把 durable execution 主链路、namespace 隔离、数据库约束、通知/轮询、SDK 类型、dashboard 健壮性和 CI 基线补得较完整；当前主分支没有 P0 级数据正确性问题。本轮不重复前三轮已完成项，重点检查“源码和测试都绿，但交付物仍可能失真”的边界。

结论：仍有明确进步空间，优先级集中在构建可追溯性、依赖供应链、部署最小权限和公开配置/API 契约。最关键的实证是：当前 `HEAD=8203794`，一次显示为成功的缓存构建却让 worker 的实际入口引用了内嵌 `BUILD_SHA=0b11c03` 的 chunk；同时 `dist` 中还残留另一份 `0b11c03-dirty` 的旧 chunk，`npm pack --dry-run` 会把这些未引用文件一并打包。现有健康检查、metrics 和 worker code version 因而不能保证指向当前提交。

### 本轮基线

| 检查 | 结果 | 备注 |
|---|---|---|
| `bun run typecheck` | ✅ | 14 tasks |
| `bun run build` | ✅ | worker 命中 Turbo 缓存，但暴露了旧 SHA 复用问题 |
| `bun run lint` | ✅ | 0 warning |
| `bun run test` | ✅ | worker 48 files / 479 tests；`DATABASE_URL` 已设置，真 PostgreSQL 套件纳入任务哈希 |
| `bun run check:deps` | ✅ | 依赖边界通过 |
| `bun run check:drift` | ✅ | schema / migration 无漂移 |
| `bun run check:exports` | ✅ | publint/attw 通过；publint 另给出 engines/sideEffects 建议 |
| `bun audit` | ⚠️ | 默认 npmmirror advisory endpoint 404，说明当前命令受本机 registry 配置影响 |
| `bun audit --registry https://registry.npmjs.org` | ❌ | 1 high + 3 moderate，均在开发工具链的 Vite/esbuild 依赖链 |
| TODO/FIXME/HACK 扫描 | ✅ | 无待办注释 |
| tracked secret-like literal 扫描 | ✅ | 仅本地/CI 示例数据库口令与测试夹具，没有发现真实密钥形态 |

### 完整发现清单

| ID | 优先级 | 难度 | 证据位置 | 问题与影响 | 建议 |
|---|---|---|---|---|---|
| F1 | P1 | hard | `turbo.json:12-16`、`apps/worker/scripts/write-build-info.mjs`、`apps/worker/src/generated/build-info.ts`、`.github/workflows/{ci,release}.yml` | worker build 读取 `BT_GIT_SHA` / Git HEAD，却没有把该值纳入 Turbo task hash；缓存可把旧 commit 的 `dist` 恢复给新 commit。生成脚本还会改 tracked source。 | 建立单一 provenance 输入：进入 Turbo 前解析 commit/dirty 状态，通过声明在 task `env` 中的变量传入；若无法保证哈希正确，worker build 禁用缓存。构建结束保持工作树干净。 |
| F2 | P1 | medium | `apps/worker/dist/runtime-*`、`apps/worker/package.json#files` | Turbo 恢复输出时没有清掉已有 `dist`；当前目录同时存在多代 hashed chunk，且 `npm pack` 会把未引用旧 chunk 和 sourcemap 一起发布，造成包膨胀与交付物不可复现。 | 在仓库 build/pack 边界显式清理枚举出的 workspace 输出；增加“所有 hashed chunk 都可从入口到达、包内无上一轮 SHA”的 artifact guard。不要依赖某个 bundler 的 `clean` 在 cache hit 时执行。 |
| F3 | P1 | medium | `bun.lock`、`apps/docs/package.json`、`packages/db/package.json`、`.github/workflows/ci.yml` | 官方 registry 审计报告 Vite 5.4.21 / esbuild 0.18.20、0.21.5 所在链路共 1 high + 3 moderate；默认 registry 又让 audit 直接 404，CI 没有安全门禁。问题主要影响暴露到网络的开发服务器，但当前状态会持续漏报新 advisory。 | 用官方 npm registry 建立稳定的 `check:audit`；升级或替换 VitePress/Drizzle Kit 的脆弱传递依赖。上游暂时无兼容版本时，只允许带原因、owner、到期日和受影响面验证的窄例外；至少 gate high severity。 |
| F4 | P1 | easy | `apps/worker/src/rate-limit.ts:120-160`、`README.md:225`、`apps/worker/README.md:205`、`apps/worker/src/env-registry.ts:198-202` | `BETTER_TRIGGER_RATE_LIMIT_BURST=0` 被 parser 接受，但 capacity 0 会拒绝所有启用限流的读写请求；根 README 同时写着这些 knob 的 `0` 表示禁用。一个看似合法的配置会把 API 永久变成 429。 | 按既有公开描述统一为 `BURST=0` 禁用 token bucket；若团队更希望 fail-fast，应改为启动时报错而非运行时封死。同步中英文文档和 env help，覆盖读/写、per-key/global 组合测试。 |
| F5 | P1 | medium | `apps/worker/Dockerfile:89-146`、`oven/bun:1.3-slim` image config | runtime stage 没有 `USER`，镜像 `Config.User` 为空，daemon 默认以 root 运行；基础镜像又使用可变的 `1.3-slim`，而 packageManager/CI 固定为 Bun 1.3.14。 | 使用镜像已有的 `bun` 用户（uid/gid 1000），用 `COPY --chown` 或只读权限保证运行；至少固定 `oven/bun:1.3.14-slim`，需要更强复现性时再 pin digest 并自动更新。 |
| F6 | P2 | easy | `packages/core/src/types.ts:404-414`、`apps/worker/src/routes/runs.ts:73-90`、`apps/worker/src/waiters.ts:122-133`、`docs/backend-contract.md:7-9` | 类型已把 daemon 路径的 `pollMs` 标成 deprecated/inert，但 REST 路由仍解析、clamp、传递它；文档却说它控制共享扫描间隔。调用者以为参数生效，实际 registry 的固定 1s sweep 完全不读该值。 | 保持兼容地接受参数，但 daemon waiter 路径明确忽略并停止伪传递；只有 embedded kernel fallback 继续支持。修正 REST、中英文文档和 SDK 注释，在下一 major 再考虑删字段。 |
| F7 | P2 | easy | `packages/{core,db,kernel}/package.json`、各 `tsdown.config.ts` | 三个发布包没有自己的 `engines.node`；根 package 的 engines 不会随子包发布。所有 bundle target 是 Node 18，消费者却得不到安装期提示。publint 还提示所有包缺少 `sideEffects` 声明。 | 给 core/db/kernel 补 `node >=18` 并用 pack manifest 测试；逐包审计顶层副作用后，仅对真正纯的包/入口设置 `sideEffects: false` 或精确例外，禁止一刀切。 |
| F8 | P2 | medium | `.github/workflows/release.yml:11-34,82-91,257-272` | 发布使用长期 `NPM_TOKEN`，workflow 只有 `contents: write`，没有 npm provenance；发布包虽有正确 repository metadata，但供应链无法证明产物来自哪次 CI。 | 为五个 npm 包配置 trusted publisher，release 使用 Node >=22.14 / npm >=11.5.1 与 `id-token: write`，移除长期 token，并验证自动 provenance。外部 npm 配置完成前可先用 `--provenance` 过渡。 |
| F9 | P2 | easy | `.github/`、仓库根 | 没有 Dependabot/Renovate，也没有 `SECURITY.md`。当前 `bun outdated --recursive` 已有多项 patch/minor 漂移；安全更新只能靠人工偶遇，漏洞报告也没有私下通道/支持版本说明。 | 增加每周依赖更新，patch/minor 分生态合并、major 单独 PR；补最小安全政策、支持版本和报告入口。 |
| F10 | P2 / roadmap | hard | `packages/kernel/src/orchestrator.ts`（1373 行）、`apps/worker/src/executor.ts`（1241 行）、`packages/kernel/src/queue.ts`（1137 行） | 前三轮虽已拆过模块，三个状态机核心仍然过大；锁序、事务边界、recoveries 和调度策略交织，后续改动审查成本高。 | 只做按现有行为的职责切分，先锁住外部 API 和并发不变量；不与 F1-F9 混在同一批交付。 |
| F11 | P2 / roadmap | hard | `packages/testing`、`packages/kernel/test/pg`、`docs/architecture.md:177` | 单元/真 PG 测试很多，但尚无“每个持久化边界注入 throw/断连/重复投递”的系统 fault-injection harness，也没有可量化覆盖基线。 | 先覆盖 terminal commit、claim/lease、wait resume、outbox/notify 四类关键边界；覆盖率只作为识别盲区的趋势指标，不为追数字给生成代码/声明文件设全局硬阈值。 |

## 目标 / 非目标

### 目标

- 让同一源码在任意 commit、CI cache 状态和本地重复构建下，产物中的版本/SHA 都可验证且 pack 内容唯一。
- 关闭已知高危 advisory 的漏报通道，并让后续漏洞在 CI 和自动更新流程中可见。
- 消除一个会把所有 API 静默限流的配置陷阱，校准 `pollMs` 的公开契约。
- 让生产容器默认非 root，发布包明确运行时下限，npm 发布具备来源证明。
- 保持当前 durable execution 行为、数据库 schema 和公开 SDK 的兼容性。

### 非目标

- 本轮不实现 events / `wait.forEvent`、fan-out/fan-in、agent、plugin 等新产品能力。
- 不做无目的 major dependency 全量升级，也不为了 coverage 数字重写已有测试。
- 不在 F1-F9 中顺手重构 orchestrator/queue/executor；状态机拆分单独进入 roadmap。
- 不在计划阶段创建 todo、修改业务代码、发布包或改 npm 外部账户配置。

## 方案与模块影响面

### A. 可复现构建与发布物（F1 → F2）

影响：`package.json`、`turbo.json`、`apps/worker/scripts/write-build-info.mjs`、worker build/test、CI/release、pack 检查脚本。

1. 先定义 provenance 规范：CI 使用完整 `${{ github.sha }}`，本地使用 `git rev-parse --short HEAD` 加可验证的 dirty 标记；不可解析时显式为 version-only，禁止复用上次生成值。
2. 在调用 Turbo 之前解析该值，并将真正影响 bundle 的变量声明进 worker build hash。若 Turbo 无法可靠表达本地 dirty 状态，宁可对该 task `cache: false`。
3. 让生成步骤在成功/失败后都不遗留 tracked source 改动；由测试读取最终入口实际 import 的 chunk，而不是只测 source 常量。
4. build/pack 前清理明确列举的 `dist`，再加入 artifact graph/allowlist 检查，阻止 orphan chunk、旧 sourcemap 和旧 SHA 进入 tgz。

### B. 依赖与供应链闭环（F3 → F8 → F9）

影响：`bun.lock`、docs/db toolchain、根 scripts、CI/release workflow、依赖机器人配置、`SECURITY.md`。

1. 先建立固定官方 registry 的可重复审计命令，CI 对 high 直接失败；把现有四条 advisory 按“实际解析到的 vulnerable version + 调用场景”记录，而不是把同组安全版本误报为问题。
2. 优先让 docs 的 Vite 5 链升级到已修复线；对 Drizzle Kit 旧 esbuild 链评估升级/替换/窄 override，必须跑 migration generate/drift 和 docs build/dev smoke。
3. 加周更机器人，让安全 patch 不再依赖人工检查；major 单独评估，避免 Vitest/tsdown 等一次性破坏工具链。
4. 发布链迁移到 npm OIDC trusted publishing。该项需要 npm 账户侧为五个包各配置 workflow 信任，是唯一外部前置；切换成功后删除 `NPM_TOKEN`。

### C. 运行时配置与 API 契约（F4、F6，可并行）

影响：worker rate-limit/config/route、core types、SDK query、英文与中文文档。

- F4 采用“0 disables”既有语义，保证 burst 为 0 时不创建/消费任何桶；其他 rate 为 0 的行为保持不变。
- F6 采用兼容 deprecation：REST 暂不拒绝旧 query，但 daemon 文档明确 inert；embedded fallback 的 kernel polling 仍保留该选项。

### D. 容器与包元数据（F5、F7，可并行）

影响：worker Dockerfile、Docker CI smoke、五个发布 package manifests、export/pack guard。

- runtime 切换至 `bun` 用户，并验证 healthcheck、migration、动态 `--tasks` 读取和 SIGTERM 退出；不要只验证镜像能 build。
- Bun 镜像 tag 与仓库 pin 对齐；digest pin 作为可选强化，需兼顾多架构。
- engines 从根同步到每个发布包；sideEffects 必须经入口审计后再声明。

## 任务拆解与依赖

| 顺序 | 工作包 | 覆盖 | 优先级 | 难度 | 依赖 |
|---|---|---|---|---|---|
| 1 | provenance hash + clean artifact guard | F1、F2 | P1 | hard | 无 |
| 2 | audit remediation + deterministic CI gate | F3 | P1 | medium | 无 |
| 3 | rate-limit zero-value contract | F4 | P1 | easy | 无 |
| 4 | non-root, pinned runtime image | F5 | P1 | medium | 无 |
| 5 | wait result query contract cleanup | F6 | P2 | easy | 无 |
| 6 | published package metadata | F7 | P2 | easy | 1（复用 pack guard） |
| 7 | npm trusted publishing + provenance | F8 | P2 | medium | 1、2；另需 npm 账户配置 |
| 8 | dependency automation + security policy | F9 | P2 | easy | 2 |

推荐先并行完成 `{1} {2} {3} {4} {5}`，再做 `{6} {7} {8}`。F10/F11 不进入本轮执行队列。

## 校验方案

### 仓库基线

```sh
bun run typecheck
bun run lint
bun run build
bun run test
bun run check:deps
bun run check:drift
bun run check:exports
```

### 新增针对性验收

- **Provenance/cache**：在源码不变且保留 `.turbo/cache` 的情况下，分别用两个不同 `BT_GIT_SHA` 连续 build；第二次实际入口、`/health`、metrics 和 pack 内只能出现第二个值。clean tree 构建后 `git status --short` 为空。
- **Artifact hygiene**：连续执行 build、改版本/commit、再 build；对 `npm pack --dry-run --json` 做文件图检查，所有 hashed chunk 必须被入口引用，不得包含上一轮 chunk/map。
- **Audit**：`bun audit --registry https://registry.npmjs.org` 在 CI 可运行；无 high，任何暂留 moderate 都有精确依赖链、利用条件、owner 和到期日。
- **Rate limit**：`BURST=0` 下读写请求均通过；`BURST=1` 仍会在第二个请求触发 429；per-key/global 和动态 env 更新保持原行为。
- **pollMs**：daemon waiter 注册不因 query 中的 `pollMs` 改变 sweep；embedded kernel fallback 仍按选项轮询；中英文 reference 一致。
- **Container**：构建镜像后 `id -u` 非 0；连接 PostgreSQL 完成 migration/health deep probe，加载只读 task 模块并能优雅退出。
- **Packages**：五个 tgz 的 manifest/exports/engines 符合预期；Node 18/20/22 ESM+CJS smoke 继续通过。
- **Release**：在测试包或一次明确版本上验证 OIDC publish 与 npm provenance，确认 workflow 不再读取 `NPM_TOKEN` 后再删除 secret。

## 风险与假设

- **构建缓存风险**：仅把 CI 的 `BT_GIT_SHA` 写入 `turbo.json` 不够；本地 fallback 若仍直接读取 Git，Turbo 看不到输入。实现必须覆盖 CI、本地 clean、dirty tree 三条路径。
- **生成文件风险**：构建脚本修改 tracked `build-info.ts` 会让输入在任务执行期间变化，可能再次污染缓存。方案应消除或在所有退出路径可靠恢复，而不是在 CI 末尾手工 checkout。
- **依赖例外风险**：当前 advisory 位于开发服务器/工具链，不等于生产 daemon 可远程利用；但也不能因此永久忽略。例外必须窄、可到期、可审计。
- **非 root 兼容风险**：用户 task 可能错误依赖 cwd 可写；镜像应把需要写的路径显式挂载/赋权，不应退回整容器 root。
- **trusted publishing 前置**：npm 侧配置属于仓库外操作，无法仅靠 PR 完成；保留 token 过渡时先启用 provenance，避免切换窗口阻断发布。
- **兼容假设**：Node 18 仍是公开最低版本；如计划提升最低版本，必须先改支持策略并做 major release，而不是只改 engines。

## Roadmap（本轮只记录，不执行）

- **P2 correctness**：持久化边界 fault-injection harness、可控虚拟时间、关键不变量覆盖趋势（F11）。
- **P2 maintainability**：按事务/锁/策略职责继续拆分 orchestrator、queue、executor（F10）。
- **P3 interaction primitives**：events / emit / `wait.forEvent`、`batchTriggerAndWait`、cancel 父子级联。
- **P4 operations**：独立 `better-trigger-worker migrate` 子命令与大规模 wait/cron scan 的容量基准。
- **P5/P6 extensibility**：agent 层、plugin interceptors、eslint-plugin。

## 参考

- GitHub Advisory：`GHSA-fx2h-pf6j-xcff`、`GHSA-4w7w-66w2-5vf9`、`GHSA-v6wh-96g9-6wx3`、`GHSA-67mh-4wv8-2f99`
- npm trusted publishing：<https://docs.npmjs.com/trusted-publishers/>
- npm provenance：<https://docs.npmjs.com/generating-provenance-statements/>

## 执行结果（2026-09-04/05 Herdr 并行收尾）

9 个 todo 已全部合入 `main`（`34551d8` → `716b994`），各一个 worktree/agent/commit；`todos/` 下仅剩 `README.md`，9 文件均已归档到 `todos/done/`。

| todo | commit | 说明 |
|---|---|---|
| 04 non-root worker image（P1/medium，opencode flash） | `6185653` | base/runtime 对齐 `oven/bun:1.3.14-slim`（后由 Bun1.4 任务升到 `1.4.0-slim`），runtime `USER bun` + 全量 `COPY --chown`，docker 验证 T1/T2 |
| 03 rate-limit zero（P1/easy，flash） | `cc1af25` | `BURST=0` 禁用整套 token-bucket，文档统一为 0 disables |
| 02 dependency audit（P1/medium，flash） | `2cc9a76` | `check:audit` 固定官方 registry，vite→^6.4.3 / esbuild→^0.25.12 最小 override，清 1 high+3 moderate；副作用：bun.lock v1→v3 |
| 01 reproducible artifacts（P1/hard，codex yolo + gpt-5.6-sol） | `98dc582` | provenance 改 bundler define、无 tracked 写入、worker build 缓存禁用、artifact guard（33 dist/36 pack） |
| 05 wait poll（P2/easy，flash） | `9510dfc` | daemon 不传 `pollMs`，仅 embedded fallback 使用，文档统一 |
| 09 dep automation（P2/easy，flash） | `641f4cc` | Dependabot 周更 + 根 `SECURITY.md` |
| 08 trusted publishing（P2/medium，flash） | `5718c33` | release 切 OIDC + provenance，不读长期 token；T2 外部发布/secret 删除 deferred 待授权 |
| 06 package metadata（P2/easy，flash） | `73d664a` | 五包 `engines >=18` + 审计 `sideEffects`，新增 `check:pkg-meta` 40 项 |
| Bun 1.4 pin（计划外，用户决策：保持 v3 lockfile，升级 pin） | `147e782` | packageManager/Dockerfile/CI/docs/release/agent.md `1.3.14`→`1.4.0`，消除 `UnknownLockfileVersion` |
| 07 CI gates（P1/hard，codex yolo + gpt-5.6-sol） | `716b994` | ci.yml 接 audit/provenance/metadata/Node18-22 smoke 与非 root runtime smoke；曾被 Bun/lockfile 阻断，pin 升级后全绿归档 |

Blocked/deferred：08-T2（npm trusted publisher 配置、真实 OIDC 发布与 provenance 验证、`NPM_TOKEN` 删除）待维护者对具体测试包/版本明确授权；F10/F11 仍为 roadmap 未执行。残留资源：无（本轮 10 个 workspace/worktree/分支已全部关闭删除）。最终 `git status --short` 为空，未 push、未创建 PR。
