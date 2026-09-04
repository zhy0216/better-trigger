difficulty: medium

# 08 · npm trusted publishing 与 provenance

覆盖方案 F8，只修改 release 链路。npm 账户侧 trusted publisher 是显式外部前置；没有该配置或没有维护者对具体测试版本的授权时，不执行真实发布。

## T1 · 迁移 release workflow 到 OIDC

- 要做什么：为 release job 增加最小 `id-token: write`，保留提交/tag 所需的 `contents: write`；把 publish 所用 Node/npm 提升到 npm trusted publishing 要求的 Node >=22.14、npm >=11.5.1；五个 tarball 继续按 core→db→kernel→sdk→worker 发布，并启用 npm provenance。workflow 不再读取 `secrets.NPM_TOKEN`/`NODE_AUTH_TOKEN`，注释与实际认证方式保持一致。
- 预计修改文件：`.github/workflows/release.yml`。
- 验收条件：`rg 'NPM_TOKEN|NODE_AUTH_TOKEN' .github/workflows/release.yml` 无命中；workflow 明确包含 `id-token: write`，运行时打印/断言 Node 与 npm 满足最低版本；pack、post-bump consistency、发布顺序、成功后 commit/tag 的现有防护保持不变；YAML/actionlint 校验通过。
- 前置依赖：`01-reproducible-worker-artifacts.md`、`02-deterministic-dependency-audit.md`；外部依赖：npm 账户为 `@better-trigger/core`、`@better-trigger/db`、`@better-trigger/kernel`、`better-trigger`、`@better-trigger/worker` 配置当前仓库与 `.github/workflows/release.yml` 的 trusted publisher。

## T2 · 验证 provenance 后再退役长期 secret

- 要做什么：由维护者在明确授权的测试包/预发布版本上运行一次 OIDC publish，核对 npm 页面/CLI 的 provenance 证明指向本仓库、该 workflow 和对应 commit。只有五包验证成功后，才在 GitHub 仓库设置中删除长期 `NPM_TOKEN` secret；仓库 commit 本身不得声称能删除账户侧 secret。
- 预计修改文件：通常无额外仓库文件；若验证暴露 release workflow 问题，只修正 `.github/workflows/release.yml` 并纳入同一 commit。
- 验收条件：五个发布物均有可验证 provenance，workflow 日志不读取长期 token；失败重试遵守现有规则，使用新的明确版本，绝不覆盖或重复已发布版本；维护者确认后删除外部 secret。
- 前置依赖：T1 与上述 npm trusted publisher 外部配置；真实发布需额外明确授权。

## 本文件验证

仓库侧：workflow YAML/actionlint、五包 build/pack/post-bump consistency dry-run、`rg 'NPM_TOKEN|NODE_AUTH_TOKEN' .github/workflows/release.yml`，以及 `bun run typecheck && bun run lint && bun run build && bun run test && bun run check:exports`。外部侧：仅在明确授权后验证一次 OIDC publish 和 npm provenance。
