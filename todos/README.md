# better-trigger TODOs — 第四轮(2026-08-12 审查)

上一轮(01-correctness / 02-performance / 03-operability)已全部完成并归档到 `todos/done/`。

本轮来自 2026-08-12 的全库四方向审查(kernel+db、worker daemon、sdk+core、web+测试+CI),完整审查报告存于 GitMemo「better-trigger 第四轮审查改进点」。**每个问题一个文件**,文件内含现状证据(file:line)、影响、实现方案与验收标准。编号与审查报告对齐(01–21 为报告正文条目,22–36 为 P2/测试盲区)。

## 状态:待办

## 优先级与执行顺序

按下表顺序执行(P0 → 测试基建 → P1 按子系统 → P2)。「依赖」列标注的前置文件先做。

| # | 文件 | 一句话 | 依赖 |
|---|------|--------|------|
| 1 | [p0-01-fingerprint-drift-bypass.md](./done/p0-01-fingerprint-drift-bypass.md) ✅ | fingerprint 校验被 kind/label 漂移绕过,lenient 下旧输出喂给新代码 | — |
| 2 | [p0-02-dashboard-poll-self-abort.md](./done/p0-02-dashboard-poll-self-abort.md) ✅ | dashboard 轮询每 2s abort 上一请求,慢响应永远完成不了 | — |
| 3 | [p0-03-sdk-result-retry.md](./done/p0-03-sdk-result-retry.md) ✅ | `handle.result()` 无重试,daemon 滚动重启拒绝所有等待者 | — |
| 4 | [p1-22-kernel-pg-correctness-suite.md](./done/p1-22-kernel-pg-correctness-suite.md) ✅ | 真 PG correctness suite(先立测试床,后续 kernel 修复直接落用例) | — |
| 5 | [p1-04-triggerandwait-require-task.md](./done/p1-04-triggerandwait-require-task.md) ✅ | `triggerAndWait` 打错 task id → 父 run 永久 waiting | p1-22 |
| 6 | [p1-05-orphan-wait-nulls-order.md](./done/p1-05-orphan-wait-nulls-order.md) ✅ | 孤儿 wait 排序方向反了(ASC 默认 NULLS LAST) | p1-22 |
| 7 | [p1-06-waits-run-id-index.md](./done/p1-06-waits-run-id-index.md) ✅ | waits 缺 run_id 索引;唤醒查询不带 namespace 谓词 | p1-22 |
| 8 | [p1-07-claim-ledger-unbounded.md](./done/p1-07-claim-ledger-unbounded.md) ✅ | claim 在持锁事务内无界读取整个 run_steps 账本 | — |
| 9 | [p1-08-multi-namespace-plans.md](./done/p1-08-multi-namespace-plans.md) ✅ | ≥2 namespace 时 `IN (VALUES)` 让热路径索引全部失效 | p1-22 |
| 10 | [p1-09-cron-clock-skew.md](./done/p1-09-cron-clock-skew.md) ✅ | cron 用 daemon 时钟算、DB 时钟比 → 偏移时重复触发 | p1-22 |
| 11 | [p1-10-concurrency-work-notify.md](./done/p1-10-concurrency-work-notify.md) ✅ | 并发受限任务完成不发 work 通知,下一个 run 白等退避 | — |
| 12 | [p1-11-pool-sizing-loop-stall.md](./done/p1-11-pool-sizing-loop-stall.md) ✅ | 连接池无 sizing/超时;orchestrator 循环可永久停摆且零指标 | — |
| 13 | [p1-12-shutdown-races-deadline.md](./p1-12-shutdown-races-deadline.md) | drain 期间领新 run;shutdown 无兜底;信号 handler 装太晚 | — |
| 14 | [p1-21-compose-stop-grace.md](./p1-21-compose-stop-grace.md) | compose 缺 stop_grace_period,10s SIGKILL 对 30s drain | p1-12 |
| 15 | [p1-13-unhandled-rejection-policy.md](./p1-13-unhandled-rejection-policy.md) | 用户 task 的 unhandledRejection 直接杀 daemon | — |
| 16 | [p1-14-read-endpoints-limits.md](./p1-14-read-endpoints-limits.md) | 读端点零限流;长轮询不感知断连 | — |
| 17 | [p1-15-batchtrigger-namespace-options.md](./p1-15-batchtrigger-namespace-options.md) | batchTrigger 的 per-item env/projectId 静默丢弃 | — |
| 18 | [p1-16-lazy-async-hooks.md](./p1-16-lazy-async-hooks.md) | eager import node:async_hooks,edge/浏览器加载即炸 | — |
| 19 | [p1-17-client-timeout-registry.md](./p1-17-client-timeout-registry.md) | 超时误报"daemon 没起";预中止 signal 失效;registry 无校验 | p1-16 |
| 20 | [p1-18-dashboard-routing.md](./p1-18-dashboard-routing.md) | dashboard 无 URL 路由,deep-link fallback 无消费者 | — |
| 21 | [p1-19-security-headers-postmessage.md](./p1-19-security-headers-postmessage.md) | 静态资源零安全头;postMessage 无 origin 校验 | — |
| 22 | [p1-20-connection-state-key-prompt.md](./p1-20-connection-state-key-prompt.md) | connection 全局竞写频闪;key 被拒无反馈 | — |
| 23 | [p2-23-result-typing-timeout.md](./p2-23-result-typing-timeout.md) | result() 无泛型;30s 超时静默返回非终态 | p0-03 |
| 24 | [p2-24-retry-policy-undefined.md](./p2-24-retry-policy-undefined.md) | 显式 undefined 覆盖 retry 默认值 → NOT NULL 500 | — |
| 25 | [p2-25-dead-sdk-surface.md](./p2-25-dead-sdk-surface.md) | pollMs 死参数、core 幽灵 RunHandle、过时注释 | — |
| 26 | [p2-28-namespace-sweep-marker.md](./p2-28-namespace-sweep-marker.md) | namespace sweep 的 marker 可被 SELECT 列表满足 | p1-06 |
| 27 | [p2-29-drop-unused-queue-index.md](./p2-29-drop-unused-queue-index.md) | 删除无查询使用的 queue_available_priority_idx | — |
| 28 | [p2-30-unify-reenqueue.md](./p2-30-unify-reenqueue.md) | scanWaits 开码 re-enqueue 与 enqueue() 语义分叉 | — |
| 29 | [p2-31-keyless-rate-limit-bucket.md](./p2-31-keyless-rate-limit-bucket.md) | 无 key 时 per-key 限流坍缩成单一 anon 桶 | p1-14 |
| 30 | [p2-32-route-validation-consistency.md](./p2-32-route-validation-consistency.md) | intQuery/clampQuery 两套校验;/runs?status=垃圾 返回空页 | — |
| 31 | [p2-33-runs-list-filters-actions.md](./p2-33-runs-list-filters-actions.md) | 搜索假空态;cancel/retry 已实现无 UI | p1-18 |
| 32 | [p2-34-web-test-infra.md](./p2-34-web-test-infra.md) | web 的 vitest 未声明依赖、无配置、jsdom 靠 docblock | — |
| 33 | [p2-35-acceptance-ports-timeouts.md](./p2-35-acceptance-ports-timeouts.md) | 验收场景端口冲突;无 per-harness 超时 | — |
| 34 | [p2-36-sdk-instance-tests.md](./p2-36-sdk-instance-tests.md) | instance.ts 324 行零单测;registry 跨副本无测试 | p0-03, p1-17 |
| 35 | [p2-26-env-single-source.md](./p2-26-env-single-source.md) | env 旋钮单一来源表(收口本轮新增的全部 env) | p1-07, p1-11, p1-13, p1-14 |
| 36 | [p2-27-docs-drift-sweep.md](./p2-27-docs-drift-sweep.md) | 文档漂移清扫(数量、僵尸变量、web README、ctx 承诺) | 建议收尾做 |

依赖说明:「p1-22」依赖指该文件的真 PG 验收用例落进 correctness suite(先做 p1-22 则直接加用例;若顺序颠倒,按 finish-todo 的 blocked-on 规则回填)。p2-26 与 p2-27 是收口清扫,放在最后避免被中途改动再次漂移。

## 与 roadmap 的关系

- p1-22 交付 `docs/architecture.md` P2 里 "vitest + 真 PG correctness suite" 的主体;fault-injection harness 与 LISTEN/NOTIFY 专项仍留在 roadmap P2。
- 本轮全部是既有代码的缺陷/风险修复,不包含 roadmap P3–P6 的新功能(events、agent 原语、plugins 等)。P3 建议在 P0 与 kernel 组(p1-04…10)落地后再启动:signal 内核的不变量正需要 p1-22 的测试床来验收。

## 归档

- [done/01-correctness.md](./done/01-correctness.md) ✅(C1–C5)
- [done/02-performance.md](./done/02-performance.md) ✅(PF1–PF5)
- [done/03-operability.md](./done/03-operability.md) ✅(O1–O6)
- [done/p0-01-fingerprint-drift-bypass.md](./done/p0-01-fingerprint-drift-bypass.md) ✅(kind/label 漂移一律硬失败)
- [done/p0-02-dashboard-poll-self-abort.md](./done/p0-02-dashboard-poll-self-abort.md) ✅(usePoll 改为自我重排 setTimeout,不再 abort in-flight)
- [done/p0-03-sdk-result-retry.md](./done/p0-03-sdk-result-retry.md) ✅(result() 预算内重试瞬态 5xx/网络错误,waiter 关停映射 503)
- [done/p1-22-kernel-pg-correctness-suite.md](./done/p1-22-kernel-pg-correctness-suite.md) ✅(test/pg 真 PG 套件,fencing/suspend/cancel/幂等/索引计划)
- [done/p1-04-triggerandwait-require-task.md](./done/p1-04-triggerandwait-require-task.md) ✅(waitForChildRun/retryRun requireTask,task_not_found → AbortError,RunCtx.triggerAndWait)
- [done/p1-05-orphan-wait-nulls-order.md](./done/p1-05-orphan-wait-nulls-order.md) ✅(孤儿扫描独立 LIMIT,timer 积压不再挤占孤儿恢复)
- [done/p1-06-waits-run-id-index.md](./done/p1-06-waits-run-id-index.md) ✅(waits_run_idx 迁移,wakeParentIfWaiting 带 namespace 谓词)
- [done/p1-07-claim-ledger-unbounded.md](./done/p1-07-claim-ledger-unbounded.md) ✅(账本读取移出 claim 事务,BETTER_TRIGGER_MAX_STEPS 上限 + stepsTruncated)
- [done/p1-08-multi-namespace-plans.md](./done/p1-08-multi-namespace-plans.md) ✅(热路径逐 namespace 扫描,single-ns 平铺等值,双 namespace Index Scan)
- [done/p1-09-cron-clock-skew.md](./done/p1-09-cron-clock-skew.md) ✅(nextCronAt 以 DB 时钟为基准,写回 GREATEST 钳制 + NULL 守卫)
- [done/p1-10-concurrency-work-notify.md](./done/p1-10-concurrency-work-notify.md) ✅(complete/failTerminal/cancel 带 concurrency_key 时发 work 通知)
- [done/p1-11-pool-sizing-loop-stall.md](./done/p1-11-pool-sizing-loop-stall.md) ✅(业务池 sizing/超时,checkout 计数,loopLastSuccess 健康 gauge,loop-hang 自愈)
