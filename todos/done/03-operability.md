# Operability and Dashboard TODOs

## O1 — 更新 Dashboard onboarding 到 daemon 架构

**现状**

Dashboard onboarding 仍然展示旧的 embedded runtime 示例，用户复制后会得到不存在的 `database` 配置和 `trigger.start()` API。

**修复方向**

把引导改成当前真实流程：

1. `npm/bun install better-trigger`
2. 在 `tasks.ts` 中导出 `task()`
3. `better-trigger-worker --tasks ./tasks.ts`
4. 应用侧 `betterTrigger({ url })`
5. 用 `handle.result()` 查看结果

代码片段必须和 README、examples/basic、CLI help 共用模板或至少在 CI 中做 smoke test，避免架构切换后再次失效。

**验收标准**

- onboarding 的每一段命令可在 clean checkout 中执行。
- 不再出现 `database`、`trigger.start`、embedded runtime 等旧 API。
- 文档、Dashboard 和 `--help` 的启动参数一致。

涉及文件：

- [apps/web/src/screens/Onboarding.tsx](/Users/yang/workspace/better-trigger/apps/web/src/screens/Onboarding.tsx:1)
- [README.md](/Users/yang/workspace/better-trigger/README.md:63)

## O2 — 让 API key 模式下的 Dashboard 有可用认证方案

**现状**

worker 设置 `BETTER_TRIGGER_API_KEY` 后，API 会保护所有非 health 路由，但 Dashboard client 只发送 `Content-Type`，没有 `Authorization` header。

直接把 key 编进 Vite bundle 又会把 bearer secret 暴露给所有浏览器用户，因此不能只增加一个公开环境变量就算完成。

**修复方向**

优先级从高到低：

1. daemon 同源托管 Dashboard，前面使用反向代理/session/cookie 完成浏览器认证。
2. 本地开发可以提供显式 token 输入，只保存在内存中。
3. 若提供 `VITE_BT_API_KEY`，必须在文档中明确它只适合本机开发，不能用于公开部署。
4. 401 response 在 Dashboard 显示“需要 API key”，不要只显示 server offline。

**验收标准**

- 开启 API key 后，Dashboard 不会永久显示 Offline。
- 公开静态部署不会要求把长期 bearer secret 打进 bundle。
- API key 错误和 daemon 不可达在 UI 上可区分。

涉及文件：

- [apps/web/src/api/client.ts](/Users/yang/workspace/better-trigger/apps/web/src/api/client.ts:27)
- [apps/worker/src/middleware.ts](/Users/yang/workspace/better-trigger/apps/worker/src/middleware.ts:122)

## O3 — daemon 托管 Dashboard 静态资源

**现状**

当前 worker image 只包含 API 和执行 runtime，Dashboard 还需要单独运行 Vite dev server。这样部署时需要额外端口、CORS 和认证配置。

**修复方向**

- 构建 worker image 时构建 `apps/web`。
- 将 web dist 复制到 worker package/image，并增加静态 fallback route。
- `/` 返回 Dashboard，`/api/v1/*` 保持 API 路由。
- 生产部署使用同源访问，开发环境仍可用 Vite standalone。
- 静态资源带 content hash，避免 daemon 重启后缓存旧 bundle。

**验收标准**

- `docker compose up` 后只访问 `http://127.0.0.1:4848` 就能打开 Dashboard。
- API-only / `--no-serve` 的语义不被破坏。
- 深链接刷新不会返回 404。

## O4 — 统一版本来源和发布验证

**现状**

root package 是 `0.0.0`，workspace packages 是 `0.1.0`，health response 又在代码里硬编码 `0.1.0`。版本很容易和实际构建产物不一致。

**修复方向**

- 使用单一 release version 来源，或在 build 时注入 package version + git SHA。
- health、worker registration、metrics、Dashboard deployments 都复用同一个 build metadata。
- CI 增加每个可发布包的 `npm pack` + clean install + CLI smoke test。
- 统一 worker 包名和 README 的安装命令，验证 `bunx`/`npx` 在仓库外可用。

**验收标准**

- `/health.version`、worker codeVersion、发布包版本可追溯到同一 commit。
- clean temporary directory 中可以安装并运行 `better-trigger-worker --help`。
- 发布前不会出现 workspace 能运行、registry 包不能运行的情况。

涉及文件：

- [package.json](/Users/yang/workspace/better-trigger/package.json:1)
- [apps/worker/src/routes/dashboard.ts](/Users/yang/workspace/better-trigger/apps/worker/src/routes/dashboard.ts:31)
- [apps/worker/package.json](/Users/yang/workspace/better-trigger/apps/worker/package.json:1)

## O5 — 给后端和 Dashboard 补齐工程护栏

**现状**

根目录 `bun run lint` 当前实际上只有 web package 有 lint script；kernel、db、sdk、worker 等 TypeScript 代码没有统一 lint 规则。Dashboard 也没有自己的 component/adapter/hook 测试。

**修复方向**

- 建立共享 ESLint/oxlint/Biome 配置，所有 TS package 都提供 lint script。
- 为 `stats`、namespace、replay adapter、polling hook、API error mapping 添加单测。
- 为 Dashboard 增加至少一个浏览器级 smoke test：server down、401、空数据、长日志、分页。
- 保留现有 acceptance harness，并增加 migration upgrade/downgrade 和 rolling deploy 场景。

**验收标准**

- `bun run lint` 覆盖所有生产 TypeScript 包。
- Dashboard 关键交互不再只靠手工验证。
- CI 能在无本地缓存、干净安装、真实 PostgreSQL 下完成全链路验证。

## O6 — 网络暴露时补齐限流和审计

**现状**

当前安全边界主要是 loopback 默认绑定和单个静态 Bearer key。对于显式暴露到网络的部署，还缺少按 key/IP/task 的速率限制、调用审计和密钥轮换。

**修复方向**

- 对 trigger、batch-trigger、retry、cancel 分别设置 token bucket/并发上限。
- 记录 request id、调用方、task、run id、结果和拒绝原因；payload 默认脱敏。
- 支持多个 key、过期时间和轮换，而不是只读一个环境变量。
- 文档明确 TLS、反向代理和数据库连接隔离要求。

**验收标准**

- 恶意或误配置客户端不能无上限创建 run。
- key 轮换不会中断旧请求，也不会长期保留旧凭证。
- 审计记录不泄漏 payload 中的敏感信息。
