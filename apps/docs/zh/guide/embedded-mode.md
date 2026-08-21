# 嵌入式模式

当**一个进程就是产品**时——比如长驻 Node/Bun 应用（server、CLI、agent 宿主）——你可以在本进程启动同一套 runtime，而不是跑一个独立 daemon。没有第二个进程、没有开放端口、没有第二套执行模型。

```ts
import { createEmbeddedRuntime } from "@better-trigger/worker/embedded";
import { hello } from "./tasks";

const runtime = await createEmbeddedRuntime({
  databaseUrl: process.env.DATABASE_URL,
  tasks: [hello],
  concurrency: 5,
});

// createEmbeddedRuntime 会把 runtime.client 设为默认，所以 TaskHandle API
// 与 daemon 模式保持同形。
const handle = await hello.trigger({ name: "ada" });
console.log((await handle.result()).output);

// 挂进宿主框架的优雅关停钩子里。
await runtime.stop();
```

## runtime 负责什么

`createEmbeddedRuntime()` 与 daemon CLI 走同样的生命周期：

- 应用迁移（可配置），
- 注册任务并直接从 Postgres claim run，
- 启动 claim、心跳、wait/timer、cron 与 reaper 循环，
- 暴露 `client`、`app`、`fetch`、`worker` 计数器与 `pool`，
- 在 `stop()` 时排空并交还 claim。

它从不创建 TCP 监听。SDK 通过**进程内 fetch 适配器**复用同一套 Hono API 路由。

## 共享应用连接池

传一个已有的 `pool` 来共享应用的连接池；注入的 pool 默认不会被关闭，除非设置 `closePoolOnStop: true`。给了 `databaseUrl` 时，runtime 自管连接池。每个进程只允许一个 embedded runtime，因为任务上下文与 run 内结果解析依赖进程级 SDK registry。

## 嵌入式模式**没有**改变什么

嵌入式模式去掉的是额外的 OS 进程，**不是**对在线 worker 的需求：

- 应用停止时，持久化状态仍留在 Postgres，但任务、定时器与 cron **不会**执行。
- 任务执行会共享宿主机的 CPU、内存与故障域。

它面向长驻宿主，而不是 scale-to-zero 的请求函数。需要隔离或独立扩缩容时，请用独立 daemon。

## 在 daemon 与嵌入式之间选择

| | Daemon（默认） | 嵌入式 |
|---|---|---|
| 进程 | 独立 daemon | 就在你的 app 里 |
| 端口 | `:4848` HTTP + dashboard | 无（进程内 fetch） |
| 隔离 / 扩缩容 | 独立 | 共享宿主资源 |
| 适合场景 | 多节点、共享 Postgres、运维隔离 | 单个长驻应用进程 |
