# P2-20 — 工具链/CI 低挂果：lint 盲区、无缓存、Dockerfile 未验证、release 门禁

- 优先级：P2（工具链 / 发布安全）
- 区域：根目录工具链、.github、apps/web、docs
- 状态：待办
- 来源：2026-09-02 全仓库审查（第二轮）

## C1 · ESLint 实际从不检查任何 TypeScript 源码 {#c1}

### 问题摘要

根 `eslint.config.mjs` 全局 ignore `**/*.{ts,tsx}`；`apps/web` 的 lint 脚本只匹配
`*.{js,jsx,mjs,cjs}`——而仓库源码全部是 .ts/.tsx。`bun run lint` 实际只检查了
几个 JS 配置文件，配置好的 react-hooks/react-refresh 规则从未作用于应用代码。

### 现状证据

- `eslint.config.mjs:30`（`'**/*.{ts,tsx}'` 在 ignores 里）。
- `apps/web/package.json:11`：
  `"lint": "eslint --no-error-on-unmatched-pattern '**/*.{js,jsx,mjs,cjs}'"`。

### 推荐实现方案

- 引入 typescript-eslint（parser 即可，规则面保持最小增量），让根配置与
  apps/web 的 lint 覆盖 .ts/.tsx；至少先让 `react-hooks` 规则在 apps/web 生效。
- 首次开启会暴露存量告警：本条目的范围是「让规则生效并修掉报错级问题」，
  告警级问题可另立条目，不在此处无限扩大。

## C2 · CI 完全没有缓存 {#c2}

### 问题摘要

三个 workflow 均无 `actions/cache`（bun install 每次全量）；`turbo.json` 无
`remoteCache`，一次性 runner 上 `.turbo` 本地缓存无法跨运行复用；`node-smoke`
矩阵还会各自完整重建一遍。

### 现状证据

- `.github/workflows/*.yml`：无任何 `actions/cache` 步骤。

### 推荐实现方案

- 缓存 bun 安装产物（`~/.bun/install/cache` + `node_modules`，key 锁 `bun.lock`），
  或接入 Turbo remote cache；二选一，先做前者。

## C3 · Dockerfile 从不在 CI 构建验证；且有重复 `FROM base AS build` {#c3}

### 问题摘要

`apps/worker/Dockerfile` 是 docker-compose 的唯一镜像来源，但三个 workflow 都不
构建它——坏了只会在用户 `docker compose up` 时暴露。另外 `:28` 与 `:34` 出现两个
`FROM base AS build`，第一个是死 stage（BuildKit 以最后一个为准，暂无害但误导）。

### 现状证据

- `apps/worker/Dockerfile:28,34`；`.github/workflows/` 无 docker build 步骤。

### 推荐实现方案

- 删掉 `:28` 的重复死 stage；CI 加一个镜像构建 job（只 `docker build`，不 push）。

## C4 · release.yml 无 concurrency 守卫，发布门禁跳过验收套件 {#c4}

### 问题摘要

`release.yml` 无 `concurrency`（ci.yml 有）——两次手动 dispatch 可能在
bump/publish 上交错；发布前门禁明确不含 acceptance（注释自认无 Postgres）。

### 现状证据

- `.github/workflows/release.yml:55-70`（门禁注释与步骤）；无 `concurrency` 键。
- 对照：`.github/workflows/ci.yml:23-25`（有 `concurrency`）。

### 推荐实现方案

- 加 `concurrency: group: release, cancel-in-progress: false`；像 ci.yml 一样挂
  postgres service 跑一遍 `test:acceptance` 再发布。

## C5 · 文档漂移：LISTEN/NOTIFY 已实现但文档仍写「未交付」 {#c5}

### 问题摘要

代码已交付 LISTEN/NOTIFY（覆盖 trigger→claim 与 result 等待两条路径），但
`docs/architecture.md` P2 与 `docs/backend-contract.md:263` 仍写「未交付 / 全部
靠轮询」。另外 wait 到期与 cron 唤醒仍是纯轮询，文档回写时要如实区分。

### 现状证据

- 实现：`packages/kernel/src/notify.ts`、`apps/worker/src/notify.ts` +
  `apps/worker/src/listen.ts`、`packages/kernel/test/pg/suspend-notify.test.ts`。
- 陈旧表述：`docs/architecture.md` P2 段、`docs/backend-contract.md:263`。

### 推荐实现方案

- 回写两处文档：已覆盖路径（claim 唤醒、result 等待者）改为已交付并给代码指引；
  保留「wait 到期 / cron 仍为轮询兜底」的如实描述与轮询代价表。

## 验收标准

- [ ] `bun run lint` 覆盖 .ts/.tsx 且通过；`bun run typecheck`、`bun run build`、
  `bun run test` 全部通过。
- [ ] `docker build apps/worker` 本地可过；CI 新增构建 job 绿。
- [ ] release.yml 含 concurrency 与 acceptance 门禁；文档与代码状态一致。

## 涉及文件

- `eslint.config.mjs`、`apps/web/package.json`、`apps/web/eslint.config.*`（如有）、
  `.github/workflows/ci.yml`、`release.yml`、`apps/worker/Dockerfile`、
  `docs/architecture.md`、`docs/backend-contract.md`
