# P1-07 — schema.ts 自称 single source of truth 但只对 migration 成立，kernel 手写契约无编译期保护

- 优先级：P1（Schema 漂移防护）
- 区域：packages/db + packages/kernel
- 状态：待办
- 来源：2026-08-26 全仓库审查

## C1 · kernel 手写行类型/约束名，schema 改列名无保护 {#c1}

### 问题摘要

`db/src/schema.ts` 自称 "SINGLE SOURCE OF TRUTH"，但只对 migration 成立。kernel 手写 snake_case 行类型（RunRow 等）和硬编码 pg 约束名（依赖 63 字节截断），schema 改列名/约束名没有任何编译期保护。`DbRun` 等 `$inferSelect` 导出无人使用。

### 现状证据

- `packages/db/src/schema.ts` — 头部 "SINGLE SOURCE OF TRUTH" 声称。
- `packages/kernel/src/runs.ts:401-426` — 手写 RunRow。
- `packages/kernel/src/runs.ts:484-485` — 硬编码约束名。
- `packages/db/src/schema.ts:455-463` — DbRun 等无人使用。

### 影响与不变量

- 不加 Drizzle 查询（该决策正确，kernel 需 raw SQL 精确语义）；但隐式契约必须变成会失败的测试。
- schema 列名/约束名变更应被 CI 捕获。

### 推荐实现方案

- 在 kernel 真 PG 测试里加 `information_schema` 漂移探针：比对 schema.ts 与运行库的表/列/约束，不一致即失败。
- 删除或标注 `$inferSelect` 导出为「仅供 schema 内部/migration 使用」。

## C2 · 8 个空 migration 文件 {#c2}

### 问题摘要

`db/migrations/` 下 0004/0005/0006/0008/0009/0012/0013/0014 是 0 字节空文件，journal 噪音，易误导读者以为内容丢失。

### 现状证据

- `packages/db/migrations/` — 8 个 0 字节文件。

### 推荐实现方案

- 留一行 `-- no-op` 注释，或删除并 renumber（需同步 journal 与 check-drift，风险评估后选保守方案：加注释）。

## 验收标准

- [ ] 漂移探针测试在真 PG 下通过，且能在 schema 改动时失败。
- [ ] 空 migration 有明确注释或已清理，journal 一致。
- [ ] `bun run typecheck`、`bun run build`、`bun run test`、`bun run check:drift` 全部通过。

## 涉及文件

- `packages/db/src/schema.ts:455-463`
- `packages/kernel/src/runs.ts:401-426,484-485`
- `packages/kernel/test/pg/`
- `packages/db/migrations/`
