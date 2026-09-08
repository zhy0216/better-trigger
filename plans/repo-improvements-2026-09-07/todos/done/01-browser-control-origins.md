difficulty: medium
agent: inherit

# 浏览器控制请求来源校验

对应 plan F1。优先级 P1。前置依赖：无。文件范围为 worker HTTP 边界及对应测试，不改状态机、鉴权凭据存储或 SDK API。

## T1 · 在副作用前拒绝不允许的浏览器来源

- 要做什么：检查 `createApp` 的中间件顺序、`allowedOrigin` 与 cancel/retry；建立统一的不安全方法来源检查，明确覆盖无 body POST。若采用 Hono CSRF，先验证其实际 Content-Type 覆盖范围，不能只套中间件名字或只省略 ACAO。
- 预计修改：`apps/worker/src/app.ts`、`apps/worker/src/middleware.ts`，必要时 `apps/worker/src/routes/runs.ts`；对应 `test/middleware.test.ts`、`test/http.test.ts`、`test/auth.test.ts`。
- 验收：Origin=https://untrusted.example 的无 body cancel/retry 在调用 kernel 前以稳定 4xx 拒绝；Origin=null、表单/simple Content-Type 等同类入口覆盖。允许的同源、loopback、显式配置 origin、显式 wildcard 维持预期；无 Origin 的 SDK/curl/embedded 请求继续可用。检查来源不能消耗 run 操作或绕过已有 auth/rate-limit，审计记录拒绝结果。
- 前置依赖：无。

## T2 · 锁定同源与代理使用场景

- 要做什么：补正反两面的请求回归和边界注释，明确 CORS 响应读取限制与服务器是否执行是两回事。同源远程 HTTPS Dashboard 不能因不是 localhost 而被拦。
- 预计修改：上述测试及 `middleware.ts` 注释；若需外部说明，仅在当前任务拥有的说明位置补充，不并行改其他任务文档。
- 验收：测试断言被拒绝请求的 kernel 调用数为 0，并断言合法请求实际调用一次；OPTIONS、健康检查、API key 错误、JSON body 校验等旧路径通过。使用合成 origin/run id，测试不连接真实部署。
- 前置依赖：本文件 T1。

验证：`bun run --cwd apps/worker test -- test/middleware.test.ts test/http.test.ts test/auth.test.ts test/body-limit.test.ts test/embedded.test.ts`，随后运行 todos/README.md 的完整仓库 gate。只留下一个最终任务 commit，验收齐备才归档本文件。

## 完成记录 · 2026-09-07

状态：T1 / T2 全部验收通过，协调器要求的 CORS/同源/代理文档同步已完成；已按集成阶段授权 rebase 到最新 main 并重新通过局部与根 gate，等待协调器集成。未修改 main，未 merge / push / PR，也未分发 agent。

实现范围：`apps/worker/src/app.ts`、`apps/worker/src/middleware.ts`、`apps/worker/test/{middleware,http,auth}.test.ts`，加本归档与队列表格自己的行。协调器随后明确分配 `README.md` 和 `apps/worker/README.md` 中 CORS/同源/代理相关段落给本任务；仅修改这些段落，保留 CLI/env 数值章节及其他文档内容。没有修改状态机、鉴权凭据存储、SDK API、依赖、plan.md 或其他任务。

### 行为与逐项证据

| 验收条目 | 实现 / 回归证据 |
| --- | --- |
| 不可信来源的无 body cancel/retry 在副作用前稳定拒绝 | `middleware.test.ts` 的两个 `browser origin boundary` 组，对 `https://untrusted.example` 返回 `403 { error: { code: 'origin_not_allowed', message: 'request origin is not allowed' } }`；cancel/retry 调用数均为 0。 |
| 覆盖 Origin=null、空/无效 Origin、simple/form 与 JSON Content-Type | 两个控制路由覆盖上述来源、text/plain、urlencoded、multipart、JSON、octet-stream；`http.test.ts` 同时覆盖 trigger、batch-trigger、PATCH schedule，拒绝时 kernel/SQL 工作均为 0。来源检查不依赖 body 或 Content-Type。 |
| 同源远程 HTTPS Dashboard、loopback、配置项、wildcard | 控制路由正例实际调用一次，覆盖远程 HTTPS 与非默认端口、localhost、127.0.0.0/8、IPv6 loopback、显式 flag/env origin，以及 wildcard 下的远程和 opaque null 来源。scheme/port/suffix 近似值仍被拒绝。 |
| 代理场景有明确边界 | 同源判断使用请求 URL。TLS 代理若将公开 HTTPS URL 改写为内部 HTTP URL，以现有 `--cors-origin` / `BETTER_TRIGGER_CORS_ORIGIN` 显式配置公开 origin；两种配置均有成功回归。伪造 Forwarded、X-Forwarded-*、Sec-Fetch-Site 不会放行请求。 |
| 无 Origin 的 SDK/curl/embedded 保持兼容 | 控制路由无 Origin 正例均调用一次；既有 JSON trigger 与 embedded 套件通过；不会要求客户端新增 Origin。空 Origin 与完全缺失的 Origin 分开处理。 |
| 鉴权、运行预算与 rate-limit 不被绕过 | 顺序为 CORS → audit → auth → origin → rate-limit → body-limit → route。`auth.test.ts` 对两个控制路由验证错误/缺失 key 仍 401，正确 key + 不允许来源为 403；有/无 key、per-key/global 两种预算分别验证拒绝不消耗 token，后续合法请求执行一次，再次无 Origin 请求仍 429，调用数不增长。 |
| 审计记录拒绝且不读取拒绝 body | 控制路由断言恰好一条审计，status=403、result=rejected、reason=origin_not_allowed、requestId 与响应头一致、bodyUsed=false。带有效 key 时记录其 fingerprint，日志不含 key 或测试 body。 |
| 所有不安全方法统一检查，旧 HTTP 路径继续通过 | PUT/DELETE/PATCH 未知 API 路由同样被来源检查拒绝；GET/HEAD health、OPTIONS 在启用 auth 时仍可用。合法来源的 Content-Type / malformed JSON / non-object JSON 继续 400；原 body-limit、auth、embedded 测试全部通过。 |
| 区分 CORS 读取限制与服务器执行 | middleware 边界注释与测试说明已补正；拒绝测试检查实际 kernel/SQL 调用数，成功测试检查实际调用一次，没有只断言 ACAO。测试请求使用合成 origin、run/task/schedule id 与 stub kernel，不连接真实部署。 |
| 对外说明与实际来源策略一致 | 根 README 的 Dashboard / Network posture 段落、worker README 的 dashboard hosting / CORS 段落已同步：远程同源可用、无 Origin 客户端可用、不允许来源在副作用前 403（覆盖 bodyless POST）、TLS 代理改写 URL 时用现有显式 public origin 配置；移除 loopback-only 和无条件无需 CORS 配置的旧描述。 |

已核对安装的 Hono 4.13.3 `dist/middleware/csrf/index.js` 及 [官方 CSRF 文档](https://hono.dev/docs/middleware/builtin/csrf)：其检查受表单 Content-Type 限制，缺失 Content-Type 按 text/plain 处理，JSON 不在检查范围内；默认无 Origin 客户端也不能满足来源检查。因此本次使用独立中间件，在所有不安全方法上执行统一策略并显式保留无 Origin 客户端。

### 验证与日志

全部项目入口使用 Bun 1.4.2。完整原始日志保留于 `/tmp/bt-origins-20260907-HIQG8A/`，不覆盖首次失败。

| 命令 | 结果 / 日志 |
| --- | --- |
| `bun install --frozen-lockfile` | 通过，588 packages；`install.log`。使用本 worktree 的 node_modules，lockfile 未变。 |
| `bunx --bun turbo run build '--filter=@better-trigger/worker^...'` | 4/4 cache hit；`prerequisite-build.log`。该次不作为构建验证证据，随后强制构建本地依赖产物。 |
| `bunx --bun turbo run build '--filter=@better-trigger/worker^...' --force` | 4/4 通过、0 cache，2.056s；`prerequisite-build-force.log`。 |
| `bun run --cwd apps/worker test -- test/middleware.test.ts test/http.test.ts test/auth.test.ts test/body-limit.test.ts test/embedded.test.ts`（先补回归、尚未修实现） | 43 failed / 88 passed，1 file failed / 4 passed；`local-before-fix.log`。捕获 bodyless cancel/retry 的 200→预期403、远程同源 CORS 及拒绝审计缺口；这是有意的修复前回归失败。 |
| 同一局部命令（实现修复并补齐鉴权/HTTP 回归后） | 155/155 tests、5/5 files，3.92s；`local-after-fix.log`。 |
| `bun run lint` | 9/9 tasks，6.771s；`root-lint.log`。 |
| `bun run typecheck` | 14/14 tasks，4.512s；`root-typecheck.log`。 |
| `bun run build` | 7/7 tasks，20.086s；`root-build.log`。 |
| `bun run test -- --force`，独占临时 PostgreSQL 16 | 156 files / 1,684 tests，13/13 tasks，36.871s；kernel 59 files / 435 tests，worker 50 files / 638 tests；无测试 skip。`root-test-pg.log`。 |
| `git diff --check` | 通过；`diff-check.log`。归档后再次检查见 `diff-check-final.log`。 |
| 同一局部测试命令（协调器授权的 README 文档同步后） | 首次通过，155/155 tests、5/5 files，4.15s；`local-after-docs.log`。 |
| `git diff --check`（文档同步后） | 通过；`diff-check-docs.log`。暂存后另跑 `git diff --cached --check`，结果见 `diff-check-docs-staged.log`。 |

文档同步阶段按协调器要求重跑上述局部测试和 diff 检查；没有业务实现变更，前述完整根 gate 及首次失败日志保留。额外使用 Bun 对比修订前后的 worker README `## CLI` 至 `### Code versions and redeploys` 区间，确认 CLI/env 章节逐字未变。

根 gate 全程设置 `TURBO_FORCE=true`，所有任务 0 cache。1,684 = 根测试基线 1,594 + 本次新增 90，测试文件总数仍为 156。通过 `/tmp/bt-origins-20260907-HIQG8A/run-gates.sh` 顺序执行 gate；其 `mktemp -d` 创建独占 PG cluster，Bun 分配随机 loopback 端口，生成合成用户和口令，export DATABASE_URL，经仓库已有 Turbo test env 声明传入。EXIT/INT/TERM trap 仅停止并删除本任务 cluster，已确认清理成功；初始化、启动、停止与 server 日志保留，未使用用户 DB 或探索 cluster。

### 首次失败、限制与协调事项

- 本次修复前 43 个失败完整保留，修复后的局部验证与根 gate 均首次通过。未发现需修改其他任务的失败。
- 保留原计划的历史根测试首次复制反馈失败：`AssertionError: expected '' to be 'Copied' // Object.is equality`，位于 `test/runView.test.tsx > Inspector content and copy feedback > puts the error before a collapsed large payload and copies the complete hidden content`；原计划随后复核通过 1,594 tests / acceptance 19 harnesses 的记录仍原样存在。本次根测试也通过，不据此宣称已修复该历史竞态；其调查属于任务 08。
- 构建仍出现既有警告：`WARN TypeScript 7.0 does not yet have a stable API and is experimental. Some options will be unavailable.`，未升级依赖或处理 roadmap。
- 本 todo 不另跑最终集成的 19 acceptance harnesses、check:* 和 docs mermaid；按 plan/README 由协调器最终集成阶段执行，不能把历史 acceptance 基线当作本分支新证据。
- 协调器授权的两个 README 文档同步已完成；复核修改范围仅含 CORS/同源/代理段落，CLI/env 数值章节保持原样。文档修订合入同一个任务 commit（amend），不新增第二个 commit。
- 无实现或验证 blocker。明确配置的 wildcard 继续允许任何非空来源（包括 opaque null）；此行为是已有显式 opt-in。来源检查不是身份认证，也不新增代理信任配置或 DNS rebinding 防护承诺。

## 集成阶段 rebase 与复核

协调器持有集成锁并明确授权后，在本任务 worktree / 分支执行 `git rebase main`，目标为 `ada4613083f12a90af15130ea78e4b0337f864a3`（已含任务 02 core 修复和任务 09 docs workflow 修复）。未切换或修改原 checkout，未 merge / push 或清理 worktree。

唯一冲突：`plans/repo-improvements-2026-09-07/todos/README.md` 的任务 01 / 02 相邻状态行。手动保留本任务 01 的 done 链接和完成状态，以及 main 中任务 02 的 done 链接和已完成行；任务 09 的已完成行自动保留。`git rebase --continue` 后确认：

- 队列 README 除自己的 01 行外逐字等于 main，其他任务状态和档案未改。
- `packages/core`、`.github/workflows/docs.yml`、任务 02/09 归档与 main 没有差异。
- 本任务 worker 源码、测试、两个对外 README 与 rebase 前 `ecf81d6` 没有差异；`range-diff.log` 只显示任务 02 已完成行导致的 patch 上下文变化。

新日志独立保存在 `/tmp/bt-origins-rebase-tXygdn/`，未覆盖先前日志。依赖仍为本 worktree 的 node_modules/dist；先强制重建依赖产物，再局部测试，随后根 gate。根 gate 全程 `TURBO_FORCE=true`，0 cache。

| 命令 | rebase 后结果 / 日志 |
| --- | --- |
| `bunx --bun turbo run build '--filter=@better-trigger/worker^...' --force` | 4/4 tasks，0 cache，1.901s；`prerequisite-build.log`。 |
| `bun run --cwd apps/worker test -- test/middleware.test.ts test/http.test.ts test/auth.test.ts test/body-limit.test.ts test/embedded.test.ts` | 5 files / 155 tests，3.88s；`local-test.log`。 |
| `bun run lint` | 9/9 tasks，5.676s；`root-lint.log`。 |
| `bun run typecheck` | 14/14 tasks，4.434s；`root-typecheck.log`。 |
| `bun run build` | 7/7 tasks，16.653s；`root-build.log`。 |
| `bun run test -- --force`，新建独占临时 PostgreSQL 16 | 156 files / **1,724 tests**，13/13 tasks，35.874s，无测试 skip；`root-test-pg.log`。 |
| `git diff --check`、`git diff --check main..HEAD` | 通过；`diff-check.log`、`task-patch-check.log`；归档和状态行更新后另检查 working/staged diff，见 `final-diff-check.log`。 |

测试统计：core 115、db 78、SDK 174、web 180、testing 104、worker 638、kernel 435；1,724 = 原基线 1,594 + 已合入任务 02 的 40 + 本任务的 90。根 tests 使用新 `mktemp -d` cluster、随机 loopback 端口和全新合成用户/口令，DATABASE_URL 已传入 Turbo。执行脚本的 EXIT/INT/TERM trap 已停止并删除本次独占 cluster，`pg-stop.log` 确认 server stopped；未复用之前的 cluster 或用户 DB。

本次所有校验首次通过，没有业务代码修复或新增测试；仅将 rebase 冲突处理、状态与复核证据 amend 到同一个任务 commit。此前修复前 43 项失败、历史 copy feedback 首次失败及随后通过记录均保留；既有 TypeScript 7 experimental API 警告保持。
