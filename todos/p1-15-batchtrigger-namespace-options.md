# P1-15 — `batchTrigger` 无法带 batch 级 options;per-item `env/projectId` 类型上存在却被静默丢弃

- 优先级:P1(正确性,staging 意图创建 prod run)
- 区域:sdk / core
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#15)

## 现状

- `packages/sdk/src/task.ts:61`:`TaskHandle.batchTrigger(items: Array<BatchItem<TPayload>>)`——没有 options 参数;`:256` 调 `requireDefaultInstance().batchTrigger(triggerItems)`,instance 的第二个(携带 namespace 的)参数从不传。
- `BatchItem.options` 的类型是完整 `TriggerOptions`(`task.ts:38-41`),含 `env`/`projectId`(`core/src/types.ts:114-121`);但服务端(`routes/trigger.ts:44` + `kernel/runs.ts:706-743`)只从 **batch 级** `body.options` 取 namespace——per-item 的 env/projectId 被静默忽略。
- 同样地,run 内 `hello.trigger(payload, { env: 'staging' })` 的 env 也被静默忽略(子 run 继承 `executor.namespace`,`task.ts:237`)。同一个选项在三个调用位置有两种含义、零诊断。

## 影响

`sendEmail.batchTrigger([{ payload, options: { env: 'staging' } }])` 通过类型检查,却创建 **prod** run——命名空间隔离(C2 花大力气做的)在 SDK 类型层面被自己的 API 打穿。

## 实现方案

1. `TaskHandle.batchTrigger(items, options?: TriggerOptions)`:新增第二参数,转发到 instance 的 namespace 参数(env/projectId 从 options 提取,语义与单发 `trigger` 一致)。
2. `BatchItem.options` 收窄为 `Omit<TriggerOptions, 'env' | 'projectId'>`——被忽略的字段从"静默丢弃"变成**类型错误**。
3. run 内 ctx 路径的 `TriggerOptions` 同样收窄(子 run 的 namespace 恒继承父,类型上就不该能写)——若改动面大,至少在 `task.ts:237` 收到显式 env 时打一条 warn 日志并在 sdk README 写明继承规则。
4. `packages/sdk/README.md` 的 batchTrigger 小节补 options 参数与 per-item 限制的说明;顺带补上 `projectId`(现在的 trigger-options 表格漏了它,`README.md:249-257`)。

## 验收标准

- 类型测试(`tsd` 或 vitest 的 expect-type):`BatchItem.options` 里写 `env` 编译报错;`batchTrigger(items, { env })` 通过。
- 运行时测试:`batchTrigger(items, { env: 'staging' })` 创建的 run 全部落 staging(HTTP body 断言 batch 级 options 携带 namespace)。
- 验收 e2e(batch 场景)全绿。

## 涉及文件

- `packages/sdk/src/task.ts:38-41`、`:61`、`:237`、`:256`
- `packages/core/src/types.ts:114-121`
- `apps/worker/src/routes/trigger.ts:44`、`packages/kernel/src/runs.ts:706-743`(行为参照,不必改)
- `packages/sdk/README.md:249-257`
