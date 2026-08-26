# P0-02 — Dashboard EnvSwitcher 只对 `/runs` 列表生效，其余视图 env 失效

- 优先级：P0（多环境功能坏一半）
- 区域：apps/web + apps/worker（namespace 解析）
- 状态：待办
- 来源：2026-08-26 全仓库审查

## 问题摘要

Dashboard 顶部 EnvSwitcher 切换 staging 后，只有 `api.runs` 带上了 env。`api.run`（详情）、`cancelRun`、`retryRun`、`tasks`、`schedules`、`workers` 都只发 `projectId=default`、不带 env；服务端 `namespaceFromQuery` 缺省回落 prod。净效果：切 staging → 列表显示 staging run → 点进去 404；非 prod run 的 Cancel/Retry 404；tasks/schedules/workers 三屏在 staging 下静默显示 prod 数据。`client.ts:177-180` 注释声称「env follows the TopBar's EnvSwitcher」——只有 `/runs` 实现了。

## 现状证据

- `apps/web/src/api/client.ts:183-216` — 各 api 方法只带 projectId 不带 env。
- `apps/web/src/api/hooks.ts:368-372` — useRun 等调用路径。
- `apps/worker/src/namespace.ts:42-48` — namespaceFromQuery 缺省回落 prod。
- `packages/kernel/src/runs.ts:2332` — kernel 按 `(project_id, env)` 过滤。

## 影响与不变量

- EnvSwitcher 选择的 env 必须贯穿所有读/控制调用，不能只覆盖列表。
- 详情/Cancel/Retry 必须与列表的 env 一致，否则 404 或操作错 run。
- 服务端缺省回落 prod 的既有语义保持不变（仅在未显式传 env 时）。

## 推荐实现方案

- 在 web api 层为所有读/控制调用（run 详情、cancel、retry、tasks、schedules、workers）透传 env；useRun / RunHeader / RunActions 从 App（或连接上下文）接 env。
- 复查所有 `projectId=default` 硬编码点，统一为「带 env」的 namespace 构造。
- 补 web 测试：切换 env 后，详情/Cancel/Retry 请求 URL 或 body 携带对应 env。

## 验收标准

- [ ] 切换 staging 后，详情/Cancel/Retry 使用 staging namespace，不再 404 / 操作错 run。
- [ ] tasks / schedules / workers 屏在 staging 下显示 staging 数据。
- [ ] 未显式传 env 的路径仍走服务端默认回落。
- [ ] `bun run typecheck`、`bun run build`、`bun run test` 全部通过。

## 涉及文件

- `apps/web/src/api/client.ts:183-216`
- `apps/web/src/api/hooks.ts`、`apps/web/src/App.tsx`、`RunView.tsx` 等
- `apps/web/src/api/adapter.ts`（如 namespace 构造集中在此）
- `apps/worker/src/namespace.ts:42-48`
