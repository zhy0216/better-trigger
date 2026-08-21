---
layout: home

hero:
  name: better-trigger
  text: 基于 Postgres 的 TypeScript 持久化执行
  tagline: 重放式的后台任务、cron、重试与扇出 —— 只需要一个 Postgres 数据库。没有 Redis、没有 ClickHouse、没有第二套运行时。
  image:
    src: /better-trigger/logo.svg
    alt: better-trigger
  actions:
    - theme: brand
      text: 开始使用
      link: /zh/guide/introduction
    - theme: alt
      text: 快速开始
      link: /zh/guide/quick-start
    - theme: alt
      text: GitHub
      link: https://github.com/zhy0216/better-trigger

features:
  - icon: 🧱
    title: 重放而非快照
    details: 已完成的 step 会记忆在 Postgres 里。崩溃或长时间 wait 之后，任务函数从头重跑，命中的 step 立即返回缓存结果 —— 你的代码始终是一段直线 async 函数。
  - icon: 🐘
    title: Postgres 是唯一基础设施
    details: 队列、编排器循环与重放执行器都在 runtime 内，通过 FOR UPDATE SKIP LOCKED 协调。N 个 daemon 共享一个数据库，无需 leader 选举。
  - icon: 📦
    title: 零依赖 SDK
    details: better-trigger 提供 task() 与 HTTP 客户端，无任何运行时依赖，从不打开数据库连接，可以放心 import 进 web server、CLI、edge 函数或浏览器。
  - icon: 🧩
    title: 单进程或多进程
    details: 把 worker 跑成独立 daemon，或在长驻 Node/Bun 应用里嵌入同一套 runtime，也可以让任意多个 daemon 共享同一个数据库。
  - icon: 🔁
    title: 持久化原语
    details: 带退避的重试、幂等键、cron、并发限制、wait、父子 triggerAndWait 与 batchTrigger —— 全部可跨崩溃恢复。
  - icon: 🛡️
    title: 构造即崩溃安全
    details: 持久租约加单调 fencing token，拒绝来自已死 worker 的迟到写入，step 历史保持 exactly-once。
---

## 一条命令上手

```bash
docker compose up -d   # postgres:16 + daemon，监听 127.0.0.1:4848

curl localhost:4848/api/v1/tasks   # 已注册的示例任务
curl -X POST localhost:4848/api/v1/trigger \
  -H 'Content-Type: application/json' \
  -d '{"taskId":"hello-world","payload":{"name":"ada"}}'
```

示例已内置进 worker 镜像 —— 本机无需安装或构建任何东西，cron 任务已经在不断产出运行记录。
