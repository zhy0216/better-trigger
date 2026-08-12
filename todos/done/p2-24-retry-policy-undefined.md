# P2-24 — `resolveRetryPolicy` 让显式 `undefined` 覆盖默认值,变成不透明 500

- 优先级:P2(正确性边角,常见配置模式踩中)
- 区域:core / kernel
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」P2)

## 现状

`packages/core/src/backoff.ts:7-9`:

```ts
return { ...DEFAULT_RETRY, ...(policy ?? {}) };
```

repo 的 tsconfig 是 `strict` 但没开 `exactOptionalPropertyTypes`,所以 `retry: { maxAttempts: cfg.max }` 在 `cfg.max` 为 `undefined` 时通过类型检查,展开合并产出 `maxAttempts: undefined` **覆盖**默认值 3。该值流到 `kernel/runs.ts:577,627` 插入 NOT NULL 的 `runs.max_attempts`。

`core/test/backoff.test.ts:16` 测了部分合并,没测显式 undefined。

## 影响

常见模式 `retry: { maxAttempts: process.env.MAX ? Number(process.env.MAX) : undefined }` 让该 task 的**每次 trigger** 变成 NOT NULL 违反 → 不透明的 `500 internal_error`,而不是回落默认值。

## 实现方案

1. `resolveRetryPolicy` 改为逐字段 `??` 合并:`{ maxAttempts: policy?.maxAttempts ?? DEFAULT_RETRY.maxAttempts, baseMs: …, maxMs: …, factor: …(按实际字段) }`——显式 undefined 与缺省同义。
2. 回归测试:显式 `undefined` 各字段 → 得到默认值;`0`/负值等边界维持现有校验行为。
3. (可选,独立小改)评估给 root tsconfig 开 `exactOptionalPropertyTypes` 的成本;若代价大,只在本函数消化即可。

## 验收标准

- 新增用例:`resolveRetryPolicy({ maxAttempts: undefined })` 等于默认;trigger 带该形状不再 500(kernel stub 测试断言插入值为 3)。
- 全量 `bun run test` 绿。

## 涉及文件

- `packages/core/src/backoff.ts:7-9`
- `packages/core/test/backoff.test.ts`
- `packages/kernel/src/runs.ts:577,627`(行为参照)
