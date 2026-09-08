difficulty: hard
agent: inherit

# 重放指纹 canonicalization 一致性

对应 F5–F6。优先级 P1。依赖：02-core-json-error-boundaries.md 合入。必须先读 plan 的 fingerprint 兼容风险，不能全量改版本来绕过回归。

## T1 · 统一 canonical JSON 行为

- 要做什么：消除 `packages/kernel/src/fingerprint.ts` 与 core 的重复但不一致实现，复用 02 的语义或建立明确的共同边界；保留 fnSourceHash、StepFingerprintArgs、v1 和普通输入的结果。明确 BigInt 等本来不会合法持久化的值如何失败/保持原边界。
- 预计修改：`packages/kernel/src/fingerprint.ts`，必要的 core 共享导出；`packages/kernel/test/steps-fingerprint.test.ts` 或新增同目录 canonicalization 测试。
- 验收：toJSON self-return 终止且不会重复调用同一值；含自有 `__proto__` 的有效输入与缺少该字段的输入 fingerprint 不同；键顺序变化、普通 JSON 的 pg roundtrip、已有 codeVersion/label/kind 输入 golden vectors 不变。循环和非法输入不会形成无限 CPU 循环。
- 前置依赖：02 的 T1/T2。

## T2 · 验证 durable 调用的持久化与回放

- 要做什么：检查 executor、child trigger 与 ledger writer 对 payload/fingerprint 的使用，加入能穿过真实持久化边界的回归。旧账本必须只读比较，不能修改以迎合新指纹。
- 预计修改：`packages/kernel/test/steps-fingerprint.test.ts`、`packages/kernel/test/serialization.test.ts`、`packages/kernel/test/pg/` 中相关回归；`apps/worker/test/executor-serialization.test.ts`，必要的 `apps/worker/src/executor.ts` 适配。
- 验收：合法特殊键 payload 经保存和 replay 保留语义；自返回 toJSON 不让 task 挂死；普通已有 ledger replay 不漂移，输入真实改变仍触发 NonDeterminismError；常规失败能正常报告。说明以前被误表示的特殊输入会如何被识别，不宣称无条件向后兼容。
- 前置依赖：本文件 T1。

验证：core tests、kernel 指纹/serialization 测试、worker executor serialization 回归、独占 PG 的相关测试；运行现有 `bun run --cwd examples/basic replay-drift` 与 `bun run --cwd examples/basic e2e`，然后完整仓库 gate。需要隔离 PG，按 README 创建并清理。一个最终任务 commit。
