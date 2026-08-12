# P2-32 — 路由参数校验两套并存:同一 API 里 `?limit=abc` 是 400、`?timeoutMs=abc` 静默回落、`/runs?status=垃圾` 返回空页

- 优先级:P2(API 合同一致性)
- 区域:worker
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」worker #9)

## 现状

- `apps/worker/src/http.ts:78-90` 的 `intQuery`:非整数抛 `bad_request`,上限截断——`http.ts` 头注释明说这是为了防"垃圾输入读成空结果"。
- `apps/worker/src/routes/runs.ts:72-81` 的 `clampQuery`:垃圾输入**静默回落默认值**,两端钳制。同一 API 表面,两种合同。
- 枚举校验同样分裂:`GET /workers` 对 `?status=` 校验枚举、非法值 400(`dashboard.ts:482-485`);`GET /runs` 把 `?status=` 原样塞进 `status = $n`(`dashboard.ts:303`)——打错字返回空页,恰是头注释要防的失败形态。

## 实现方案

1. `intQuery` 增加选项 `{ onInvalid: 'throw' | 'clamp' }`(默认 throw),删除 `clampQuery`,`runs.ts` 各调用点显式选择语义(`timeoutMs`/`pollMs` 这类"宽容"参数用 clamp 也要显式写出)。
2. `GET /runs` 的 `status` 用与 `/workers` 相同的 `RunStatus` 枚举校验,非法值 `400 bad_request` 点名合法集合。
3. 顺手 grep 全路由的 query 解析点,统一到 `http.ts` 的两个入口;测试补:`/runs?status=bogus` → 400、`?timeoutMs=abc` 的显式语义用例。

## 验收标准

- `clampQuery` 不复存在;全路由 query 解析只经 `http.ts`。
- `/runs?status=bogus` 返回 400 而非空页;dashboard 现有调用(合法值)不回归。
- worker 路由测试全绿。

## 涉及文件

- `apps/worker/src/http.ts:78-90`
- `apps/worker/src/routes/runs.ts:72-81`、`apps/worker/src/routes/dashboard.ts:303,482-485`
- `apps/worker/test/`
