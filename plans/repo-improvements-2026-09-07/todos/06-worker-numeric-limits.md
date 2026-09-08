difficulty: hard
agent: inherit

# Worker 计时器与连接配置的数值边界

对应 F11–F12。优先级 P1。依赖：04-namespace-pair-isolation.md（orchestrator 同文件）。不改 metrics/dashboard，不重做 SDK wait/result 契约。

## T1 · 在资源创建前校验实际进程 timer

- 要做什么：覆盖 CLI timer/cron/reaper/gc/stranded interval、直接 `startOrchestrator` 参数、runtime/embedded lease 推导的 heartbeat interval，以及相关直接 timer 输入。检查单次 setInterval/setTimeout 的有效范围，拒绝 NaN/Infinity/unsafe integer/溢出值。
- 预计修改：`apps/worker/src/cli.ts`、`runtime.ts`、`embedded.ts`、必要的 `waiters.ts` / `env-registry.ts`，`packages/kernel/src/orchestrator.ts`；对应 config-validation/runtime-validation/env-registry/kernel orchestrator 测试。保持 04 的 namespace 改动。
- 验收：2147483648 作为单次 interval 在开始任何循环/数据库注册前失败，不被缩为 1ms；有效上界与下界通过。lease 依据其派生 timer 和日期/存储边界设限，不能随意把所有 durable duration 限制为 24.8 天。保留 lease 最小值、有效默认值和禁用循环语义，错误明确命名参数。
- 前置依赖：04 合入。

## T2 · pool timeout/max 的直接调用与 env 保持一致

- 要做什么：校验 derivePoolConfig 和 createPool 选项的 finite/safe integer、连接 timer 范围、PG statement_timeout 范围；0=关闭的既有语义保留。配置在分配 pool/连接前失败，直接传 poolOptions 不能绕开。
- 预计修改：`apps/worker/src/pool-config.ts`、`apps/worker/test/pool-config.test.ts`、`packages/db/src/pool.ts`、`packages/db/test/pool.test.ts`；配置说明和 env-registry 对应规则。必要文档由本任务统一负责 CLI/env 相关内容，避免别的任务同改。
- 验收：错误类型、负值、分数、Infinity、unsafe integer、2147483648 timeout 被稳定拒绝；0 和默认值行为不变；可接受配置确实被 PG 接受。不要给 pool max 发明缺乏依据的任意业务上限。
- 前置依赖：无；与 T1 一起收敛配置边界。

验证：worker config/runtime/pool/env tests、db pool tests、kernel orchestrator tests；使用独占 PG 验证关键连接选项，最后完整仓库 gate 与 `bun run check:exports`。定时器边界优先使用 fake timers/构造函数 spy，不真实运行 1ms 洪泛。一个最终 commit。
