difficulty: medium
agent: inherit

# JSON 数据保真与错误边界

对应 F2–F4。优先级 P1。前置依赖：无。只处理 core 的序列化和诊断，不改 kernel fingerprint；后者交给依赖本任务的 03。

## T1 · 保留 JSON 值语义

- 要做什么：修复 `canonicalizePlain` 的自有特殊键丢失；梳理 canonicalize 对 boxed primitive、Date、数组、toJSON(key) 的处理，既按 JSON.stringify 的值语义转换，也递归稳定排序。toJSON 返回自身不能无限重入。
- 预计修改：`packages/core/src/serialize.ts`、`packages/core/test/serialize.test.ts`；必要时新增 core 内部 helper 并调整 `packages/core/src/index.ts`，方便 03 复用。不能引入运行时依赖。
- 验收：JSON.parse 创建的 `__proto__` 等自有键完整保留，原型不变；boxed Number/String/Boolean、root/对象属性/数组位置的 toJSON key、self-return、Date、循环引用和非 JSON 值均有明确结果。普通嵌套 JSON 的原有 canonical 字节不变，Unicode 字节数和 maxBytes 限制仍准确。
- 前置依赖：无。

## T2 · 诊断路径本身不得再次抛错

- 要做什么：防护 `serializeError` 中 Error 属性访问、String/JSON 转换，以及 `safeSerializeJson` catch 内的诊断转换，使用保守字符串 fallback；保留可正常读取的原始诊断。
- 预计修改：`packages/core/src/errors.ts`、`packages/core/src/serialize.ts`、`packages/core/test/errors.test.ts`、`packages/core/test/serialize.test.ts`。
- 验收：无原型 thrown value、抛错的 message/name/stack/toString/toJSON getter、toJSON 抛无原型值、循环、BigInt 均不让失败报告路径抛异常；所有 error message 为 string，失败返回稳定 serialization_error。不能吞掉本来可保留的常规 Error 信息。
- 前置依赖：无；与 T1 在同一文件中一起实现。

验证：`bun run --cwd packages/core test`；完整仓库 gate；`bun run check:deps` 确认 core 仍零依赖。输出给 03 的共享行为说明和普通 JSON golden vectors，一个最终 commit。
