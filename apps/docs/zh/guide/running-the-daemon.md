# 运行 daemon

`better-trigger-worker` 是全合一 daemon：它 import 你的任务模块、应用数据库迁移、用重放执行器执行 run、运行编排器循环（wait / cron / lease reaper / 离线标记），并在同一个端口提供 HTTP API——外加内置 dashboard。

```bash
# 在 checkout 里，执行过 `bun install && bun run build` 之后：
DATABASE_URL=postgres://localhost:5432/better_trigger \
  bunx --bun @better-trigger/worker --tasks ./tasks.ts
```

daemon 会 `import()` 你的 `--tasks` 模块，所以 **TypeScript 入口需要 TS 运行时**——在 `bun` 下运行（如上），或 `tsx`，或把 `--tasks` 指向编译后的 JavaScript。

## 部署形态

`--tasks` 与 `--no-serve` 相互独立，同一个二进制覆盖所有形态：

| 命令 | 角色 |
|---|---|
| `better-trigger-worker --tasks ./tasks.ts` | 全合一：执行 + 服务（默认） |
| `better-trigger-worker` | 只有 API + dashboard；跑 lease reaper + 离线标记，**不跑** cron/waits/claim |
| `better-trigger-worker --tasks ./tasks.ts --no-serve` | 纯执行节点 |

任意多个 daemon 共享一个数据库——每条 claim 与扫描都用 `FOR UPDATE SKIP LOCKED`，所以**没有 leader 选举**。典型的多节点部署是一个 API/dashboard 节点加若干 `--no-serve` 执行节点。

## 任务加载

`--tasks` 模块里每个长得像 `task()` handle 的导出都会被注册，包括导出数组里的 handle：

```ts
export const hello = task("hello", async () => "hi");
export const allTasks = [hello, onboarding];   // 同样有效
```

`--tasks` 可重复、也接受逗号分隔路径。跨模块出现重复 task id 会报错，除非它们字面就是同一个 handle。

## Dashboard

daemon 直接托管构建好的 dashboard——与 API 同源，无需第二个端口、无需 CORS。`docker compose up` 后打开 `http://127.0.0.1:4848`。深链（比如你收藏的 `/runs/...` URL）刷新后会落到 dashboard 而不是 404，哈希资源按 `immutable` 提供，所以 daemon 重启后总是给出新 bundle。

开发 dashboard 时，单独跑 Vite 并指向 daemon：

```bash
cd apps/web && VITE_BT_API_URL=http://localhost:4848 bun run dev   # :5173
```

如果 daemon 设置了 `BETTER_TRIGGER_API_KEY`，dashboard 在收到 `401` 后会提示输入 key，手动输入的 token 只留在页面内存里——不会写入浏览器存储或 cookie。

## 优雅关停

`SIGINT` / `SIGTERM` 会优雅关停 daemon：停止 claim → 排空在飞 run → 停止循环 → 关闭 server → 结束连接池。干净的重启会把 claim 交还回来，且不消耗任何重试次数——`attempt`（*你的代码*失败的预算）与 `recoveries`（基础设施接管的预算）都不受影响。

## worker 挂了会发生什么

每次 claim 都带一个 **fencing token**——每条 run 的单调递增计数器，每次 claim 时 +1。如果 daemon 死了，它的租约过期（`--lease-ms`，默认 60s）并被任意存活的 daemon reaper 回收；僵尸 worker 的迟到写入会被 fencing 检查拒绝。这就是 step 历史保持 exactly-once 的机制。

丢失 worker 的 run 被接管，消耗一次 **recovery**（预算 `max_recoveries`，默认 10）——不是 attempt。只有 recovery 预算耗尽才会以 `worker lost` 终止该 run。

## CLI 与环境变量

一切都可以用 flag 和 `BETTER_TRIGGER_*` 环境变量配置。常用项：

```bash
better-trigger-worker --tasks ./tasks.ts \
  --port 4848 --concurrency 5 --name worker-1 --lease-ms 60000 \
  --pin-code-version        # 只 claim 本进程能重放的代码版本的 run
  --retention 30d           # 开启每小时的历史 GC
```

完整表格见 [CLI 与环境变量](/zh/reference/cli-and-env)，权威列表请运行 `better-trigger-worker --help`。
