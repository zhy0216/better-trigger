# P2-19 — sdk/web 低挂果（第二轮）：类型洞、死面板、无障碍、监听器泄漏

- 优先级：P2（类型安全 / 可用性打磨）
- 区域：packages/sdk、apps/web
- 状态：已完成（2026-09-02）
- 来源：2026-09-02 全仓库审查（第二轮）

## C1 · 实例级 `batchTrigger` per-item `env/projectId` 是静默丢弃的类型洞 {#c1}

### 问题摘要

实例级 `batchTrigger` 的 item 类型是 core `TriggerItem`，其 options 为完整
`TriggerOptions`（含 `env`/`projectId`），但服务端只取批级 namespace——per-item
namespace 会被静默丢弃（「staging 意图静默落到 prod」）。`TaskHandle` 路径已用
`BatchItemOptions = Omit<TriggerOptions,'env'|'projectId'>` 修掉，实例级 API 遗漏。

### 现状证据

- `packages/sdk/src/instance.ts:101,366-372`；`packages/core/src/types.ts:155-159`。
- 对照：`packages/sdk/src/task.ts:42`（已收窄）。

### 推荐实现方案

- 给实例级 `batchTrigger` 的 item options 用同一收窄类型；不改运行时行为。

## C2 · TweaksPanel 永远不可达：`vizStyle`/density/accent 是死控制 {#c2}

### 问题摘要

`TweaksPanel` 的 `open` 初始 `false` 且没有任何入口能打开它；`App.tsx` 渲染了
全部控件（含 RunView 的 `tree` 视图、density、accent），但成品里永远不可切换。
README 自己也承认「no built-in toggle」。

### 现状证据

- `apps/web/src/components/TweaksPanel.tsx:125`（`open` 初始值）、`:184`（不 open
  直接 return null）；`apps/web/src/App.tsx:168-178`（渲染但无入口）。

### 推荐实现方案

- 把 `open` 状态提到 `App`（或既有持久化 tweaks 的机制），在 TopBar 加一个打开/
  收起按钮；保持面板默认收起。

## C3 · 多个交互元素仅鼠标可用（无障碍） {#c3}

### 问题摘要

- `Switch` 是无角色、不可聚焦的 `<div onClick>`——键盘用户无法切换 schedule 开关；
- Runs 行 / 任务卡片是可点击 `<div>`，无 `role`/`tabIndex`/键盘事件；
- `EnvSwitcher` 无 `aria-expanded`、无 Esc 关闭、无焦点管理；
- `TweaksRadio` 的按钮没有 `onClick`，只能指针拖拽改值。

### 现状证据

- `apps/web/src/components/primitives.tsx:208-225`（Switch）；
  `apps/web/src/features/runs/RunsList.tsx:88-94`、`apps/web/src/components/Layout.tsx:27-38`；
  `apps/web/src/components/Shell.tsx:79-113`（EnvSwitcher）；
  `apps/web/src/components/TweaksPanel.tsx:296-307`（TweaksRadio）。

### 推荐实现方案

- 换成真实 `<button>`（首选）或补 `role` + `tabIndex` + Enter/Space 键盘事件；
  EnvSwitcher 补 `aria-expanded` 与 Esc 关闭。只改交互语义，不改视觉。

## C4 · TweaksPanel 拖拽监听器在卸载时泄漏 {#c4}

### 问题摘要

拖拽/scrub 的 window 级监听器只在指针抬起时移除；组件在拖拽中卸载会短暂泄漏
监听器并持有已卸载组件的闭包。

### 现状证据

- `apps/web/src/components/TweaksPanel.tsx:161-182,278-294,348-364`。

### 推荐实现方案

- 在对应 effect 的 cleanup 中兜底移除监听器。

## 验收标准

- [ ] `bun run typecheck`、`bun run build`（含 apps/web）通过，相关单测通过。
- [ ] 手动验证：TweaksPanel 可打开/收起；键盘可切换 schedule 开关、打开
  EnvSwitcher 并用 Esc 关闭；实例级 `batchTrigger` 的 item options 类型不再含
  `env`/`projectId`。

## 涉及文件

- `packages/sdk/src/instance.ts`、`packages/core/src/types.ts`（如需）、
  `apps/web/src/components/TweaksPanel.tsx`、`primitives.tsx`、`Shell.tsx`、
  `Layout.tsx`、`apps/web/src/features/runs/RunsList.tsx`、`apps/web/src/App.tsx`
