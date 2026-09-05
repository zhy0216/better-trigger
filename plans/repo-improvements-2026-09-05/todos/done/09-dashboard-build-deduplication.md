difficulty: medium

# 消除 worker 构建中重复的 dashboard 编译

对应 plan.md：F16。执行模型固定为 Codex YOLO / gpt-6-astra / xhigh。

## T1 · 只构建一次、只嵌入新鲜 dashboard

- 做什么：整理 turbo worker/web 依赖与 write-build-info/copy-public 的职责，根构建不再次无条件编译 web。直接在 worker 目录运行 build 仍能从源码得到新鲜 dashboard，可通过经过验证的 orchestration 入口实现；不要仅检测 dist/index.html 存在就复用。
- 预计修改：turbo.json、apps/worker/scripts/write-build-info.mjs、apps/worker/scripts/copy-public.mjs、相关 .d.mts、apps/worker/package.json；必要时新增局部 build helper/tests。Dockerfile 仅在入口确需调整时修改。
- 验收：冷根 build 的 web 实际编译一次；热根 build 能复用 web cache；修改 web 源后 worker/public 更新；直接 worker build、干净 checkout、Docker 调用仍工作。缓存命中不恢复旧 SHA，tracked source 不变。
- 前置依赖：无。

## T2 · 保留交付物边界并验证执行次数

- 做什么：增加 build orchestration 的回归验证，复用 artifact guard 与临时 fixture；验证根与直接调用两条路径，不加入无关构建框架。
- 预计修改：apps/worker/test/artifact-guard.test.ts / build-info.test.ts 或新增目标测试，README 必要的命令说明。
- 验收：bun run build、直接 worker build、bun run check:exports、bun run check:pkg-meta 通过；不同 BT_GIT_SHA 连续构建及 synthetic orphan 检查仍通过；有日志/受控测试证据证明 web 编译次数与新鲜度。
- 前置依赖：本文件 T1。

## 执行约束与仓库校验

全程只用 Codex CLI YOLO、`gpt-6-astra`、`xhigh`，包括后续修复/rebase；difficulty 仅描述复杂度，不改变模型。先读 ../plan.md 与仓库 agent.md。一个 todo 一个 worktree、一个最终 commit，只修改本任务范围；不 push、不操作原分支。只有全部验收完成才移入 done/，并只更新 README 中本任务状态。

针对性校验完成后，在本 worktree 顺序运行 `bun run lint`、`bun run typecheck`、`bun run build`、`bun run test -- --force`、`git diff --check`。不要用 `bun run --bun test` 替代标准命令。新 worktree 缺依赖时 `bun install --frozen-lockfile`。数据库测试必须使用本任务独占临时 PostgreSQL，记录并清理所建资源；不能对用户现有库执行 reset。

## 验收记录 · 2026-09-05

- 实现：Turbo 负责 web 构建/缓存恢复；直接 worker build 经 `write-build-info.mjs` 进入相同依赖图，`copy-public.mjs` 只复制产物。保留 worker `cache: false`、实时 SHA、清理 dist 和 artifact guard。Docker 改为单个 worker build 入口，移除已由依赖图覆盖的手动依赖构建。
- 回归：新增临时 workspace 测试，使用真实 Bun/Turbo 和现有 artifact guard，仅替换编译器以独立计数。根/直接路径均验证冷编译 1 次、删除 web dist 后缓存恢复且计数不变、源码变更后新增 1 次、双 SHA 更新、synthetic orphan 拒绝与清理、旧 dashboard 文件清理，以及 web 失败时不打包旧资源。构建不改写 tracked build-info 源文件。

| 验收项 / 命令 | 结果 |
|---|---|
| `bun install --frozen-lockfile` | 通过；Bun 1.4.0，lockfile 无修改 |
| `env -u DATABASE_URL bun run --cwd apps/worker test test/build-orchestration.test.ts test/build-info.test.ts test/artifact-guard.test.ts` | 3 files、22 tests 通过 |
| 冷根 build，独立空缓存，`--cache=local:rw --output-logs=new-only` | 7 tasks 成功、0 cached；真实 Vite 编译 1 次 |
| 同缓存根 build，`BT_GIT_SHA` 从 `task09-first-sha` 改为 `task09-second-sha` | 7 tasks 成功、6 cached；Vite 编译 0 次；artifact guard 确认新 SHA 并拒绝旧 SHA |
| 向真实 dist 注入 `runtime-task09-orphan.js` | guard 按预期 exit 1；下一次 build 清理后 guard exit 0 |
| 临时修改真实 web `index.html`，分别根 build 和直接 worker build | 两条路径各编译 web 1 次，worker/public 含对应新 marker；finally 恢复原源码，git diff 确认无残留 |
| `env -u DATABASE_URL bun run --cwd apps/worker build` | 干净输出状态下可用；依赖按图构建/恢复 |
| `docker build --build-arg GIT_SHA=task09-docker-final -f apps/worker/Dockerfile .` | 最终完整镜像通过；build 阶段 6 tasks、0 cached，web 编译 1 次；不含宿主 .git/node_modules/dist |
| 最终 Docker runtime smoke | dashboard 存在、嵌入预期 SHA、CLI `--help` 成功 |
| `bun run check:exports` | artifact guard、五个发布包 publint/attw 全通过 |
| `bun run check:pkg-meta` | 40 passed、0 failed；含干净 tarball 安装、ESM/CJS 导入、CLI 与 tree-shaking |
| 顺序 `bun run lint` → `bun run typecheck` → `bun run build` → `bun run test -- --force` → `git diff --check` | 全通过；每条 Bun 命令均显式 `env -u DATABASE_URL`。最终 test：13 tasks、0 cached，1,379 passed、95 PG tests skipped |

验证日志：本机 `/tmp/better-trigger-09-{targeted,root-cold,root-hot,root-freshness,direct-freshness,orphan,docker-final,lint,typecheck,build,test,exports,pkg-meta}.log`。真实新鲜度探针为 `/tmp/better-trigger-09-freshness.ts`。

风险/资源：无 blocker；本任务无需 PG，未连接用户数据库或创建 PostgreSQL 容器。两个 Docker smoke 容器均以 `--rm` 清理，三个本任务生成的临时镜像已按记录的 ID 删除。已有 TypeScript 7 experimental 警告及任务 10 所属的 shutdown stub TypeError 日志保持原状；未扩展修改范围。未 rebase、merge、push 或修改其他任务状态。
