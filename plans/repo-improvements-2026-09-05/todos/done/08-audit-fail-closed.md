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
