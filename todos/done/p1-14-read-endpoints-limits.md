# P1-14 — 读端点零限流;长轮询不感知客户端断连,waiter 挂满 30s

- 优先级:P1(可靠性/DoS 面)
- 区域:worker
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#14)

## 现状

- `apps/worker/src/rate-limit.ts:50-57` 的 `endpointOf` 对所有非 POST 返回 null——限流恰好只覆盖 `trigger | batch-trigger | retry | cancel` 四个端点。`GET /runs/:id/record`、`/runs/:id/result`、`/runs`、`/tasks`(cache miss)、`/schedules`、`/workers` 全部不入桶。
- `GET /runs/:id/result`(`routes/runs.ts:44-66`)每个请求先在**业务池**上打一条 `SELECT … FROM runs`(`waiters.ts:113-120`)再挂 waiter;全代码无 `c.req.raw.signal` 挂钩——客户端断开后 waiter 继续挂到 deadline(最长 `MAX_RESULT_WAIT_MS = 30s`),响应写向死 socket。

## 影响

文档支持的 `--host 0.0.0.0 --allow-unauthenticated` 部署下,`GET /api/v1/runs/<garbage>/result` 是每请求一次 DB 查询的放大器,与 claim 循环、心跳抢同一个(默认 10 连接的,见 p1-11)业务池——读风暴直接饿死执行。即使有 key,一个行为不端的客户端也能无界挂长轮询。`test/rate-limit.test.ts:173` 现在断言的是相反行为("leaves reads and the dashboard untouched")。

## 实现方案

1. `endpointOf` 增加读分类:GET 的 `/api/v1/*` 归入 `'read'` 桶(dashboard 静态资源与 `/health`、OPTIONS 继续豁免)。读桶用独立且宽松的默认值(建议 per-key 200/s、全局 1000/s、burst 2×),新 env `BETTER_TRIGGER_RATE_LIMIT_READ_RPS` / `_READ_GLOBAL_RPS`,0 可关;写桶参数与行为完全不变。
2. 长轮询挂接断连:`register` 之后 `c.req.raw.signal.addEventListener('abort', …)` → 立即释放该 waiter(registry 需要一个按 id 撤销的入口;sweep 照旧兜底)。注意先查 `signal.aborted` 已置位的情况。
3. `/runs/:id/result` 的入口 readRun 保持,但断连释放让"垃圾 runId 反复长轮询"的挂账时间从 30s 降到连接存活时长。
4. 更新 `rate-limit.test.ts:173` 那条断言(读不再"untouched",而是"loosely bucketed");README 网络姿态小节补读限流两个 env(接 p2-26)。

## 验收标准

- 测试:读端点超过读桶速率返回 `429 rate_limited`,写桶行为不变;`0` 关闭读桶后回到现状。
- 测试:发起 `GET /runs/:id/result` 后立即 abort 请求,断言 waiter 注册表条目在亚秒级被清理(暴露 registry size 或用测试探针),而不是等到 deadline。
- 审计日志对 429 与断连路径的记录符合现有格式。

## 涉及文件

- `apps/worker/src/rate-limit.ts:50-57`、config 段
- `apps/worker/src/routes/runs.ts:44-66`
- `apps/worker/src/waiters.ts:87-174`、`:211-215`
- `apps/worker/test/rate-limit.test.ts`、`apps/worker/test/waiters.test.ts`
- `apps/worker/README.md`、`.env.example`
