difficulty: medium

# 审计进程与范围解析必须拒绝异常输入

对应 plan.md：F14、F15。执行模型固定为 Codex YOLO / gpt-6-astra / xhigh。

## T1 · 进程和 JSON schema 都是审计成功条件

- 做什么：重构 scripts/check-audit.mjs 的可测边界，验证 spawn error/signal/status、响应顶层及每项 advisory 必填字段。核对实际 Bun audit 的退出约定，区别“有漏洞的正常报告”和工具失败；设置合理子进程超时。不能仅因 stdout 为可解析 JSON 就放行。
- 预计修改：scripts/check-audit.mjs、相邻离线测试/fixtures（新增）；必要时 package.json、bun.lock；.github/workflows/ci.yml 仅接入离线测试入口。
- 验收：模拟 exit=2 + {}、signal、ENOENT、超时、数组/null/错误对象/非法 advisory，均失败并给诊断；正常 clean 和有效有漏洞报告分别走正确结果；真实 check:audit 仍固定官方 registry。
- 前置依赖：无。

## T2 · 完整解析范围，杜绝短路绕过

- 做什么：在匹配前完整验证所有 AND/OR comparator group，非法/未知表达式拒绝或保守命中，不能短路成不受影响。显式决定并记录 advisory prerelease 策略，不直接丢弃版本后缀。若使用标准 SemVer 库，应先核对其 prerelease 默认行为；可加范围明确的 root devDependency，禁止大规模升级。
- 预计修改：同 T1。
- 验收：3.0.0 对 '<2.0.0 garbage' 不能返回无影响；unknown comparator 放在 AND/OR 各位置均不绕过；正常 comparator/wildcard/OR/范围边界、预发布规则、精确 lock chain 和例外 expiry/severity/stale checks 有离线 fixtures。不能用现实 advisory 漏报作为已证明前提。
- 前置依赖：本文件 T1。

## T3 · 离线和在线 gate

- 做什么：将可离线验证的恶意/异常 fixtures 接入已有 self-test 或清晰的测试脚本，确保 CI 实际运行。
- 预计修改：同 T1。
- 验收：bun run check:audit -- --self-test 与真实 bun run check:audit 通过；故意坏 fixture 的预期非零被测试正确断言；lint/全仓库 gate 通过，不靠网络失败当成通过。
- 前置依赖：本文件 T1、T2。

## 执行约束与仓库校验

全程只用 Codex CLI YOLO、`gpt-6-astra`、`xhigh`，包括后续修复/rebase；difficulty 仅描述复杂度，不改变模型。先读 ../plan.md 与仓库 agent.md。一个 todo 一个 worktree、一个最终 commit，只修改本任务范围；不 push、不操作原分支。只有全部验收完成才移入 done/，并只更新 README 中本任务状态。

针对性校验完成后，在本 worktree 顺序运行 `bun run lint`、`bun run typecheck`、`bun run build`、`bun run test -- --force`、`git diff --check`。不要用 `bun run --bun test` 替代标准命令。新 worktree 缺依赖时 `bun install --frozen-lockfile`。数据库测试必须使用本任务独占临时 PostgreSQL，记录并清理所建资源；不能对用户现有库执行 reset。

## 最终 gate 收尾兼容修复 · 2026-09-05

根因：`parseAuditResult` 将所有非空 stderr 都视为审计失败。Bun 1.4.0 在有默认 dotenv 文件时会向 stderr 写一条正常加载计时信息，例如 `[0.05ms] ".env"`；真实审计同时返回 status 0、stdout `{}`。此前没有 `.env` 的独立 worktree 漏掉了这个场景。

在自建临时 fixture 中实测了 `--no-env-file` 放在 audit 前后、`--env-file=empty.env`（合成空文件）、`bunfig.toml` 的 `env = false`。这些方式均未抑制 Bun 1.4.0 audit 的加载提示，因此没有采用这些无效开关，也没有关闭全部警告。

新增的唯一生产逻辑只移除首行中严格匹配的非负、两位小数毫秒计时提示，文件名必须是下列顺序的非空子序列：`".env.production.local", ".env.local", ".env.production", ".env"`。要求精确引号、逗号空格及行末换行（LF/CRLF）。未知文件名、重复或乱序文件、提示前后的真实诊断、同行附加文本、第二条提示均继续失败。进程 error/signal/status、JSON、schema、range、实际漏洞和例外检查保持生效；未确认的新格式继续拒绝。

Bun 1.4.0 的 `audit` 和离线 `pm hash` 实测一致：

| 合成 fixture | 实际 stderr（省略可变计时前缀） |
| --- | --- |
| 没有 env 文件 | 空 |
| 单独 `.env` / `.env.local` / `.env.production` / `.env.production.local` | 对应文件名的一条提示 |
| 单独 `.env.development[.local]`，`NODE_ENV=development` | 空 |
| 单独 `.env.test[.local]`，`NODE_ENV=test` | 空 |
| 全部 8 个默认文件；`NODE_ENV` 分别未设置、development、production、test、staging | `".env.production.local", ".env.local", ".env.production", ".env"` |

共 14 个真实场景；本版本的 package-manager 命令在这些 NODE_ENV 值下均选择 production 文件组。识别范围以这些 audit 实测结果为依据，不将运行普通脚本的 dotenv 规则推定为 audit 的规则。

离线 self-test 新增真实 `bun pm hash` 的 dotenv 启动输出采集，验证合法报告及前后混合诊断；现有每个进程/JSON/schema/range 拒绝 fixture 同时覆盖附带正常提示的情况，并保留真实子进程退出码和 timeout 检查。线上回归入口 `bun scripts/check-audit.test.mjs --live-test` 创建临时源码/lock 副本，对全部 14 个场景运行固定官方 registry 的原始 audit 和标准 `bun run check:audit`，并在有 `.env` 和无 `.env` 时分别运行标准 self-test；不增加生产 CLI 的 fixture 开关。

本次命令证据（Bun 1.4.0，Bun 命令均以 `env -u DATABASE_URL` 启动）：

| 命令 | 结果 |
| --- | --- |
| `bun install --frozen-lockfile` | exit 0；新 worktree 安装 581 packages，lock 未改 |
| `bun run lint` | exit 0；9/9 tasks，变更所在 root lint 重新执行 |
| `bun run typecheck` | exit 0；14/14 tasks |
| `bun run build` | exit 0；7/7 tasks，worker artifacts 校验通过 |
| `bun run test -- --force` | exit 0；13/13 tasks，0 cached；1,465 passed、100 skipped |
| `bun run check:audit -- --self-test` | exit 0；234 rejected fixtures、49 range cases、14 real offline dotenv scenarios |
| `bun run check:audit` | exit 0；0 findings、0 exceptions |
| `bun scripts/check-audit.test.mjs --live-test` | exit 0；14 个真实 audit 均 status 0、stdout `{}`；有/无 `.env` 的标准 self-test 均通过 |
| `git diff --check` | exit 0 |

标准 gate 与根审计日志保留于 `/tmp/bt-audit-dotenv-gate.yVKjsb/`。标准构建仍报告既有 TypeScript 7 API experimental 警告，没有禁用警告。按用户收尾指示未运行或创建 PG；标准测试跳过 100 项。

全部探针和回归 fixture 的环境文件均由本次测试写入无害的 `AUDIT_DOTENV_FIXTURE_*` 合成变量，并在 `finally` 删除目录；线上 fixture 的 node_modules 链接也随目录删除。未读取、打印、复制或修改原 checkout 的环境文件，未使用用户数据库或凭据。只修改两个 audit 脚本并追加本文件；其他 todo 与 README 状态不变。以单独收尾 commit 接续原有十个任务提交，后续独立 gate 和 ff-only 合入由协调器执行。
