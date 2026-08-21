# 快速开始

最快的上手方式是 `docker compose`——它同时启动 Postgres **和**一个已经在跑示例任务的 daemon，包括一个每两秒触发一次的 cron 任务，所以第一条命令开始就有东西在执行。示例已内置进 worker 镜像，本机无需安装或构建任何东西：

```bash
docker compose up -d   # postgres:16 + daemon，监听 127.0.0.1:4848

curl localhost:4848/api/v1/tasks   # 已注册的示例任务
curl localhost:4848/api/v1/runs    # ……以及它们已经在产生的 cron run
curl -X POST localhost:4848/api/v1/trigger \
  -H 'Content-Type: application/json' \
  -d '{"taskId":"hello-world","payload":{"name":"ada"}}'
```

[dashboard](/zh/guide/running-the-daemon#dashboard) 指向 `http://localhost:4848`，可以看到全部运行情况。

## 跑你自己的任务

或者把 daemon 跑在本机：

```bash
bun install && bun run build
createdb better_trigger      # 或：docker compose up -d postgres
```

```ts
// tasks.ts —— daemon 和你的 app 都会 import 它
import { task } from "better-trigger";

export const hello = task({
  id: "hello-world",
  run: async (payload: { name: string }) => `hello, ${payload.name}`,
});
```

启动 daemon——它会加载 `tasks.ts`、应用迁移、执行 run 并在 `:4848` 提供 API：

```bash
DATABASE_URL=postgres://localhost:5432/better_trigger \
  bunx --bun @better-trigger/worker --tasks ./tasks.ts
```

然后从任何地方触发：

```ts
// app.ts —— 不连数据库、没有执行循环
import { betterTrigger } from "better-trigger";
import { hello } from "./tasks";

betterTrigger({ url: "http://localhost:4848" }).setDefault();

const handle = await hello.trigger({ name: "ada" });
const result = await handle.result();   // { status: "completed", output: "hello, ada" }
console.log(result.output);             // "hello, ada" —— 类型即任务的返回值
```

## 关于 `handle.result()`

`handle.result()` 会等待终态。如果 run 超过等待预算（默认 30s）仍未结束，它会返回**最新的非终态 status** 而不是输出——run 可能跑很久时务必检查 `result.status`，或传 `{ throwOnTimeout: true }` 让超时抛出 `ResultTimeoutError`（带最新 status）。

## 依赖

- SDK 与 daemon 需要 Node.js 18+（或 Bun）。
- 一个可达的 PostgreSQL 数据库（推荐 16+）。

daemon 在 `bun` 下直接跑你的 TypeScript 任务模块。纯 `node` 下请把 `--tasks` 指向编译后的 JavaScript（或用 `tsx` 之类的 loader）。
