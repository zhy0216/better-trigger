# 执行队列 · database-schema-isolation

方案：[../plan.md](../plan.md)。用户已确认没有需要保留的旧数据，按固定 `better_trigger` schema 全新建表。01–05 全部完成（见 [done/](done/) 内执行记录）。

## 执行偏好

default_agent: opencode
default_model: alibaba-token-plan-cn/deepseek-v4.1-flash

来源：用户本次明确指定 OpenCode、Alibaba Token Plan 的 DeepSeek Flash v4.1，覆盖 plan 中来自宿主的 Codex 默认值。已通过本机 OpenCode 1.18.31 的模型列表核对完整 ID。所有任务 `agent: inherit`；没有单任务覆盖，也没有 Codex 推理强度设置。模型覆盖适用于所有难度，不再按难度切换模型。

执行时用户改按难度分派模型：hard 任务用 `alibaba-token-plan-cn/qwen3.8-max`（01、02、04），medium 任务用 `alibaba-token-plan-cn/deepseek-v4.1-flash`（03、05）。上表“模型”列已改为各任务实际启动结果，选择来源为用户 2026-09-17 的启动指令，agent 类型仍为 OpenCode。

计划开始时间：**2026-09-17 22:00:00 Asia/Shanghai（北京时间）**，即 `2026-09-17 14:00:00 UTC`。提前只准备和提交方案/队列，到点才启动开发。执行命令必须显式包含 `--auto --model alibaba-token-plan-cn/deepseek-v4.1-flash`；不能静默改 provider 或模型。

## 优先级

| 文件 | 优先级 | 难度 | agent / 来源 | 模型 / Codex 推理强度 | 一句话说明 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| [done/01-db-schema-and-baseline.md](done/01-db-schema-and-baseline.md) | P1 | hard | opencode / 继承用户默认 | alibaba-token-plan-cn/qwen3.8-max / 不适用 | 专属 schema、独立 journal 与新迁移基线 | Done |
| [done/02-kernel-qualified-sql.md](done/02-kernel-qualified-sql.md) | P1 | hard | opencode / 继承用户默认 | alibaba-token-plan-cn/qwen3.8-max / 不适用 | kernel 表引用和相关回归测试 | Done |
| [done/03-worker-schema-integration.md](done/03-worker-schema-integration.md) | P1 | medium | opencode / 继承用户默认 | alibaba-token-plan-cn/deepseek-v4.1-flash / 不适用 | dashboard、metrics、waiters 与 embedded 查询 | Done |
| [done/04-shared-database-acceptance.md](done/04-shared-database-acceptance.md) | P1 | hard | opencode / 继承用户默认 | alibaba-token-plan-cn/qwen3.8-max / 不适用 | harness 适配与真实共库、迁移、连接池验收 | Done |
| [done/05-docs-and-delivery-verification.md](done/05-docs-and-delivery-verification.md) | P1 | medium | opencode / 继承用户默认 | alibaba-token-plan-cn/deepseek-v4.1-flash / 不适用 | 文档、发布产物、Git 安装及最终校验 | Done |

## 文件

1. [done/01-db-schema-and-baseline.md](done/01-db-schema-and-baseline.md) — 依赖：无。已完成。
2. [done/02-kernel-qualified-sql.md](done/02-kernel-qualified-sql.md) — 依赖 01-db-schema-and-baseline。已完成。
3. [done/03-worker-schema-integration.md](done/03-worker-schema-integration.md) — 依赖 01-db-schema-and-baseline、02-kernel-qualified-sql。已完成。
4. [done/04-shared-database-acceptance.md](done/04-shared-database-acceptance.md) — 依赖 01-db-schema-and-baseline、02-kernel-qualified-sql、03-worker-schema-integration。已完成。
5. [done/05-docs-and-delivery-verification.md](done/05-docs-and-delivery-verification.md) — 依赖 01–04 全部完成。已完成。

执行顺序：`01 → 02 → 03 → 04 → 05`。本队列没有独立并行任务；迁移、运行时 SQL 与验收必须按同一数据库契约逐步集成。

## 执行与集成约定

- 一个 todo 对应一个独立 Git worktree 和一个最终 commit。先在隔离的集成分支上依次收集提交；全部验证通过后再合回启动时记录的 `main`，避免中间阶段让主分支的数据库入口不一致。
- 保留用户及其他任务的改动；主分支有新提交时在隔离分支处理集成和复验，不覆盖或重置主工作区。未完成的验证或冲突如实记录，不能标成 Done。
- 各任务先完成自己的局部验证。01–03 的中间状态尚未完成全仓库数据库适配，不宣称完整 PG/acceptance 通过；04 完成跨模块验收，05 负责最终全仓库 gate。
- 修改业务查询时同时更新该模块依赖 SQL 文本的 mock。不要通过设置 `search_path`、容忍未知 SQL 返回空行或跳过 PG 测试来隐藏遗漏。
- 新 worktree 执行 `bun install --frozen-lockfile`；只在本 worktree 生成构建产物。测试使用自己创建的临时 PostgreSQL cluster/数据库；本机提供 `/usr/lib/postgresql/16/bin/`，可使用随机 loopback 端口并在结束时清理自己的实例。
- 每个任务记录改动、实际验证命令/结果和限制，完成后将自己的文件移到 `done/` 并更新本 README 的对应链接与状态。协调执行者记录最终 commit，不把未运行的检查写成通过。
- 05 的 Git 安装检查读取已提交 HEAD：先创建本任务提交，验证该提交后可 amend 补充结果，最终仍保留一个任务提交；校验报告注明被测源码提交，不能把旧 HEAD 当成本次验证。
- 本次范围不包含动态 schema、旧库数据搬迁、部署、推送远端或对外发消息。
