difficulty: easy

# 09 · 依赖自动更新与安全报告政策

覆盖方案 F9。在 02 清理现有 advisory 后建立持续更新入口，避免机器人一启用就被旧漏洞/大规模漂移淹没。

## T1 · 增加每周依赖更新

- 要做什么：新增 Dependabot 配置，覆盖根 Bun/npm workspace lockfile 与 GitHub Actions；每周运行。npm 生态的 patch/minor 可按合理生态或工具链分组，major 保持独立 PR 评估；限制同时打开的 PR 数并使用清晰 label/commit 前缀，避免一次性无目的 major 升级。配置目录必须匹配当前单一根 `bun.lock` 的 workspace 布局。
- 预计修改文件：新增 `.github/dependabot.yml`。
- 验收条件：配置通过 YAML 与 Dependabot schema 检查；根目录 npm ecosystem 能覆盖 `apps/*`、`packages/*`、`examples/*` 的 workspace 依赖，GitHub Actions 单独更新；patch/minor 分组规则不会吞并 major；未加入自动合并或绕过 CI 的权限。
- 前置依赖：`02-deterministic-dependency-audit.md`。

## T2 · 发布最小 SECURITY.md

- 要做什么：新增安全政策，列出当前受支持版本、优先使用 GitHub Security Advisories 私下报告的入口、报告中应包含的信息、预计首次响应边界，以及不要在未修复前公开 issue 的说明。不能承诺团队无法保证的固定修复 SLA，也不能放个人邮箱或虚构联系人。
- 预计修改文件：新增 `SECURITY.md`。
- 验收条件：GitHub 能识别仓库根安全政策；文档给出私下报告路径与支持版本，未泄露个人信息、未要求在公开 issue 披露漏洞；Markdown lint/链接检查（若现有工具覆盖）通过。
- 前置依赖：无；与 T1 同一 worktree/commit。

## 本文件验证

校验 `.github/dependabot.yml` YAML/schema 与 `SECURITY.md` 链接；确认 `bun run typecheck && bun run lint && bun run build && bun run test` 不受配置文件新增影响。

## 完成状态

✅ 已完成（2026-09-04）。

- T1：新增 `.github/dependabot.yml`：npm 生态仅配置根目录 `/`（单一根 `bun.lock` 覆盖 apps/*、packages/*、examples/*）；GitHub Actions 生态独立配置；均为每周一 UTC 06:00；minor+patch 按生态分组合并（`update-types` 不含 major，major 保持独立 PR）；`open-pull-requests-limit` 分别限 10/5；label `dependencies`+生态标签，commit 前缀 `deps(npm)`/`deps(ci)`；无自动合并、无绕过 CI 配置。通过 `Bun.YAML.parse` 与 schemastore dependabot-2.0 JSON schema（ajv-cli）校验。
- T2：新增根 `SECURITY.md`：支持版本表（0.1.x，仅最新发布线）、GitHub Security Advisories 私下报告入口（`https://github.com/zhy0216/better-trigger/security/advisories/new`，HTTP 200）、报告应含信息、首次响应为"数个工作日内确认"的非承诺边界、明确不承诺固定修复 SLA、要求修复前不开公开 issue；无个人邮箱/虚构联系人。仓库根路径符合 GitHub 安全政策识别约定。
- 未触碰 `.github/workflows/ci.yml`、`release.yml`、package.json audit 相关脚本。
- 校验：`bun run typecheck && bun run lint && bun run build && bun run test` 全绿（13/13 tasks，worker 485 tests passed）。
