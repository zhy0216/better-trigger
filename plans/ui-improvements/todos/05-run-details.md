difficulty: hard

# Run 详情排查体验

优先级：P1。模型：max。前置依赖：01-responsive-shell 全部完成并合并。一个 worktree、一个最终 commit；与 02、03、04 可并行。

## T1 · 响应式 Trace 与 Inspector

- **工作**：桌面保留瀑布图和 Inspector，小屏选择可访问的 Trace / Details 切换或自然纵排，让详情始终可访问。复用同一份 selected span 和数据状态；时间轴维持最小可读宽度，在自己的容器内横向滚动，标签宽度随断点变化。新增页面独立样式并由 RunView 直接 import。
- **预计修改文件**：`apps/web/src/features/run/RunView.tsx`、新增 `apps/web/src/features/run/run-view.css`；`apps/web/test/runView.test.tsx`。必要拆分组件仅放在 `apps/web/src/features/run/` 内。
- **验收**：390、768、1440px 下 Trace 和 Details 都可访问，375px/200% 缩放仍可操作；多层 span 的标签和时间轴可读，无页面级横向溢出。切换面板或视口宽度不重置 selected span、不引入重复轮询；键盘 span 选择和焦点可见性保留。不得修改共享组件、App、全局样式或 API hooks。
- **前置依赖**：01-responsive-shell。

## T2 · 日志跟随状态与阅读位置

- **工作**：基于已有滚离底部暂停机制显示 Following/Paused 与 Jump to latest；阅读历史时新增日志不抢滚动位置，加载更早日志后保持可见锚点。span 范围切换控件明确说明当前范围并提供 aria-pressed；区分运行中等日志、终态无日志和当前范围无日志。保留历史日志分页、加载中和错误重试信息。
- **预计修改文件**：`apps/web/src/features/run/RunView.tsx`、`apps/web/src/features/run/scroll.ts`、`apps/web/src/features/run/run-view.css`；`apps/web/test/logStream.test.tsx`、`apps/web/test/runView.test.tsx`。
- **验收**：自动跟随时新日志显示在末尾；手动上滚后位置稳定且状态为 Paused；Jump to latest 恢复跟随；prepend 历史数据后阅读锚点保持。切换 span 不遗留旧范围状态；无匹配日志也能看到可用的 hasOlderLogs/loading/error；日志 ID 稳定性和已有重复/顺序回归保持。日志区高度适应视口，不遮住详情操作。
- **前置依赖**：01-responsive-shell；本文件 T1。

## T3 · 错误优先与完整内容复制

- **工作**：失败 span 优先展示错误摘要，避免长 Payload 把错误挤下去；Error/Payload/Output 支持折叠展开及复制完整原值。提供可访问的复制成功/失败反馈，权限拒绝不假报成功；切换 span 清除旧内容或复制反馈。child run ID 可查看和复制全文，不增加未经 API 验证的导航。
- **预计修改文件**：`apps/web/src/features/run/RunView.tsx`、`apps/web/src/features/run/run-view.css`，以及必要的 run 局部组件；`apps/web/test/runView.test.tsx`。
- **验收**：长 JSON 与 stack 只在局部滚动，错误摘要首先可见；折叠不丢失原始内容；复制结果与完整底层值一致，成功/失败状态能够被辅助技术获知；切换 span 后不会复制旧 span 内容。展开/复制控件键盘可用，不新增依赖或 API 行为。
- **前置依赖**：01-responsive-shell；本文件 T1。

## T4 · 保留运行控制并验证完整排查流程

- **工作**：验证取消/重试及详情返回不受布局影响，保持 pending guard、状态限制、重试 intent key、幂等协议与重试后打开新 run。对日志跟随/分页锚点、span 切换和复制失败补充必要行为测试，纯样式使用浏览器检查。
- **预计修改文件**：`apps/web/test/runView.test.tsx`、`apps/web/test/logStream.test.tsx`、`apps/web/test/runActions.test.tsx`，以及 T1–T3 的必要修正；不为视觉改进修改 `retryIntentKey.ts` 的协议。
- **验收**：运行 `bun run --cwd apps/web typecheck`、`bun run --cwd apps/web lint`、`bun run --cwd apps/web test test/runView.test.tsx test/logStream.test.tsx test/runActions.test.tsx`。浏览器验证主尺寸、双主题/密度、多层 span/长 payload/失败 stack/无日志/分页错误/复制失败。取消重试只使用隔离 fixture 或明确的测试运行，不影响真实业务任务。
- **前置依赖**：本文件 T1、T2、T3。
