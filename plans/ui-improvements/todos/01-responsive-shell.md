difficulty: hard

# 共享视觉与响应式 Shell

优先级：P1。模型：max。前置依赖：无。一个 worktree、一个最终 commit。

## T1 · 统一视觉基础与页面容器

- **工作**：基于现有灰阶、紫色强调与双主题，整理必要文字、背景、边界、间距和焦点样式；把影响共享布局的内联样式迁为类，保留已有可调主题/密度协议。Page 和运行详情的应用容器建立一致的 main landmark，避免嵌套 main；使用动态视口高度及 fallback。为后续页面提供可复用的尺寸/间距基础，但不实现页面布局。
- **预计修改文件**：`apps/web/src/styles/theme.css`、`apps/web/src/styles/tokens.css`、`apps/web/src/styles/index.css`、`apps/web/src/components/Layout.tsx`、`apps/web/src/components/primitives.tsx`、`apps/web/src/App.tsx`；必要的共享行为测试位于 `apps/web/test/primitives.test.tsx`、`apps/web/test/a11yTweaks.test.tsx`。
- **验收**：深色/亮色、comfortable/compact 均能区分页面层次；必要普通文字的实际合成颜色对比度至少 4.5:1，控件/焦点边界至少 3:1，记录采样结果而非仅凭 opacity 推断；focus-visible 可见，reduced-motion 下状态仍明确；375px 和动态视口下不截断主要区域；每个路由只存在一个可访问的 main。已有交互 Card/button/switch 语义保持。
- **前置依赖**：无。

## T2 · 导航和顶栏适配小屏

- **工作**：保留桌面侧栏折叠行为；以 768px/1100px 为初始断点，按真实内容调整，小屏提供可关闭的导航抽屉，顶栏环境、主题、设置及连接状态自适应重排。导航触发按钮具备名称、aria-expanded、aria-controls，当前路由标记 aria-current。保留 Alerts/Deployments 既有深链接并清楚表示占位性质。
- **预计修改文件**：`apps/web/src/components/Shell.tsx`、`apps/web/src/components/navigation.ts`、`apps/web/src/App.tsx`、`apps/web/src/styles/index.css`；`apps/web/test/routing.test.tsx`、`apps/web/test/onboarding.test.tsx`、`apps/web/test/envPropagation.test.tsx`、`apps/web/test/apiAuth.test.tsx`；可新增聚焦抽屉交互的 `apps/web/test/shell.test.tsx`。
- **验收**：390×844、768×1024、1440×960 下导航及顶栏操作可达；抽屉支持 Escape、遮罩和选中路由关闭，关闭后恢复触发焦点；打开时管理焦点、背景不可交互，隐藏导航不保留可聚焦控件；改变窗口宽度不遗留遮罩或焦点锁。路由与浏览器前进/后退正常，环境切换和 API key 仅内存存储行为保持。200% 缩放不遮住关键操作。
- **前置依赖**：本文件 T1。

## T3 · 主题一致的 Display settings

- **工作**：将 Tweaks 面板硬编码米白配色和不受控层级替换为现有主题 token，显示为 Display settings；维持现有控件、React 状态与拖动能力，不新增设置持久化。面板受视口约束，内容必要时内部滚动，拖动不是访问设置的前提。统一其与导航抽屉的层级和焦点行为。
- **预计修改文件**：`apps/web/src/components/TweaksPanel.tsx`、`apps/web/src/components/Shell.tsx`、`apps/web/src/App.tsx`、`apps/web/src/styles/index.css`；`apps/web/test/tweaksPanel.test.tsx`、`apps/web/test/a11yTweaks.test.tsx`。
- **验收**：深/亮主题无独立异色背景；窄屏及缩放后全部控件可读可操作；键盘能够打开、使用并关闭，Escape 关闭后恢复设置按钮焦点；保留拖动监听清理及已有状态测试；关闭设置或切换断点无残留交互层。文案保持英文。
- **前置依赖**：本文件 T1、T2。

## T4 · 验证并交付共享接口

- **工作**：验证共享更改及行为回归，向协调器说明可供 02–05 使用的类、token、断点和容器约定；后续页面样式由页面直接 import，避免要求并行任务再编辑全局 CSS。
- **预计修改文件**：以上共享实现及测试；不修改 RunsList、TasksDashboard、Schedules 或 features/run 的业务实现。
- **验收**：从仓库根运行 `bun run --cwd apps/web typecheck`、`bun run --cwd apps/web lint`、`bun run --cwd apps/web test`、`bun run --cwd apps/web build` 并记录真实结果。新增测试聚焦抽屉焦点/关闭/断点切换和设置反馈，不为颜色/间距写脆弱快照。真实浏览器至少验证共享 shell 的三个主尺寸、双主题、两种密度和无页面水平溢出；必要文字对比度有测量依据。
- **前置依赖**：本文件 T1、T2、T3。
