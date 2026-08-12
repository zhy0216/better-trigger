# P2-31 — 无 key 部署时 per-key 限流维度全体坍缩到一个 `anon` 桶

- 优先级:P2(运维语义)
- 区域:worker
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」worker #7)

## 现状

`apps/worker/src/middleware.ts:204-229`:`configuredApiKeys()` 为空时 auth 直接 `next()`,从不设置 `authKeyId`;`rate-limit.ts:131-137` 回落 `c.get('authKeyId') ?? 'anon'`——所有调用方共享 `key:<endpoint>:anon` 一个桶。文件头声明的性质 "one noisy client cannot starve its neighbours" 在**默认配置**(无 key、loopback)下完全不成立:一个本地脚本打满 50 rps,别的调用方全部 429。

(中间件挂载顺序本身已核实无误:cors → audit → auth → rateLimit → bodyLimit → routes → dashboardStatic。)

## 实现方案

1. 无 key 配置时,per-key 维度回落到连接维度:`keyId = 'ip:' + socket.remoteAddress`(`audit.ts:240-245` 已经在读同一来源,提取成共享 helper);loopback 场景下不同本地进程仍同 IP——文档写明这个边界(本地多进程互相争用属预期,全局桶仍生效)。
2. 桶表按 keyId 的基数做上限守卫(现有实现若已有按 key 清理机制则确认覆盖 ip 前缀键;没有则加简单 LRU/过期,防伪造 XFF 场景——注意我们不信任 XFF,用 socket 地址,基数天然有限)。
3. worker README 网络姿态小节补一句:per-key 维度在无 key 时按来源地址分桶。
4. `rate-limit.test.ts` 增加无 key 时两个不同 remoteAddress 各自成桶的用例。

## 验收标准

- 无 key:A 地址打满速率,B 地址不受影响;全局桶行为不变。
- 有 key:行为与现状完全一致。

## 涉及文件

- `apps/worker/src/middleware.ts:204-229`、`apps/worker/src/rate-limit.ts:131-137`
- `apps/worker/src/audit.ts:240-245`(helper 提取)
- `apps/worker/test/rate-limit.test.ts`、`apps/worker/README.md`
