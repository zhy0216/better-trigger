# P2-26 — 配置知识碎片化:24+ 个 env 旋钮散落四处,两个生产级旋钮无处记载

- 优先级:P2(运维 DX,防再漂移的机制性修复)
- 区域:worker / kernel / docs
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#10-worker、#13-web)

## 现状

交叉核对代码里全部 `BETTER_TRIGGER_*` 读取 vs `--help`(`main.ts:109-155` 的 Env 块)、`apps/worker/README.md`、`.env.example`:

- **代码读、任何文档都没有**:`BETTER_TRIGGER_MAX_RECOVERIES`(`kernel/runs.ts:217`——基础设施重试预算,contract §3.5 的生产级旋钮)、`BETTER_TRIGGER_LOG_MESSAGE_MAX_BYTES`(`kernel/runs.ts:205`)。
- **README 有、`--help` 没有**(8 个):`STATS_TTL_MS`、`ERROR_MAX_BYTES`、`LOG_BATCH_MAX_BYTES`、`LOG_DATA_MAX_BYTES`、`STEP_OUTPUT_MAX_BYTES`、`RUN_OUTPUT_MAX_BYTES`、`MAX_BATCH_PAYLOAD_BYTES` 等。
- **`--help` 有、worker README/.env.example 没有**:`BETTER_TRIGGER_NAMESPACES`。
- **`.env.example` 只覆盖 8/25**,且恰好缺全部四个网络姿态旋钮(`HOST` / `ALLOW_UNAUTHENTICATED` / `CORS_ORIGIN` / `NAMESPACES`)与 `VITE_BT_API_KEY`。

## 影响

`--help` 是容器里唯一能看的参考,却对 14/24 个旋钮沉默;`MAX_RECOVERIES` 改变终态行为却完全不可发现;`cp .env.example .env` 的新用户拿不到离线部署最需要的四个姿态旋钮。每加一个 env 读取,漂移面自动 +1。

## 实现方案

1. 建单一来源表:`apps/worker/src/env-registry.ts` 导出 `[{ name, default, help, category }]`,覆盖 worker + kernel 读取的全部 `BETTER_TRIGGER_*`(kernel 的两个由 worker 侧代注册)。
2. `USAGE` 的 Env 块从表渲染(按 category 分组:core / network posture / limits / rate limit / tuning)。
3. 防再漂移测试:测试里 grep `packages/ apps/worker` 源码中的 `process.env.BETTER_TRIGGER_` 读取点,断言每个名字都在表里(反向亦然,防死条目)。
4. `.env.example` 重写:按 category 分组,network posture 四件套 + `VITE_BT_API_KEY` 补齐;字节上限类给一行指向 `apps/worker/README.md#request-limits` 而不是全量罗列。
5. worker README 的 env 表核对至与 registry 一致(手工一次;后续靠第 3 步测试兜住新增项)。
6. 本轮新增的 env(p1-07 `MAX_STEPS`、p1-11 `POOL_MAX` 等、p1-13、p1-14)全部走 registry 落地——本文件建议排在它们之后收口。

## 验收标准

- 新测试:代码读取集合 == registry 集合,双向无差集。
- `--help` 输出含全部旋钮且按组展示;`MAX_RECOVERIES`、`LOG_MESSAGE_MAX_BYTES` 在 `--help` 与 README 都可见。
- `.env.example` 含网络姿态块;`bun run build` 后 `better-trigger-worker --help` 冒烟通过(O4 的 release smoke 已在 CI)。

## 涉及文件

- `apps/worker/src/main.ts:109-155`、新建 `apps/worker/src/env-registry.ts`
- `packages/kernel/src/runs.ts:205,217`(读取点不变,仅注册)
- `.env.example`、`apps/worker/README.md`
- `apps/worker/test/`(新增 env-registry.test.ts)
