difficulty: medium

# 09 · web Schedules 乐观状态对账

只动 `apps/web/src/screens/Schedules.tsx` 及其测试，与 08 文件不相交，可并行。

## T1 · 乐观覆盖成功后清除（P1）

- 做什么：`screens/Schedules.tsx:15-34` 的 `overrides` 只写不清：成功切换后覆盖永久留在 map 里，其后每轮轮询都把陈旧的本地值盖在服务端数据上——若 `enabled` 之后被服务端改变（其他操作员、CLI、另一标签页），本标签永久展示并反复重申旧值；且后续失败回滚用的 `cur.enabled` 取自覆盖而非服务端真值。修法：轮询数据到达且与某覆盖一致时删除该覆盖（在 `data` 的 effect 里对账）。
- 预计文件：`apps/web/src/screens/Schedules.tsx`、`apps/web/test/`。
- 验收：成功切换后，一次轮询返回同值即清除覆盖；此后服务端变更能如实显示；新增测试钉住对账时序。
- 前置依赖：无。

## T2 · 并发点击串行化（P2）

- 做什么：`Schedules.tsx:20-34` 两次快速切换发出两个无序号 `PATCH`；第一个晚到的失败会按第一次点击时捕获的 `cur.enabled` 回滚，覆盖第二个开关的乐观态，而第二个请求可能在服务端成功 → UI 与服务端不一致。按 schedule id 串行化（每 id 至多一个在途请求，排队或 last-write-wins + 序号检查），失败回滚以最近一次服务端确认值为基准。
- 预计文件：`apps/web/src/screens/Schedules.tsx`、`apps/web/test/`。
- 验收：快速双切换（首败次成）的最终 UI 与服务端一致；新增并发时序测试。
- 前置依赖：T1（同文件，串行实现）。

## T3 · Switch 可访问名（P2）

- 做什么：`Schedules.tsx:82` 的 `Switch` 是 `role="switch"` 但无 label/aria-label，行文本未与之关联。加 `aria-label`（含任务名）。
- 预计文件：`apps/web/src/screens/Schedules.tsx`、`apps/web/test/`。
- 验收：可访问名断言通过。
- 前置依赖：T1（同文件）。

## 本文件验证

`bun run typecheck && bun run lint && bun run build && bun run test`。
