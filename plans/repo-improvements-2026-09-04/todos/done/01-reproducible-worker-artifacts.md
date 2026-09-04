difficulty: hard

# 01 · 可复现的 worker 构建身份与发布物

覆盖方案 F1、F2。构建身份、清理策略和 artifact graph 会共同修改 worker 的 build 边界，因此必须在同一个 worktree/commit 中完成。

## T1 · 让 build provenance 对缓存可见且不污染 tracked source

- 要做什么：统一 `BT_GIT_SHA`、本地 Git HEAD/dirty 和 version-only 三种 provenance 输入；确保每次 worker build 使用本次解析出的值，不能从 Turbo cache 恢复另一提交的 `dist`。如果本地 dirty 状态无法可靠进入 Turbo hash，就对 `@better-trigger/worker#build` 禁用缓存。重构 `write-build-info.mjs` 及 build 包装，使成功、失败和中断路径都不会把临时 SHA/版本遗留在 tracked `src/generated/build-info.ts`；不得靠 CI 末尾 `git checkout` 掩盖污染。
- 预计修改文件：`turbo.json`、`apps/worker/package.json`、`apps/worker/scripts/write-build-info.mjs`、`apps/worker/src/generated/build-info.ts`、`apps/worker/test/build-info.test.ts`；按最终实现新增或调整 `apps/worker/scripts/*.mjs` 和对应 `apps/worker/test/*.test.ts`。
- 验收条件：保留 `.turbo/cache`，用两个不同 `BT_GIT_SHA` 连续执行仓库 build，第二次 worker 实际入口引用的 chunk、`/health`、metrics 与 `workers.code_version` 只报告第二个值；本地 clean/dirty/non-git 三种解析路径都有自动测试；主动制造 build 失败后，tracked 文件相对 build 前无新增 diff；`bun run --cwd apps/worker test`、`bun run build` 通过。
- 前置依赖：无。

## T2 · 清理输出并拒绝 orphan/陈旧 artifact

- 要做什么：在实际执行 worker build/pack 的边界清理明确枚举的 `apps/worker/dist`，不能假设 bundler 的 `clean` 会在 Turbo cache hit 时执行。新增 artifact guard，从 `dist` 的发布入口出发检查 JS/CJS chunk 与 sourcemap 的可达性/allowlist，并检查 pack 文件清单，阻止未引用的 hashed chunk、旧 map、上一轮 SHA 或额外生成物进入 tgz。检查必须面向最终入口和 `npm pack --dry-run --json`/等价 pack 结果，不能只断言 source 常量。
- 预计修改文件：`apps/worker/package.json`、`apps/worker/scripts/copy-public.mjs`（仅当 build 顺序需要）、新增的 `apps/worker/scripts/check-artifacts.mjs`（或同目录等价 guard）、对应 `apps/worker/test/*.test.ts`；如入口图需要提供稳定元数据，再调整 `apps/worker/tsdown.config.ts`。
- 验收条件：先构建一次，再人工放入模拟旧 hashed chunk/map，下一次 build 后旧文件被清除或 guard 明确失败；连续以两个 SHA 构建并 pack，tgz 只含当前入口可达 chunk/current SHA，且保留 `dist/public/index.html`、CLI 与 ESM/CJS/类型入口；guard 对孤儿 JS、孤儿 map、入口缺失均有失败测试；`bun run check:exports` 通过。
- 前置依赖：T1。

## 本文件验证

`bun run --cwd apps/worker test && bun run build && bun run check:exports && bun run typecheck && bun run lint && bun run test`。另按 T1/T2 执行双 SHA、保留 Turbo cache、失败恢复和 pack 文件图场景，并用 `git diff --exit-code` 确认 build 自身不改 tracked 文件。
