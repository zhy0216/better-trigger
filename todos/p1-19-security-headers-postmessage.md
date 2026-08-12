# P1-19 — daemon 托管的 dashboard 无任何安全响应头;TweaksPanel 接受任意 origin 的 postMessage

- 优先级:P1(安全,网络姿态的唯一缺口)
- 区域:worker / web
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#19)

## 现状

- `apps/worker/src/static.ts:196-203` 的 `serveFile` 只发 `Content-Type` / `ETag` / `Cache-Control` / `Content-Length`;全 worker 源码 grep `X-Frame-Options|frame-ancestors|Content-Security-Policy|nosniff` 零命中。
- `apps/web/src/components/TweaksPanel.tsx:154-163`:`onMsg` 处理 `__activate_edit_mode` 等消息**不检查 `e.origin`**;`useTweaks.ts:23` 还向 `window.parent` 用 `'*'` 发消息。`apps/web/README.md` 已把这套宿主协议记为 dead。

## 影响

任意源可以 iframe daemon 托管的 dashboard → 对既有写操作(`Schedules.tsx:21` 的 enable/disable,p2-33 接上 cancel/retry 后更多)构成点击劫持面;无 CSP 意味着零纵深。未鉴权的 message 监听是 framing 页可驱动的休眠钩子。这是 O6 之后网络姿态(timing-safe key 比较、loopback CORS、body limit、限流)上仅剩的缺口。

## 实现方案

1. `serveFile` 的响应头统一加:
   - `X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'`(只用 frame-ancestors 指令,不上完整 CSP——避免误伤 Vite 产物的 inline 资源,后续可再收紧);
   - `X-Content-Type-Options: nosniff`;
   - `Referrer-Policy: no-referrer`。
2. TweaksPanel 的宿主协议按 README 所记已死:直接删除 message 监听与 `useTweaks` 的 postMessage 出口(保留面板 UI 本身);如仍想保留开发期入口,用 `import.meta.env.DEV && e.origin === location.origin` 双守卫。
3. `apps/worker/test` 的 static 测试断言四个头在 HTML 与资产响应上都存在(注意 immutable 资产路径同样要带)。

## 验收标准

- `curl -sI localhost:4848/` 与任一 hashed 资产可见四个新头。
- dashboard 功能不回归(样式、脚本正常加载——nosniff 下 MIME 必须精确,现有 Content-Type 映射需覆盖全部资产类型)。
- grep 确认 web 源码不再有无 origin 校验的 message 监听。

## 涉及文件

- `apps/worker/src/static.ts:196-203`
- `apps/web/src/components/TweaksPanel.tsx:154-163`、`apps/web/src/hooks/useTweaks.ts:23`
- `apps/worker/test/static.test.ts`(或等价文件)
