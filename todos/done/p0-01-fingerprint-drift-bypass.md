# P0-01 — fingerprint 校验被 kind/label 漂移绕过(C1 修复的洞)

- 优先级:P0(正确性)
- 区域:worker / executor
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#1)

## 现状

`apps/worker/src/executor.ts:403-426` 的 `cached()` 是 `if / else if / else` 三分支,且三个分支最后都 `return snap`:

```ts
if (snap.kind !== expectedKind) {
  this.onReplayDrift(...);            // lenient → 只 warn
} else if (label 不一致) {
  this.onReplayDrift(...);            // lenient → 只 warn,fingerprint 根本不比
} else {
  // fingerprint 比较 —— 唯一会硬失败的分支
}
return snap;
```

`onReplayDrift`(`executor.ts:487-499`)只在 `task.replay === 'strict'` 时抛错;默认是 `'lenient'`。注释(`executor.ts:387-392`)承诺 "non-NULL mismatch → AbortError REGARDLESS of replay:'strict'",实际只对 kind+label 都未变的行成立。

注意:`stepFingerprint({ kind, label, input, codeVersion })` 的输入**包含 label**,所以 label 一变 fingerprint 必变——这正是可以利用的判据(见实现方案第 2 步)。

## 影响

默认 lenient 下:

1. **step 改名且改了实现**(`ctx.step('charge-v2', newFn)` 顶替 `ctx.step('charge', oldFn)`)走 label 分支,只 warn 一条日志就把旧输出喂给新代码——这正是 C1 要防的"静默返回旧值"场景,`todos/done/01-correctness.md` 的验收标准第一条("相同 label 但输入变化时不会返回旧 step output")在改名路径上不成立。
2. **kind 漂移**(wait 行落在 `ctx.step()` 调用点)把 wait 行的 `null` output 当 step 返回值,step 函数根本不执行;`doDeterministic`(`executor.ts:891-895`)还会 `new Date(null)` 得到 epoch。注释自己称这是 "unambiguous corruption",却在默认模式下照用。

## 实现方案

1. **kind 漂移永不返回 snap**:kind 不一致说明行的形状都不对(wait 行的 output 语义与 step 不同),无论 strict/lenient 一律抛非重试的 `AbortError`(沿用 fingerprint mismatch 的文案风格,写明 seq、期望/实际 kind)。
2. **label 漂移先做"旧 label fingerprint"仲裁**,保住 lenient 改名的合法用例:
   - 计算 `fingerprint(kind, snap.label, input)`(即用**行里记录的旧 label** + 当前输入重算);
   - 与 `snap.fingerprint` 相等 → 只有 label 变了、代码/输入没变 → 维持现状:strict 抛错,lenient warn 后返回 snap;
   - 不相等 → 代码或输入也变了 → 无论模式一律 `AbortError`(这是当前被绕过的路径);
   - `snap.fingerprint IS NULL` → 走现有 `onLegacyFingerprint` 兼容路径。
3. kind+label 都一致的分支保持现状(已正确)。
4. 更新 `executor.ts:380-392` 的注释,使其与新行为一致;`docs/backend-contract.md` §3.1 如提及 lenient 语义,同步措辞:"lenient 只豁免纯改名/重排,凡 fingerprint 能证明代码或输入变化,一律硬失败"。

## 验收标准

- 新增测试(`apps/worker/test/executor-fingerprint.test.ts` 扩展):
  - kind 漂移(构造 wait 行落在 step 调用点):lenient 与 strict 都抛 `AbortError`,step fn 未被调用;
  - label 漂移 + 实现变化(fingerprint 不同):lenient 与 strict 都抛 `AbortError`;
  - 纯 label 改名(旧 label fingerprint 与行一致):lenient warn 并复用输出,strict 抛错;
  - 既有"同 label 改函数"用例继续通过。
- `examples/basic/scripts/replay-drift.ts` 补 kind 漂移与改名+改实现两个场景断言。
- `bun run test` 与 `bun run test:acceptance` 全绿。

## 涉及文件

- `apps/worker/src/executor.ts:394-427`(`cached`)、`:487-499`(`onReplayDrift`)、`:460-480`(`fingerprint`)
- `apps/worker/test/executor-fingerprint.test.ts`
- `examples/basic/scripts/replay-drift.ts`
- `docs/backend-contract.md` §3.1
