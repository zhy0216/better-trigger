difficulty: medium

# 08 · web 健壮性 / 性能 / a11y

覆盖 `apps/web` 的 API 客户端、RunView、基础组件、入口与各屏幕（Schedules 除外，见 09）。与 09 文件不相交，可并行。

## T1 · 请求超时，防止挂起请求杀死轮询（P1）

- 做什么：`api/client.ts:94-104` `request()` 裸 `fetch` 无超时（signal 只在卸载/换 key 时触发）；`hooks.ts:213-240` `usePoll` 自续期——当前请求不 settle，下一 tick 永不排程：daemon 接受连接但不响应时，该端点永久停轮询，UI 冻结，连接状态也不回退（`recompute()` 的 `stale` 分支只在有事件时被评估）。给 `request()` 加超时（如 `AbortSignal.any([signal, AbortSignal.timeout(10_000)])`），超时归类为普通轮询错误进入既有错误/连接处理路径。
- 预计文件：`apps/web/src/api/client.ts`、`apps/web/src/api/hooks.ts`（如需）、`apps/web/test/`。
- 验收：模拟永不响应的 fetch → 超时后错误被记录、下一轮照常排程；既有轮询测试全绿。
- 前置依赖：无。

## T2 · Ruler tick 按跨度抽稀（P1）

- 做什么：`features/run/RunView.tsx:125-128` `for (let ms = 0; ms <= totalMs; ms += 1000)` 每秒一个绝对定位 div、无上限：1h run → 3600 div；`wait.for("24h")` 的 run 趋向 86400 div，且每 2s 轮询重渲染（非终态 `totalMs` 随墙钟增长，`adapter.ts:283-285`）。按 `totalMs` 选 tick 步长（1s/5s/30s/5m…）使 tick 总数 ≤ ~60，标签格式随步长调整。
- 预计文件：`apps/web/src/features/run/RunView.tsx`、`apps/web/test/`。
- 验收：`totalMs` = 1min/1h/24h 时 tick 数均有界（测试断言 ≤ 上限）；短 run 刻度观感不变。
- 前置依赖：无。

## T3 · 渲染热路径小修（P2）

- 做什么：
  - `RunView.tsx:194` 每个 SpanRow 渲染时 `getComputedStyle(document.documentElement).getPropertyValue('--span-h')` 强制样式解析——该值运行期不变，提升到模块级读一次（或按 `vizStyle`/density memo）。
  - `components/primitives.tsx:265-278` Sparkline：单点趋势 `data.length - 1` 除零 → 全 `NaN` 坐标；空数组 `Math.min(...[])` = `Infinity`。`data.length < 2` 早返回平直基线（或 null）。
  - `RunView.tsx:372` "Load older logs" 用 `<Icon name="chevronUp">`，但 `primitives.tsx:11-52` `ICONS` 无 `chevronUp` → 渲染空 svg。补 `chevronUp` 图标；加一个图标名健全性测试（所有被引用的名字 ⊆ `ICONS`，`smoke.test.tsx` 已走过该按钮却没断言内容）。
- 预计文件：`apps/web/src/features/run/RunView.tsx`、`apps/web/src/components/primitives.tsx`、`apps/web/test/`。
- 验收：渲染期不再逐行 `getComputedStyle`；0/1 点趋势渲染合法；chevronUp 可见且图标健全性测试通过。
- 前置依赖：无。

## T4 · SpanRow 键盘可达 + 日志稳定 key（P2）

- 做什么：
  - `RunView.tsx:163-171` SpanRow 是 `<div onClick>`，无 role/tabIndex/键盘处理——键盘用户完全够不到 Inspector。按 `components/Layout.tsx:23-54` `Card` 的既有模式：button 或 `role="button"` + `tabIndex={0}` + Enter/Space。
  - `RunView.tsx:388-389` 日志行用 `key={i}`，"Load older logs" 向前插页使全部 key 位移、整列表重协调。日志记录带稳定 `id`（`hooks.ts:477-479` 去重就用它），把它带进 `LogEntry` 并用作 key。
- 预计文件：`apps/web/src/features/run/RunView.tsx`、`apps/web/src/api/hooks.ts`（LogEntry 类型）、`apps/web/test/`。
- 验收：键盘可聚焦并选中 span（测试）；前插旧日志后既有行的 DOM 节点复用（或以 key 断言）。
- 前置依赖：无。

## T5 · 错误边界（P2）

- 做什么：`main.tsx:11-15` 无 error boundary——一个坏负载（如畸形 run detail 使 `adaptRunDetail` 崩）整屏白屏。用最小错误边界包住 `App`（或逐屏），渲染既有 `ErrorState` + reload 按钮。
- 预计文件：`apps/web/src/main.tsx`（或新组件 + `App.tsx`）、`apps/web/test/`。
- 验收：子树抛错时渲染错误态而非白屏（测试）。
- 前置依赖：无。

## T6 · TasksDashboard 次级错误与死 prop（P2）

- 做什么：`screens/TasksDashboard.tsx:10-18` 只消费 `useTasks` 的 error；`/workers`、`/schedules` 失败时统计卡静默显示 `—`。声明的 `onOpenRun`（`:10`，App.tsx:124 传入）从未被用——点任务卡跳未过滤 runs 列表。修法：展示次级 hook 错误（至少每卡弱错误态）；`onOpenRun` 要么接到按任务过滤的 runs 视图、要么连 prop 一起删（二者择一，选实现代价小的并在 commit 说明）。
- 预计文件：`apps/web/src/screens/TasksDashboard.tsx`、`apps/web/src/App.tsx`（如删 prop）、`apps/web/test/`。
- 验收：workers/schedules 失败时 UI 有指示；无未使用 prop。
- 前置依赖：无。

## T7 · Onboarding 命令与剪贴板健壮性（P2）

- 做什么：`screens/Onboarding.tsx:28` 第 3 步给 `bunx --bun better-trigger-worker --tasks ./tasks.ts`——新项目只装了 `better-trigger`（SDK），`bunx` 找不到本地 bin 会去拉不存在的同名注册表包；README.md:76 与 apps/docs quick-start 正确写法是 `bunx --bun @better-trigger/worker`。改 `CODE_DAEMON`。`:44-50` `copy()` 裸 `.then` 无 `.catch`，非安全上下文 `navigator.clipboard` 为 undefined → 未处理 rejection/TypeError；加兜底 + catch。
- 预计文件：`apps/web/src/screens/Onboarding.tsx`、`apps/web/test/`。
- 验收：命令文本为 `@better-trigger/worker`；clipboard 不可用/拒绝时无未处理 rejection（测试）。
- 前置依赖：无。

## T8 · RunsList 工具栏 aria（P2）

- 做什么：`screens/RunsList.tsx:57-77` 七个状态过滤按钮与 Live/Paused 开关的选中态只有视觉表达——补 `aria-pressed={filter === f.id}` / `aria-pressed={live}`，过滤组加 `role="group"` + `aria-label="Status filter"`。
- 预计文件：`apps/web/src/screens/RunsList.tsx`、`apps/web/test/`。
- 验收：a11y 测试断言 aria-pressed 随状态翻转。
- 前置依赖：无。

## 本文件验证

`bun run typecheck && bun run lint && bun run build && bun run test`（web 单测 + 必要的组件测试）。
