# P1-06 — Dashboard 终态 run 永久轮询 + 不感知可见性；loadMore 吞错、动作 401 不进连接注册表

- 优先级：P1（资源浪费 + 错误处理）
- 区域：apps/web
- 状态：待办
- 来源：2026-08-26 全仓库审查

## C1 · 终态 run 永久 2s 轮询 {#c1}

### 问题摘要

`useRun` 对终态 run 也永久 2s 轮询；终态 run 不可变（retry 产生新 id），挂着的 tab 每小时 ~1800 次无意义请求。

### 现状证据

- `apps/web/src/api/hooks.ts:368-373` — useRun 轮询无终态判断。

### 推荐实现方案

- run 进入终态（completed/failed/canceled）后停止轮询。

## C2 · 轮询不感知页面可见性 {#c2}

### 问题摘要

所有 poll 不感知页面可见性，后台 tab 持续请求。

### 现状证据

- `apps/web/src/api/hooks.ts` — promise-settle 复用轮询，无 visibilitychange。

### 推荐实现方案

- `visibilitychange` 隐藏时暂停/降频，恢复可见时立即补一次。

## C3 · loadMore/loadOlderLogs 吞错；动作 401 不进连接注册表 {#c3}

### 问题摘要

`loadMore`/`loadOlderLogs` 静默吞错返回 false，「失败」与「没有更多」不可区分；动作调用的 401 只弹内联错误、不进连接注册表，被轮询 401 掩盖。

### 现状证据

- `apps/web/src/api/hooks.ts:330-332,407-409` — 吞错返回 false。
- `apps/web/src/api/hooks.ts:135-137`、`RunView.tsx:66-71` — 动作 401 未 recordConnectionError。

### 推荐实现方案

- 暴露 error 态或短暂提示，区分「失败」与「没有更多」。
- 动作 401 时调用 recordConnectionError 统一处理。

## 验收标准

- [ ] 终态 run 停止轮询；后台 tab 降频。
- [ ] loadMore 失败可区分于「没有更多」。
- [ ] 动作 401 进入连接注册表流程。
- [ ] `bun run typecheck`、`bun run build`、`bun run test` 全部通过。

## 涉及文件

- `apps/web/src/api/hooks.ts:330-373,407-409`
- `apps/web/src/api/client.ts`
- `apps/web/src/RunView.tsx:66-71`
