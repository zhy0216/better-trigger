# P1-20 — connection 是模块级全局被多个轮询竞写;API key 被拒无反馈、输入即销毁

- 优先级:P1(可用性)
- 区域:web
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#20)

## 现状

- `apps/web/src/api/hooks.ts:24-46`:`let connection: Connection = 'connecting'` 模块级单变量;每个 poll 成功 `setConnection('live')`、失败 `recordConnectionError(e)`——last-writer-wins。`TasksDashboard.tsx:9-11` 一屏挂三个独立 2s 轮询(tasks/schedules/workers)同写这一个变量。
- `App.tsx:86-100`:`connection === 'unauthorized'` 时整个 screen 换成 `<ApiKeyPrompt>`;prompt 内部 `useState('')` 持有 token。提交 → `resetConnection()` → 状态变 connecting → prompt **卸载、token 销毁**;下一个 401 又挂回一个空白 prompt,文案与首次访问逐字节相同。
- 该 prompt 还是全英文界面里唯一的中文文案(`需要 API key` 等),且被 `smoke.test.tsx:131` 断言锁定。

## 影响

- 单个端点 500/429 把全局指示灯打成 Offline,2s 后又被别的端点翻回——频闪且误报 daemon 状态;反向:单个 401 把整个 app(包括正常渲染中的屏幕)换成 key 输入页。
- key 被拒与首次访问不可区分,用户每轮从头重打整串 token,无"key 被拒绝"信号(唯一线索是 prompt 背后 TopBar 的小圆点)。

## 实现方案

1. connection 聚合改为 keyed 注册表:每个 hook 实例带 id,记录 `{ ts, outcome: 'ok' | 'error' | 'unauthorized' }`;派生规则——窗口内(如 2×POLL_MS)**全部**为 error 才是 `down`;`unauthorized` 取全体最新 outcome;任一 ok 即 `live`。hook unmount 时注销条目。
2. key prompt 状态上提:`token` 与 `lastRejected` 放到 App 层(ternary 之上),prompt 卸载不丢;再次 401 时渲染"key 被拒绝,请换一个"变体文案,输入框保留内容并全选。
3. 文案统一为英文(与整个 dashboard 一致),同步更新 `smoke.test.tsx:131` 的断言。
4. 401 的呈现改为覆盖层(overlay)而非替换 screen,正常数据不被清屏(可选,若改动大则保持替换但确保 token/状态不丢)。

## 验收标准

- 测试:三个 hook 中一个持续 500、其余正常 → 聚合保持 live(或 degraded 单独展示),不闪 Offline;全部失败 → down。
- 测试:提交错 key → 再 401 → prompt 显示"rejected"变体且 token 仍在输入框。
- smoke 断言更新后全绿;界面语言统一。

## 涉及文件

- `apps/web/src/api/hooks.ts:24-46`、`:121-131`
- `apps/web/src/App.tsx:86-100`、`:156-180`
- `apps/web/test/smoke.test.tsx:131`、`apps/web/test/hooks.test.tsx`
