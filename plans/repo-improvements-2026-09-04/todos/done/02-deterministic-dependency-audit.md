difficulty: medium

# 02 · 可重复的依赖审计与已知 advisory 修复

覆盖方案 F3。审计入口、依赖升级与 lockfile 必须同 commit 落地，避免出现“CI 有门禁但当前锁文件必然失败”或“升级了依赖但仍没有持续门禁”的中间状态；CI workflow 的接线由 07 统一完成。

## T1 · 建立固定官方 registry 的 audit 命令

- 要做什么：新增根级 `check:audit`，显式使用 `https://registry.npmjs.org`，不继承本机 npmmirror advisory endpoint；至少对 high severity 失败。若上游暂时无法消除某条 moderate，只允许精确到 advisory、实际解析版本和依赖链的窄例外，并要求原因、实际暴露面、owner、到期日；过期或变宽的例外必须使检查失败。
- 预计修改文件：`package.json`、新增的 `scripts/check-audit.mjs`（若简单命令不足以校验窄例外）以及与该脚本同目录的最小例外数据文件（仅在确有暂留项时新增）。
- 验收条件：在本机 registry 指向 npmmirror 时 `bun run check:audit` 仍访问官方 registry；模拟/保留 high advisory 时命令非零退出；无 high 时退出 0；任何例外都能验证 advisory id、resolved version、依赖链、owner 和未来到期日，禁止按整个包名或整个 severity 永久忽略；新增根脚本通过现有 `lint:root`。
- 前置依赖：无。

## T2 · 修复 docs 与 db 开发工具链中的已知漏洞链

- 要做什么：基于实际 lockfile 路径处理 VitePress 1.6.4 拉入的 Vite 5.4.21/esbuild 0.21.5，以及 Drizzle Kit 0.31.10 经 `@esbuild-kit/esm-loader` 拉入的 esbuild 0.18.20。优先升级到兼容且已修复的上游版本；只有确认无兼容版本时才使用 T1 的窄例外或最小 override。不要做无关 major 全量升级，也不能把同组已安全的 esbuild 0.25.x 误列为漏洞。
- 预计修改文件：`apps/docs/package.json`、`packages/db/package.json`、`bun.lock`；只有确有必要时调整 T1 的 audit 脚本/例外数据。
- 验收条件：`bun run check:audit` 无 high；暂留 moderate 满足 T1 的完整例外元数据。`bun run --cwd apps/docs build` 和一次受控的 docs dev 启动 smoke 通过；`bun run --cwd packages/db db:generate` 不产生 schema/migration diff，`bun run check:drift` 通过；`bun run typecheck && bun run lint && bun run build && bun run test` 全绿。
- 前置依赖：T1。

## 本文件验证

`bun run check:audit && bun run --cwd apps/docs build && bun run check:drift && bun run typecheck && bun run lint && bun run build && bun run test`；同时检查 `git diff -- packages/db/migrations packages/db/src/schema.ts` 为空。
