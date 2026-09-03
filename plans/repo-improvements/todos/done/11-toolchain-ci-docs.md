difficulty: medium

# 11 · 工具链 / CI / 文档

覆盖仓库根、`.github/`、`apps/docs`、`examples` 与 `apps/worker/Dockerfile`。触碰的 worker 文件（`src/notify.ts`、`test/executor-swallowed-signal.test.ts`）与 06/07 不相交。

## T1 · 清零 lint warning（P2）

- 做什么：删除 4 条未使用的 `// eslint-disable-next-line prefer-const`：`apps/worker/src/notify.ts:87,89`（`sleepWithWake` 的 `let timer`/`let unsubscribe` TDZ 模式，声明后确有赋值）、`apps/worker/test/executor-swallowed-signal.test.ts:163,281`（`let ex!: Executor` 延迟赋值）。注意同文件 `:195` 的 `no-useless-catch` disable 是**在用**的，保留。
- 预计文件：上述两个文件。
- 验收：`bun run lint` 输出 0 error 0 warning。
- 前置依赖：无。

## T2 · lint 覆盖根脚本与配置（P2）

- 做什么：所有工作区 lint 脚本都以自身目录 glob，`scripts/bump-versions.mjs`、`check-deps.mjs`、`check-drift.mjs`、`eslint.config.mjs`、`apps/docs/validate-mermaid.mjs`/`.vitepress/config.mts` 全部在 lint 之外——尽管 `eslint.config.mjs:5` 自称"全仓库单一基线"。发布关键脚本（尤其 bump-versions）零覆盖。加根级 lint 脚本（如 `eslint scripts/*.mjs eslint.config.mjs apps/docs/validate-mermaid.mjs apps/docs/.vitepress/config.mts`），经 turbo 根任务（`//#lint` 或等价）接入 `bun run lint`。
- 预计文件：`package.json`、`turbo.json`、（修复首次纳入后暴露的违规）。
- 验收：`bun run lint` 包含根脚本且通过。
- 前置依赖：无。

## T3 · CI 缓存与供应链硬化（P2）

- 做什么：
  - 三个 workflow（`ci.yml:67-78`、`release.yml:94-105`、`docs.yml:40-51`）缓存了 bun 依赖但没缓存 `.turbo/`——core→db→kernel→sdk→worker→web 的构建链每个 job 全量重跑。把 `.turbo` 加进缓存路径。
  - 所有 actions 按可变主版本 tag 固定（checkout@v4、cache@v4、setup-bun@v2、upload-pages-artifact@v3、deploy-pages@v4）；`release.yml` 持有 `NPM_TOKEN`，按供应链惯例改 SHA 固定（加版本注释）。
- 预计文件：`.github/workflows/ci.yml`、`release.yml`、`docs.yml`。
- 验收：缓存键含 `.turbo`；第三方 actions 为 SHA；workflow 语法有效（`actionlint` 若可用）。
- 前置依赖：无。

## T4 · docs 构建进 PR 门禁（P2）

- 做什么：`docs.yml:10-16` 只在 push main（paths `apps/docs/**`、`bun.lock`）与手动分发触发——PR 弄坏 VitePress 构建或 mermaid 图可以绿灯合并、部署时才炸；`paths` 还漏了 workflow 自身。加一个 `pull_request` job（build + `check:mermaid`），paths 含 `apps/docs/**`、`bun.lock` 与该 workflow 文件。
- 预计文件：`.github/workflows/docs.yml`。
- 验收：PR 触发文档构建门禁；paths 覆盖 workflow 自身。
- 前置依赖：无。

## T5 · 关闭 ignoreDeadLinks 并修链（P2）

- 做什么：`apps/docs/.vitepress/config.mts:47` `ignoreDeadLinks: true` 使坏内链永不失败——与本仓库 check:mermaid/check:drift 的防漂移哲学相反。移除全局开关，改为修复或精确豁免（外链可用模式豁免），构建跑通。
- 预计文件：`apps/docs/.vitepress/config.mts`、（修复暴露的死链页面）。
- 验收：`ignoreDeadLinks` 全局开关移除；文档构建通过；无已知死链残留。
- 前置依赖：无。

## T6 · 文档漂移修复（P2）

- 做什么：
  - `README.md:306` 与 `apps/web/README.md:13` 仍称"lint 只覆盖 JS/配置文件、TS 靠 tsc"——p2-20 之后 ESLint 已覆盖全部 `.ts/.tsx`（eslint.config.mjs、apps/web/eslint.config.js、ci.yml:83-90 为证），改为如实描述。
  - `apps/docs/architecture/roadmap.md:42-57` 与 `apps/docs/zh/architecture/roadmap.md:43-50` 仍把 LISTEN/NOTIFY 列为 Remaining（同页上方却写"已交付"；`docs/architecture.md` 与 `notify` 验收场景证实已上线）——两语言同步移出，四路径表改为"快路径 + 轮询兜底"。
  - `apps/docs/reference/rest-api.md:22` `POST /runs/:id/retry` 未记录请求级 `Idempotency-Key`（服务端 `routes/runs.ts:37-52` 实现、含 200 字符上限，dashboard 与 SDK 都在用）——补表（含重放语义），中文镜像同步。
  - `examples/basic/README.md:26,32` "What's inside" 表：`scripts/retention.ts` 重复，缺 `code-version-pinning`、`graceful-restart`、`run-detail`、`loop-hang`、`concurrency` 五个 harness——去重补齐。
- 预计文件：`README.md`、`apps/web/README.md`、`apps/docs/architecture/roadmap.md`、`apps/docs/zh/architecture/roadmap.md`、`apps/docs/reference/rest-api.md`（+ zh 对应）、`examples/basic/README.md`。
- 验收：逐条与代码/既有文档核对一致；文档构建通过。
- 前置依赖：T5（同属 apps/docs 构建，避免死链检查互相干扰）。

## T7 · 容器与 compose 安全（P2）

- 做什么：
  - `docker-compose.yml:23-24` `ports: '5432:5432'` 把默认口令的 Postgres 绑到 0.0.0.0，而同文件刻意把 worker API 绑到 127.0.0.1——同类风险更无理由。改 `'127.0.0.1:5432:5432'`。
  - `apps/worker/Dockerfile:53,84` build 阶段 `bun install --frozen-lockfile` 未过滤、runtime 阶段整体拷根 `node_modules`——vitest/typescript/eslint/tsdown 等全部 devDep 进生产镜像。改为 build 用 dev 安装、runtime 用 `bun install --production`（或等价的生产过滤布局），保持 bin 与运行时依赖完整。
- 预计文件：`docker-compose.yml`、`apps/worker/Dockerfile`。
- 验收：compose 仅本机暴露 5432；`docker build`（CI docker job 或本地）成功且镜像内无 devDep 包（抽查 `node_modules` 无 vitest/typescript）。
- 前置依赖：无。

## 本文件验证

`bun run typecheck && bun run lint && bun run build && bun run test`；文档改动跑 `apps/docs` 构建 + `check:mermaid`；Docker/compose 改动按环境可及性验证（至少 `docker build` 语法与层结构检查）。
