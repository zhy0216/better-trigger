# P1-18 — dashboard 没有任何 URL 路由:daemon 端的 SPA deep-link fallback 没有消费者

- 优先级:P1(可用性,README 承诺与实现脱节)
- 区域:web
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#18)

## 现状

`apps/web/src/App.tsx:33-37`:导航是 `useState<Route>('runs')` + `useState<string | null>(runId)`,全仓 grep `window.location|history.pushState|location.pathname|popstate` 零命中。而 O3 在 daemon 侧精心实现了 SPA fallback(`apps/worker/src/static.ts:249-259`),README(`:90-93`)承诺"书签的 `/runs/...` URL 刷新回 dashboard 而非 404"。

## 影响

`/runs/abc` 确实回到 shell——然后渲染 Runs 列表,书签的 run 被静默丢弃。没有任何页面/run 可寻址:无后退键、无可分享链接("把这个失败 run 的链接发给同事"做不到)。服务端 extension-vs-fallback 的谨慎逻辑在客户端一无所获。

## 实现方案

约 20 行,不引入路由库:

1. 定义路径映射:`/`→runs、`/runs`→runs、`/runs/:id`→run detail、`/tasks`、`/schedules`、`/workers`、`/onboarding`。
2. mount 时解析一次 `location.pathname` 播种 `route`/`runId`;未知路径落 runs(与现状一致)。
3. 导航处(setRoute/setRunId 的调用点)同步 `history.pushState`;监听 `popstate` 反向驱动 state,后退/前进可用。
4. 打开 run detail 用 `/runs/<id>`,关闭回 `/runs`。
5. 测试:jsdom 用例——以 `/runs/xyz` 初始 history 渲染 App,断言直接进 detail 且请求了该 run;pushState/popstate 往返一致。

## 验收标准

- 刷新 `/runs/<id>` 直接回到该 run 的 detail(daemon 托管模式手工验证)。
- 浏览器后退从 detail 回列表;前进复原。
- README 的 deep-link 句子成为事实(无需改文案)。
- 现有 web 测试全绿。

## 涉及文件

- `apps/web/src/App.tsx:33-37`(及各导航调用点)
- `apps/web/test/`(新增路由用例)
- `apps/worker/src/static.ts:249-259`(行为参照,不改)
