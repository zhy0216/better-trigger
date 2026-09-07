# UI 改进任务队列

六个任务已于 2026-09-05 完成，依据：[plan.md](../plan.md)。按用户最新要求，由当前会话和内置 subagent 直接执行；共享组件集中维护，页面按文件边界并行，最后统一验收。业务实现保留为工作区改动。

| 文件 | 优先级 | 难度 | 状态 | 完成内容 |
| --- | --- | --- | --- | --- |
| [01-responsive-shell.md](01-responsive-shell.md) | P1 | hard | completed | 响应式导航、共享主题、设置面板及焦点管理 |
| [02-runs-list.md](02-runs-list.md) | P1 | medium | completed | 响应式运行列表、筛选恢复、加载计数和空态 |
| [03-tasks-dashboard.md](03-tasks-dashboard.md) | P1 | medium | completed | 自适应指标/任务卡片、无样本与不可用状态 |
| [04-schedules.md](04-schedules.md) | P1 | medium | completed | 定时信息重排、暂停/pending/失败回滚反馈 |
| [05-run-details.md](05-run-details.md) | P1 | hard | completed | Trace/Details、日志阅读位置与复制反馈 |
| [06-integration-preview.md](06-integration-preview.md) | P2 | medium | completed | 集成检查、真实浏览器验收和源码预览 |

依赖关系：01 提供共享接口，02–05 按页面并行，06 统一集成。当前会话负责共享文件，三个 subagent 分别负责 Runs、Tasks/Schedules 和 Run 详情；各页面独立 CSS，未修改 API 契约或新增运行时依赖。

整仓 build、typecheck、lint、test 均通过；前端 21 个测试文件、180 个测试通过。整仓合计 1494 个测试通过、100 个条件性测试跳过，详情见 [实施验收记录](../plan.md#实施验收记录)。

预览：[http://127.0.0.1:5173](http://127.0.0.1:5173)。后端连接独立示例数据库。浏览器覆盖桌面/移动、双主题、双密度、键盘操作和失败分支；数据来源及缩放验证限制见 [截图及报告](../evidence/README.md)。
