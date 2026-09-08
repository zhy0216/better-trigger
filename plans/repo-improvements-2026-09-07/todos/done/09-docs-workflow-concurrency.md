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

## 完成记录

已完成 T1/T2。实现仅修改 `.github/workflows/docs.yml`；任务记录只归档本文件并更新 README 的 09 行。没有执行 roadmap、发布、push、PR、rebase 或 merge。

### T1：并发组及取消关系

全局 concurrency 覆盖 build 至 deploy 的整个运行。PR 按编号选择 `docs-pr-{number}`，其余事件共用原有 `pages` 发布锁；只有 PR 的 `cancel-in-progress` 为 true。

| 运行 | group | cancel-in-progress | 可取消关系 |
| --- | --- | --- | --- |
| PR#1 | `docs-pr-1` | true | 只能替换同 PR 的旧运行 |
| PR#1 新 commit | `docs-pr-1` | true | 可取消 PR#1 旧 build；不影响 PR#2 或发布 |
| PR#2 | `docs-pr-2` | true | 只能替换 PR#2 旧运行；不影响 PR#1 或发布 |
| main push | `pages` | false | 与手动发布互斥，不取消正在运行的发布 |
| main workflow_dispatch | `pages` | false | 与 main push 互斥，不取消正在运行的发布 |

手动运行即使选了其他 ref，也共用 `pages`，没有按 ref 拆开同一站点的发布锁。deploy job 处于该全局锁内，无需再设置同名 job 锁。不同 PR，以及任意 PR 与发布，均不同组。

边界：`cancel-in-progress: false` 保护正在运行的发布；默认 concurrency 仍只保留一个 pending 运行，后来的发布可能替换旧 pending 发布，不保证每次发布都执行。依据 [GitHub concurrency 文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) 做静态配置评审，没有实际触发 GitHub Actions。

### T2：权限及现有边界

- workflow 默认 `permissions: {}`；build job 仅 `contents: read`，保留 checkout、Bun 安装、依赖缓存、frozen install、Mermaid 校验和文档构建。
- deploy job 仅 `pages: write`、`id-token: write`；保留 `needs: build`、`github-pages` environment 和部署 URL 输出，符合 [Pages 自定义 workflow 要求](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。
- artifact upload 和 deploy 的 `github.event_name != 'pull_request'` 条件原样保留，PR（包括 fork PR）不 upload、不 deploy；PR build 不获得 Pages/OIDC 写权限。
- 五个 action 的固定 SHA、workflow Bun `1.4.0`、缓存配置、push/main 和 PR 触发路径、workflow_dispatch、Mermaid 命令均未改变；未改依赖或锁文件。
- 本机无 actionlint，没有安装额外工具或引入镜像测试。用 Bun 内置 YAML 解析器成功解析真实配置，并人工检查上述 group、权限、needs、environment 和 if；解析快照保存在日志目录中，不将其视为 GitHub Actions 执行结果。

### 本地验证与日志

本机 Bun `1.4.2`。日志保留在 `/tmp/bt-docs-09-20260907-9rfVvt/`，包括首次命令输出、后续独立日志、配置解析快照和 PG 生命周期日志。

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `bun install --frozen-lockfile` | exit 0，当前 worktree 安装 588 packages，锁文件未变 | `01-install.log` |
| `bun run --cwd apps/docs check:mermaid` | exit 0，12 ok / 0 failed | `02-mermaid.log` |
| `bun run --cwd apps/docs build` | exit 0，15.05s | `03-docs-build.log` |
| `bun run lint` | 首次 exit 0，9/9 tasks（8 cached）；禁用缓存后 exit 0，9/9、0 cached，6.152s | `04-lint.log`、`04b-lint-fresh.log` |
| `bun run typecheck` | 首次 exit 0，14/14（13 cached）；禁用缓存后 exit 0，14/14、0 cached，4.682s | `05-typecheck.log`、`05b-typecheck-fresh.log` |
| `bun run build` | 首次 exit 0，7/7（6 cached）；禁用缓存后 exit 0，7/7、0 cached，16.114s | `06-build.log`、`06b-build-fresh.log` |
| `bun run test -- --force`，独占临时 PostgreSQL 16 | 首次 exit 0，13/13 tasks、0 cached，156 files / 1,594 tests，36.874s；kernel 59 files / 435 tests，无 PG skip | `07-test-pg-first.log` |
| `git diff --check` | exit 0，归档前及归档后均检查 | `08-diff-check-initial.log`、`08b-diff-check-final.log` |
| `command -v actionlint`；Bun YAML 配置解析及人工评审 | actionlint 不可用；解析成功，按 T1/T2 对照完成评审 | `actionlint-availability.log`、`workflow-review.json` |

首次三个根 gate 命中已有 Turbo 缓存，因此保留其日志，并设置 `TURBO_FORCE=true`、`TURBO_CACHE_DIR=/tmp/bt-docs-09-20260907-9rfVvt/turbo-cache` 顺序重跑，确保本 worktree 真正执行校验并重新生成产物。未从其他 worktree 手动复制或链接 node_modules/dist。

根测试通过 `run-pg-tests.sh` 执行：mkdtemp 创建独占 cluster，Bun 申请随机 loopback 端口并生成合成用户名，initdb/pg_ctl 仅监听 127.0.0.1；导出 DATABASE_URL，现有 `turbo.json` 的 test.env 将它传入测试任务。脚本 EXIT/INT/TERM trap 停止并清理自己的 cluster，`pg-cleanup.log` 确认停止及目录删除。

`bun run test:acceptance` 的 19 harnesses 属于协调器最终集成 gate，本 docs todo 未运行，不把计划基线算成本任务证据。

### 首次失败、告警及剩余边界

本任务项目验证没有失败，根 PG 测试只执行一次并通过，包含 `runView.test.tsx` 的 5 tests。首次三个根 gate 的缓存结果没有被后续日志覆盖。一次初始读取命令因 zsh 的 `path` 变量覆盖查找路径而报告 `rg: command not found`；后续使用正常 shell 命令完成读取，与项目校验无关。

原计划记录的探索阶段首次 PG 根测试失败及随后复核通过必须继续保留，本任务没有修改 plan.md，也没有修复或宣称解释该复制反馈竞态：

```text
FAIL test/runView.test.tsx > Inspector content and copy feedback > puts the error before a collapsed large payload and copies the complete hidden content
AssertionError: expected '' to be 'Copied' // Object.is equality
```

探索阶段随后复核通过为 156 files / 1,594 tests、acceptance 19/19；本次通过不覆盖此前失败，也不代替任务 08 的调查。

构建保留已有告警：`WARN TypeScript 7.0 does not yet have a stable API and is experimental. Some options will be unavailable.` 未升级工具链。没有实际 GitHub Actions、fork PR 或 Pages 发布运行证据；并发取消与权限结论来自配置评审和官方文档。本任务无剩余 blocker，集成由协调器执行。
