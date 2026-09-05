difficulty: medium

# Tasks 指标与任务卡片

优先级：P1。模型：flash。前置依赖：01-responsive-shell 全部完成并合并。一个 worktree、一个最终 commit；与 02、04、05 可并行。

## T1 · 指标与任务卡片的信息层级

- **工作**：窄屏指标两列、极窄时一列，任务卡片小屏单列、宽屏两列；突出任务名、24h 运行量、成功率，延迟和路径居次。长 task/file 使用换行或可查看全文的截断，卡片内部指标能够换行；空任务状态提供合理说明和内边距。新增页面独立样式并直接 import。
- **预计修改文件**：`apps/web/src/screens/TasksDashboard.tsx`、新增 `apps/web/src/screens/tasks-dashboard.css`；必要的 `apps/web/test/tasksDashboard.test.tsx`。
- **验收**：390、768、1440px 下卡片/指标层级清楚且不溢出，375px 和 200% 缩放仍能读到任务身份和核心指标；长路径不撑破布局；卡片点击/Enter/Space 的既有跳转保持，不擅自新增路由或改变筛选行为。页面样式不影响其他页面，不修改共享文件或 API hooks。
- **前置依赖**：01-responsive-shell。

## T2 · 保留统计真实性与不可用状态

- **工作**：让真实零值、尚未知晓和请求不可用的视觉表达彼此区分；保持现有指标数据来源、单位与含义，保留 workers/schedules 次要 API 的独立失败提示，不用 0 替代失败。无任务时保留注册任务/启动 worker 的帮助文案。
- **预计修改文件**：`apps/web/src/screens/TasksDashboard.tsx`、`apps/web/src/screens/tasks-dashboard.css`、`apps/web/test/tasksDashboard.test.tsx`。
- **验收**：正常数据、空数组、次要数据尚未返回和次要接口错误均有准确表达；真实 0 不显示成缺失数据；workers/schedules 失败不掩盖已加载任务，也不伪装正常统计。保持现有成功率统计口径，不添加合成趋势或示例数字。原有 unavailable 回归测试继续通过。
- **前置依赖**：01-responsive-shell；本文件 T1。

## T3 · 验证正常、空态与长内容

- **工作**：复核任务卡布局及统计/错误状态；只为真实的状态分支补充测试，不为样式数值添加实现镜像测试。
- **预计修改文件**：`apps/web/test/tasksDashboard.test.tsx`，以及 T1/T2 的必要修正。
- **验收**：运行 `bun run --cwd apps/web typecheck`、`bun run --cwd apps/web lint`、`bun run --cwd apps/web test test/tasksDashboard.test.tsx`。浏览器验证三个主尺寸、双主题/密度、长名称、长路径、空任务及次要接口不可用；记录真实结果，fixture 仅用于隔离验证。
- **前置依赖**：本文件 T1、T2。
