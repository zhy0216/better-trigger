difficulty: medium

# Schedules 布局与状态反馈

优先级：P1。模型：flash。前置依赖：01-responsive-shell 全部完成并合并。一个 worktree、一个最终 commit；与 02、03、05 可并行。

## T1 · 定时任务信息自适应重排

- **工作**：宽屏保留高效扫描，小屏将任务/描述、cron、时区、Next run、last 状态和开关分行；取消固定 60px 单行的限制，处理长任务名及长时区。暂停项使用明确 Paused 文案/徽标，不靠整行 opacity 降低正文对比度。空态说明继续使用已有 cron 注册路径。新增页面样式并直接 import。
- **预计修改文件**：`apps/web/src/screens/Schedules.tsx`、新增 `apps/web/src/screens/schedules.css`；`apps/web/test/schedules.test.tsx`。
- **验收**：390、768、1440px 下全部字段和开关可读可达；375px、200% 缩放无页面水平溢出；cron 和 task 全文可查看；停用状态明显且正文保持可读；不伪造 next/last 数据，不改变时间字段含义。不得修改共享组件、全局 CSS、App 或 API hooks。
- **前置依赖**：01-responsive-shell。

## T2 · 明确开关进行中状态并保持现有一致性

- **工作**：保留具名 switch 和 aria-checked，为发起更新的行显示 pending 状态并在请求期间禁用该行开关，其他行继续可操作。沿用乐观响应、serverRef/seqRef 协调、失败回滚与 401 连接错误通道，不重新设计请求协议。异步结束、失败或行消失后正确清理 pending。
- **预计修改文件**：`apps/web/src/screens/Schedules.tsx`、`apps/web/src/screens/schedules.css`、`apps/web/test/schedules.test.tsx`。
- **验收**：更新成功、失败回滚和 401 错误均保留正确反馈；请求期间不会由同一按钮再次发起同一行更新，其他行不被全局禁用；pending 解除后可以继续操作。轮询确认前保留乐观值，确认后跟随服务器；晚到结果不会覆盖更新的状态。开关名称与键盘操作保留。环境隔离保持，不让旧环境结果污染当前页面。
- **前置依赖**：01-responsive-shell；本文件 T1。

## T3 · 行为回归与真实布局检查

- **工作**：为 pending 和可观察暂停状态补充行为测试，保留已有乐观协调/回滚/认证回归价值。原测试中的 opacity/background 实现断言改为 switch 状态、按钮禁用和用户可见反馈，不通过删除测试规避回归；并发保护用与新 pending 交互相容的受控异步场景验证。
- **预计修改文件**：`apps/web/test/schedules.test.tsx`，以及 T1/T2 的必要修正。
- **验收**：运行 `bun run --cwd apps/web typecheck`、`bun run --cwd apps/web lint`、`bun run --cwd apps/web test test/schedules.test.tsx`。浏览器检查主尺寸、双主题/密度、长内容/空数据及暂停状态；开关成功、失败、pending 用明确隔离测试数据验证，不切换用户真实业务计划。
- **前置依赖**：本文件 T1、T2。
