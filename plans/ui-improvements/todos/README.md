# UI 改进任务队列

依据：[plan.md](../plan.md)。一个 todo 文件对应一个独立 worktree、一个最终 commit。实现保持现有英文界面、深色默认/亮色主题与紫色强调，不修改 API、数据库、SDK 或认证协议，不新增运行时依赖。

## 优先级

| 文件 | 优先级 | 难度 | 模型 | 依赖 | 说明 |
| --- | --- | --- | --- | --- | --- |
| [01-responsive-shell.md](01-responsive-shell.md) | P1 | hard | max | 无 | 统一视觉 token、响应式导航和设置面板，建立页面共享基础。 |
| [02-runs-list.md](02-runs-list.md) | P1 | medium | flash | 依赖 01-responsive-shell | 改善运行列表、筛选布局与可恢复空态。 |
| [03-tasks-dashboard.md](03-tasks-dashboard.md) | P1 | medium | flash | 依赖 01-responsive-shell | 重排指标与任务卡片，保留真实统计和错误信息。 |
| [04-schedules.md](04-schedules.md) | P1 | medium | flash | 依赖 01-responsive-shell | 重排定时任务信息，明确暂停与操作中状态。 |
| [05-run-details.md](05-run-details.md) | P1 | hard | max | 依赖 01-responsive-shell | 适配详情布局，改善日志阅读、错误优先级与复制反馈。 |
| [06-integration-preview.md](06-integration-preview.md) | P2 | medium | flash | 依赖 02-runs-list、03-tasks-dashboard、04-schedules、05-run-details | 完成整仓回归、浏览器验收，并提供本次源码预览。 |

## 文件

1. [01-responsive-shell.md](01-responsive-shell.md) — 依赖：无；hard / max；先完成并合并共享基础。
2. [02-runs-list.md](02-runs-list.md) — 依赖 01-responsive-shell；medium / flash；与 03、04、05 可并行。
3. [03-tasks-dashboard.md](03-tasks-dashboard.md) — 依赖 01-responsive-shell；medium / flash；与 02、04、05 可并行。
4. [04-schedules.md](04-schedules.md) — 依赖 01-responsive-shell；medium / flash；与 02、03、05 可并行。
5. [05-run-details.md](05-run-details.md) — 依赖 01-responsive-shell；hard / max；与 02、03、04 可并行。
6. [06-integration-preview.md](06-integration-preview.md) — 依赖 02-runs-list、03-tasks-dashboard、04-schedules、05-run-details 全部合并；medium / flash；最后串行验收。

## 并行波次与文件归属

执行顺序：`01 → [02 ∥ 03 ∥ 04 ∥ 05] → 06`。easy / medium 使用 flash，hard 使用 max；本队列没有 easy 任务。auto-dev 启动的协调器使用 OpenCode auto + `bailian-token-plan/qwen3.8-flash`，子任务模型由执行技能按 difficulty 分配。

- **01 独占共享文件**：`apps/web/src/App.tsx`、`components/Shell.tsx`、`components/Layout.tsx`、`components/TweaksPanel.tsx`、`components/navigation.ts`、`components/primitives.tsx`、`styles/index.css`、`styles/theme.css`、`styles/tokens.css`，及相关共享交互测试。
- **02 独占**：`screens/RunsList.tsx`、新增并由该页面直接 import 的 `screens/runs-list.css`、`test/runsList.test.tsx`。
- **03 独占**：`screens/TasksDashboard.tsx`、新增并由该页面直接 import 的 `screens/tasks-dashboard.css`、`test/tasksDashboard.test.tsx`。
- **04 独占**：`screens/Schedules.tsx`、新增并由该页面直接 import 的 `screens/schedules.css`、`test/schedules.test.tsx`。
- **05 独占**：`features/run/` 下必要的详情/滚动实现、新增并由 RunView 直接 import 的 `features/run/run-view.css`、`test/runView.test.tsx`、`test/logStream.test.tsx`、`test/runActions.test.tsx`。幂等 key 与数据协议保持原样。
- **06 在前述任务全合并后**串行处理必要的集成修复、文档和验收证据，不与前述任务同时修改文件。

上述相对路径均以 `apps/web/src` 为源码基准，`test/` 指 `apps/web/test/`。02–05 不修改 App、共享组件、全局样式或 API hooks；确需共享变更时交协调器串行安排，不在并行 worktree 中各自修改共享文件。每个页面样式只使用自己的前缀，避免影响其他页面。

## 共通验收与边界

每个实现任务运行 web typecheck、lint 和相关既有行为测试；布局靠真实浏览器验证，不为纯颜色/间距新增快照测试。保留服务端筛选、分页、环境隔离、认证错误、键盘操作和已实现的并发保护。

浏览器主尺寸为 390×844、768×1024、1440×960；复核 375px、200% 缩放、深色/亮色与 comfortable/compact。页面不得水平溢出；时间轴、代码和必要的筛选区域可以局部滚动。最终由 06 记录整仓校验结果、实际截图、数据来源与本次源码的预览地址。

遵循根 `agent.md` 使用 Bun，不用 `bun run --bun test` 改变测试解释器。测试数据库只能使用隔离资源，不写用户业务数据库，不清理容器卷。不得把旧容器界面、未执行的测试或浏览器错误页当成新 UI 验收通过。
