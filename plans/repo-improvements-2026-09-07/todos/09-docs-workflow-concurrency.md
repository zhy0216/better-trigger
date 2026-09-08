difficulty: easy
agent: inherit

# 文档 PR 与部署并发隔离

对应 F18。优先级 P2。前置依赖：无。只修改 docs workflow，不触发真实发布、不升级 action 版本。

## T1 · 按运行目的隔离 concurrency

- 要做什么：修改 `.github/workflows/docs.yml` 的全局 pages group，确保不同 PR 各自有 group，同 PR 的新 commit 可取消旧 build；main push/手动部署有明确的发布互斥，PR 不会取消发布。调整时保留 PR 仅构建、非 PR 才 upload/deploy 的现有边界。
- 预计修改：`.github/workflows/docs.yml`。
- 验收：静态列出 PR#1、PR#1 新 commit、PR#2、main push、main workflow_dispatch 的 group 和可取消关系；不同 PR/PR 与 main 不同组，发布 job 共享正确互斥。不会给 fork PR 增加 Pages 发布权限。
- 前置依赖：无。

## T2 · 权限与本地构建验证

- 要做什么：将 contents/read 和 Pages/id-token 权限限制到实际需要的 job，检查 environment/needs/if 与 concurrency 一致；只做本任务必要配置调整。
- 预计修改：`.github/workflows/docs.yml`。
- 验收：构建仍可 checkout/install/build；部署 job 保留必需 pages/id-token 和 github-pages environment；PR 无 deploy/upload。现有固定 action SHA、Bun 版本、触发路径和 Mermaid 校验保留。
- 前置依赖：本文件 T1。

验证：`bun run --cwd apps/docs check:mermaid`、`bun run --cwd apps/docs build`、`git diff --check` 与 README 仓库 gate；如本机有 actionlint 可静态校验，没有则使用配置评审及 group 对照，不为此引入依赖或实现镜像测试。报告本地验证，不声称已跑 GitHub Actions。一个最终 commit。
