# 04 — 默认姿态与输入边界

前提:这个项目定位是"纯本地",所以"默认不开鉴权"本身是合理的产品选择。
下面几条讲的是**默认值把这个选择的暴露面放大到了本机之外**。

## S1 · 默认监听所有网卡,而鉴权默认关闭 {#s1}

**位置** `apps/worker/src/main.ts:208` — `serve({ fetch: app.fetch, port: opts.port })`

**现象** `@hono/node-server` 的 `serve()` 不传 `hostname` 时走 Node 的
`server.listen(port)`,也就是绑定所有接口(`::` / `0.0.0.0`)。同时
`authMiddleware`(`middleware.ts:18-19`)在 `BETTER_TRIGGER_API_KEY` 未设时直接
`next()` —— 默认无鉴权。CLI 也没有 `--host` 这个选项(`main.ts:31-51` 的 USAGE)。

**影响** 在咖啡店 WiFi 或公司内网跑 `better-trigger-worker` 的开发者,把一个
**无鉴权的任意任务触发接口**暴露给了整个子网:同网段任何人都能
`POST /api/v1/trigger` 执行你注册的任何 task、`POST /runs/:id/cancel` 取消运行、
`GET /runs/:id` 读走 payload 和 output(agent 场景里这里面往往是 prompt、
中间结果、有时是凭据)。

**建议**

1. 默认 `hostname: '127.0.0.1'`;
2. 加 `--host <addr>` 显式放开,并在放开且**未设 API key** 时打印醒目警告
   (甚至直接拒绝启动,要求 `--host` 与 API key 同时出现);
3. `docker-compose.yml:52` 的端口映射改成 `127.0.0.1:4848:4848`
   —— 容器内必须绑 `0.0.0.0`,但宿主侧应该只发布到 loopback。

---

## S2 · `CORS: origin '*'` 叠加默认无鉴权 {#s2}

**位置** `apps/worker/src/middleware.ts:9-13`

**现象** `cors({ origin: '*', allowMethods: [...POST, PATCH, DELETE...],
allowHeaders: ['Authorization', 'Content-Type'] })`,全局挂在 `*` 上
(`app.ts:36`)。

**影响** 即使按 [S1](#s1) 绑回了 loopback,**浏览器**仍然是一条进入路径:用户
访问的任意网页都可以对 `http://localhost:4848` 发跨域 `POST /api/v1/trigger`。
`Content-Type: application/json` 会触发预检,而 `origin: '*'` 正好放过预检 →
请求成立。默认无鉴权时,任何网站都能触发本机上的任务并读取 run 详情。

**建议** 默认只允许 dashboard 自己的来源:`http://localhost:*` /
`http://127.0.0.1:*`(dev vite 端口不固定,所以用函数式 origin 校验而不是通配),
其余一律拒绝;加 `--cors-origin <origin>` 供显式放开。设了 API key 的部署风险小得多
(浏览器拿不到 key),但默认路径必须是安全的那条。

---

## S3 · API key 用 `!==` 比较 {#s3}

**位置** `apps/worker/src/middleware.ts:26-32`

**现象** `if (token !== apiKey)` —— 短路比较,泄漏匹配前缀长度。

**影响** 低。要利用需要大量本地请求和稳定的计时测量,而这个服务本来就不是
面向公网的高价值目标。但修起来是几行的事,没有理由留着。

**建议** 先比长度,再 `crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))`。
顺便:未设 key 时的 `return next()` 路径可以加一条 startup 日志
("API 未鉴权,仅监听 127.0.0.1"),让这个状态是被知晓的而不是被遗忘的。

---

## S4 · 没有请求体上限,`batchTrigger` 没有条数上限 {#s4}

**位置** `apps/worker/src/routes/trigger.ts:22-39`、
`packages/kernel/src/runs.ts:345-372`

**现象** `await c.req.json()` 不设上限;`batchTrigger` 校验每个 item 的 `taskId`
是非空字符串,但**不限制 `items.length`**,然后在**单个事务**里逐条
`createRunIn`(每条 2 条 INSERT)。payload 原样 `JSON.stringify` 进 jsonb。

**影响** 一个请求就能把 daemon 打死:10 万个 item = 20 万条 INSERT 在一个长事务里,
期间队列相关的行被大量锁住;或者一个 500MB 的 payload 直接吃满进程内存。
本机误操作(一个写错的循环)和恶意请求在这里的效果一样。

**建议**

1. 加 body limit 中间件(hono 有 `bodyLimit`),默认 1MB 左右,可配;
2. `batchTrigger` 强制 `items.length <= 500`,超出返回 `bad_request`
   并在文档里写明分批;
3. 单个 payload 的字节上限(比如 256KB),超出 `bad_request` —— 大对象应该放
   对象存储、payload 里只传引用,这也是 durable execution 的通用建议。

---

## S5 · 错误响应把内部 `err.message` 原样返回 {#s5}

**位置** `apps/worker/src/app.ts:47-60`

**现象** 非 `KernelError` 的一切走
`{ error: { code: 'internal_error', message: err.message || 'internal error' } }`
+ 500。

**影响** pg 的错误信息可能包含表名、列名、约束名,连接层的错误可能包含主机名
甚至连接串片段。本地开发时这非常有用;一旦有人按文档"多机共享 PG"部署,
这就是免费的内部结构泄漏。

**建议** 按环境分叉:开发下保持现状(信息越多越好),生产下(`NODE_ENV=production`
或显式 `--production`)只返回一个通用 message + 一个 `requestId`,完整错误进
服务端日志。`KernelError` 那条分支不用改 —— 那些 message 是我们自己写的、
面向用户的文案。
