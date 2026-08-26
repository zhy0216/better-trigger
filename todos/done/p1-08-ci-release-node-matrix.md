# P1-08 — CI/发布/工具链缺口：无 release workflow、无 Node 矩阵、publint 覆盖不全、残留配置、TS 未使用变量无人查

- 优先级：P1（发布与兼容性保障）
- 区域：.github + 根配置
- 状态：待办
- 来源：2026-08-26 全仓库审查

## C1 · 无 release workflow {#c1}

### 问题摘要

CI 花 70 行证明 tarball 可发布、注释里写死发布顺序（core→db→kernel→sdk→worker），但版本提升/tag/npm publish 全手工，无 workflow 承载该顺序。

### 现状证据

- `.github/workflows/` 仅 ci.yml + docs.yml。
- ci.yml 的 pack + clean-install 冒烟注释含发布顺序。

### 推荐实现方案

- 加 release workflow（哪怕手动 dispatch），至少固化发布顺序与 pack 验证。

## C2 · CI 无 Node/OS 矩阵 {#c2}

### 问题摘要

SDK 声明 `engines: node >= 18`，als.ts 三级懒加载的全部意义就是抹平 Node 版本差异，但 CI 只有 ubuntu+bun；`node -e` 冒烟用 runner 未 pin 的 Node，Node 18/20 的 ESM/CJS 回退路径从未被测过。

### 现状证据

- `package.json:38-40` — engines node >= 18。
- `.github/workflows/ci.yml:28-31` — 单 job 无矩阵。
- `packages/sdk/src/als.ts` — 三级懒加载。

### 推荐实现方案

- 加 Node 18/20/22 小型 smoke job，跑 edge-import 类检查。

## C3 · publint/attw 未覆盖 kernel/db；残留 `.next` 输出；TS 未使用变量无人查 {#c3}

### 问题摘要

`check:exports` 只覆盖 core/sdk/worker，kernel/db 也是发布包（CI pack 含它们）但 exports map 无检查；`turbo.json` outputs 含 `.next/**`（仓库无 Next.js）；根 tsconfig 关 noUnusedLocals/noUnusedParameters 且 ESLint 排除全部 TS → 未使用变量无人检查。

### 现状证据

- `package.json:26` — check:exports。
- `turbo.json:7` — `.next/**`。
- `tsconfig.json:10-11` — noUnusedLocals/noUnusedParameters 关闭；eslint.config.mjs 排除 TS。

### 推荐实现方案

- check:exports 补 kernel/db。
- 删除 `.next/**` 残留。
- 开启 noUnusedLocals/noUnusedParameters（清理告警），或引入 eslint TS 规则。

## 验收标准

- [ ] release workflow 存在并固化发布顺序。
- [ ] Node 矩阵 smoke job 通过。
- [ ] check:exports 覆盖 kernel/db；`.next` 残留移除；未使用变量有任一静态检查覆盖。
- [ ] `bun run typecheck`、`bun run build`、`bun run lint` 全部通过。

## 涉及文件

- `.github/workflows/ci.yml`（新增 release workflow）
- `package.json:26`
- `turbo.json:7`
- `tsconfig.json:10-11`、`eslint.config.mjs`
