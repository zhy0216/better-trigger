# repo-improvements TODOs — 第四轮全仓库探索（2026-09-04）

本队列由 `plan.md` 的 F1–F9 拆解而来；F10/F11 已标为 roadmap，本轮不进入执行队列。一个文件对应一个独立 worktree、一次 agent 执行和一个最终 commit。为避免并行 worktree 同时修改 `.github/workflows/ci.yml`，CI 门禁接线从各实现包中集中到 07；发布 workflow 保持为独立的 08。

## 优先级

| 文件 | 优先级 | 难度 | 一句话说明 |
|---|---|---|---|
| [01-reproducible-worker-artifacts.md](./done/01-reproducible-worker-artifacts.md) | P1 | hard | ✅ 已完成 · worker provenance 改为无 tracked source 写入的 bundler define、禁用不可靠的 Turbo cache，并以 dist/pack 文件图拒绝 orphan chunk、旧 sourcemap 和旧 SHA |
| [02-deterministic-dependency-audit.md](./done/02-deterministic-dependency-audit.md) | P1 | medium | ✅ 已完成 · `check:audit` 固定官方 registry 并按 advisory+解析版本+lock 依赖链精确报告（0.25.x 安全 esbuild 不误报）；vitepress→vite ^6.4.3、@esbuild-kit/core-utils→esbuild ^0.25.12 最小 override 清除 1 high + 3 moderate，docs build/dev、db:generate、drift 全绿 |
| [03-rate-limit-zero-contract.md](./done/03-rate-limit-zero-contract.md) | P1 | easy | ✅ 已完成 · 将 `BETTER_TRIGGER_RATE_LIMIT_BURST=0` 统一为真正禁用限流，并同步测试与中英文说明 |
| [04-non-root-pinned-worker-image.md](./done/04-non-root-pinned-worker-image.md) ✅ | P1 | medium | 固定 Bun runtime 镜像并让 worker 容器默认以非 root 用户运行（已完成：base/runtime 对齐 `oven/bun:1.3.14-slim`，runtime `USER bun`（uid/gid 1000）+ 全量 `COPY --chown`；本地 docker 验证通过 T1/T2） |
| [05-wait-poll-contract.md](./done/05-wait-poll-contract.md) | P2 | easy | ✅ 已完成 · 保留 `pollMs` 兼容输入，但明确 daemon waiter 忽略它，只有 embedded kernel fallback 使用 |
| [06-published-package-metadata.md](./06-published-package-metadata.md) | P2 | easy | 为五个发布包补齐 Node 运行时下限，并基于入口副作用审计声明 `sideEffects` |
| [07-ci-delivery-gates.md](./07-ci-delivery-gates.md) | P1 | hard | 把 artifact、audit、容器和包元数据的针对性验收集中接入 CI |
| [08-npm-trusted-publishing.md](./done/08-npm-trusted-publishing.md) | P2 | medium | ✅ 仓库侧已完成 · release 迁移到 npm OIDC trusted publishing（`id-token: write`、Node 22 + npm 11.5.1 断言、五包顺序发布带 `--provenance`、不再读长期 token）；T2 的 npm trusted publisher 配置与真实发布/provenance 验证 deferred，待维护者明确授权 |
| [09-dependency-automation-security-policy.md](./done/09-dependency-automation-security-policy.md) | P2 | easy | ✅ 已完成 · Dependabot 周更（根 bun.lock npm 生态 + GitHub Actions 生态，minor/patch 分组、major 独立 PR、限并发、清晰 label/前缀、无自动合并）；根 `SECURITY.md` 发布支持版本与 GH Advisories 私下报告入口，无固定修复 SLA/个人邮箱 |

## 文件

执行顺序（依赖满足后即可启动，不要求机械地逐项串行）：

1. `01-reproducible-worker-artifacts.md`（P1，hard）✅ 已完成，归档至 `done/` — 无依赖。
2. `02-deterministic-dependency-audit.md`（P1，medium）✅ 已完成，归档至 `done/`。
3. `03-rate-limit-zero-contract.md`（P1，easy）✅ 已完成，归档至 `done/`。
4. `04-non-root-pinned-worker-image.md`（P1，medium）✅ 已完成，归档至 `done/` — 无依赖。
5. `05-wait-poll-contract.md`（P2，easy）✅ 已完成，归档至 `done/`。
6. `06-published-package-metadata.md`（P2，easy）— 依赖 01、02；复用 01 的 pack/artifact guard，并避开与 02 对 `packages/db/package.json` 的并行修改。
7. `07-ci-delivery-gates.md`（P1，hard）— 依赖 01、02、04、06；统一修改 `.github/workflows/ci.yml`。
8. `08-npm-trusted-publishing.md`（P2，medium）✅ 仓库侧已完成，归档至 `done/` — T1 迁移 release 到 OIDC trusted publishing + provenance；T2 依赖 npm 账户侧 trusted publisher 与维护者授权，deferred。
9. `09-dependency-automation-security-policy.md`（P2，easy）✅ 已完成，归档至 `done/`。

可并行轨道：首轮 `{01} {02} {03} {04}`；随后 `{03→05} {01+02→06} {02→09}`；`07` 在 01/02/04/06 完成后执行，`08` 在 01/02 与外部 npm 前置满足后可和 07/09 并行。

## 执行约定

- `easy` / `medium` 由 flash 模型执行，`hard` 由 max 模型执行。
- 每个 todo 独立跑其中列出的针对性验收，并至少跑 `bun run typecheck && bun run lint && bun run build && bun run test`；改依赖加跑 `bun run check:drift`，改发布包或 tarball 加跑 `bun run check:exports`。
- 不实现 F10/F11，不顺手拆分 orchestrator/queue/executor，也不加入 events、agent、plugin 等新产品能力。
- 08 的真实 npm 发布和账户配置属于外部、不可逆操作；未获得维护者对具体测试包或版本的明确授权时，只提交并验证仓库侧 workflow，不执行发布。
