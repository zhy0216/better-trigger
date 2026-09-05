# 执行队列 · repo-improvements-2026-09-05

方案：../plan.md。10 个任务，17 项发现；R1～R4 roadmap 不进队列。状态：全部待执行。

## 强制执行配置

用户明确指定 **Codex CLI + YOLO + gpt-6-astra + xhigh**，覆盖 auto-dev / herdr-finish-plan / plan-to-todo 的 OpenCode、auto、flash/max 默认选择。协调器、所有实现任务及修复/rebase 都用同一配置，不允许降级或调用 OpenCode。

```sh
herdr agent start <name> --kind codex --pane <id> -- \
  --dangerously-bypass-approvals-and-sandbox \
  --model gpt-6-astra -c 'model_reasoning_effort="xhigh"'
```

一个 todo = 一个独立 worktree = 一个最终任务 commit。最多 5 个未完成任务；协调器独占原分支集成锁。每次只归档自己完成的 todo，README 冲突按每行状态合并。全部验收完才移到 done/。

## 优先级

| 文件 | 优先级 | 难度 | 模型 / 推理 | 说明 | 状态 |
|---|---|---|---|---|---|
| [01-dashboard-request-lifetime.md](01-dashboard-request-lifetime.md) | P1 | medium | gpt-6-astra / xhigh | Dashboard 完整请求生命周期 | 待执行 |
| [02-waiter-lifecycle-deadlines.md](02-waiter-lifecycle-deadlines.md) | P1 | hard | gpt-6-astra / xhigh | Waiter 关闭竞态与数据库故障下的期限 | 待执行 |
| [03-scenario-verdict-redaction.md](03-scenario-verdict-redaction.md) | P1 | medium | gpt-6-astra / xhigh | 验收结果可信度与日志脱敏 | 待执行 |
| [04-isolated-test-databases.md](04-isolated-test-databases.md) | P1 | hard | gpt-6-astra / xhigh | 测试数据库隔离、连接参数与资源生命周期 | 待执行 |
| [05-core-numeric-boundaries.md](05-core-numeric-boundaries.md) | P1 | medium | gpt-6-astra / xhigh | Duration 与 retry 的有限值和存储边界 | 待执行 |
| [06-sdk-request-timeout-range.md](06-sdk-request-timeout-range.md) | P2 | medium | gpt-6-astra / xhigh | SDK 单次请求 timer 范围 | 待执行 |
| [07-kernel-wait-contract.md](07-kernel-wait-contract.md) | P1 | hard | gpt-6-astra / xhigh | Kernel 等待选项与取消/超时语义 | 待执行 |
| [08-audit-fail-closed.md](08-audit-fail-closed.md) | P1 | medium | gpt-6-astra / xhigh | 审计进程与范围解析必须拒绝异常输入 | 待执行 |
| [09-dashboard-build-deduplication.md](09-dashboard-build-deduplication.md) | P2 | medium | gpt-6-astra / xhigh | 消除 worker 构建中重复的 dashboard 编译 | 待执行 |
| [10-runtime-test-lifecycle-stubs.md](10-runtime-test-lifecycle-stubs.md) | P2 | medium | gpt-6-astra / xhigh | 让运行时测试真正覆盖成功关闭 | 待执行 |

## 文件

1. 01-dashboard-request-lifetime.md — 依赖：无。
2. 02-waiter-lifecycle-deadlines.md — 依赖：无。
3. 03-scenario-verdict-redaction.md — 依赖：无。
4. 04-isolated-test-databases.md — 依赖 03-scenario-verdict-redaction。
5. 05-core-numeric-boundaries.md — 依赖：无。
6. 06-sdk-request-timeout-range.md — 依赖：无。
7. 07-kernel-wait-contract.md — 依赖 02-waiter-lifecycle-deadlines、05-core-numeric-boundaries、06-sdk-request-timeout-range。
8. 08-audit-fail-closed.md — 依赖：无。
9. 09-dashboard-build-deduplication.md — 依赖：无。
10. 10-runtime-test-lifecycle-stubs.md — 依赖：无。

## 并行与集成

按上述顺序选择当前可运行项，首批最多 01、02、03、05、06。03 合入后可分配 04；02/05/06 全合入后可分配 07。其余按空槽顺序补位。08/09/10 可与文件不重叠的任务并行。共同 README 的状态变更在串行 rebase 时保留，不能回滚其他任务归档。

所有任务执行 plan.md 中的仓库级 gate，协调器独立复核。04/05/07 的 PG 测试、04 的完整 acceptance、07 的 embedded/notify、08 的 audit、09 的构建/打包验证见各文件。04 落地前尤其不能让两个 worktree 共用固定命名测试库；每个运行 PG 测试的任务使用自己创建的临时容器。最终完整 acceptance 与所有 check:* 必须通过。
