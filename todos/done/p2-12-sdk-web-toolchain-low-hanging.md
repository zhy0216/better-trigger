# P2-12 — sdk/web/toolchain 低挂果：SDK_VERSION 硬编码、env 剥离、AbortSignal、timeoutMs、死代码、env.example

- 优先级：P2（正确性/可维护性打磨）
- 区域：packages/sdk + apps/web + .env.example
- 状态：待办
- 来源：2026-08-26 全仓库审查

## C1 · `SDK_VERSION` 硬编码且测试同样硬编码 {#c1}

### 问题摘要

`SDK_VERSION = '0.1.0'` 硬编码，注释要求与 package.json 同步，但测试同样硬编码而非读 package.json——版本升级会两边一起静默漂移，重复副本检测的版本告警失效。

### 现状证据

- `packages/sdk/src/registry.ts:29`、`packages/sdk/test/registry.test.ts:23`。

### 推荐实现方案

- 测试从 package.json 读版本，或构建期生成常量。

## C2 · durable batchTrigger 的 per-item options 未剥离 env/projectId {#c2}

### 问题摘要

持久路径 batchTrigger 的 per-item options 未做 env/projectId 剥离（单发 trigger 有 stripIgnoredNamespace）。TS 上 BatchItemOptions 已 Omit，但非类型调用方的 per-item env 会进入 durable step fingerprint——正是 stripIgnoredNamespace 注释描述的 replay drift。

### 现状证据

- `packages/sdk/src/task.ts:314-330`（对比 :301）。

### 推荐实现方案

- durableBatchTrigger 前对每个 item options 过一遍 stripIgnoredNamespace。

## C3 · 重试退避 sleep 不感知 AbortSignal {#c3}

### 问题摘要

重试间 sleep() 不感知调用方 AbortSignal，退避期间 abort 要等 sleep 结束（上限 2s）才生效。

### 现状证据

- `packages/sdk/src/instance.ts:429-431`。

### 推荐实现方案

- sleep 支持 signal 或醒后检查。

## C4 · `timeoutMs` 未校验 {#c4}

### 问题摘要

timeoutMs 未校验：0/负/NaN → 定时器立即触发 → 所有请求瞬间 timeout 且报错误导。

### 现状证据

- `packages/sdk/src/client.ts:133-136`。

### 推荐实现方案

- 构造时校验，非法值早抛。

## C5 · useTweaks 的 `tweakchange` 死代码 {#c5}

### 问题摘要

`tweakchange` CustomEvent 全仓库无订阅者，头注释仍描述监听者——宿主协议移除后的死代码。

### 现状证据

- `apps/web/src/hooks/useTweaks.ts:23`。

### 推荐实现方案

- 删 dispatch 或修注释。

## C6 · `.env.example` 的 `VITE_BT_API_URL` 未注释 {#c6}

### 问题摘要

`VITE_BT_API_URL=http://localhost:4848` 未注释而文件头让 `cp .env.example .env`；若它随根 .env 进入生产 build，会把 dashboard 钉死 localhost:4848，违背同源设计；VITE_BT_API_KEY 是注释掉的，这条应同样处理。

### 现状证据

- `.env.example:145`。

### 推荐实现方案

- 注释掉该行。

## 验收标准

- [ ] 每项改动后 `bun run typecheck`、`bun run build`、`bun run test` 全部通过。

## 涉及文件

- `packages/sdk/src/registry.ts:29`、`task.ts:314-330`、`instance.ts:429-431`、`client.ts:133-136`
- `packages/sdk/test/`
- `apps/web/src/hooks/useTweaks.ts:23`
- `.env.example:145`