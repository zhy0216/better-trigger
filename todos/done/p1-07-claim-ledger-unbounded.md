# P1-07 — claimRuns 在持锁事务内无界读取整个 run_steps 账本

- 优先级:P1(性能/公平性,长 agent run 拖垮全 fleet claim)
- 区域:kernel
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#7)

## 现状

`packages/kernel/src/queue.ts:387-400`:claim 成功后为每个 run 读重放快照——

```sql
SELECT seq, kind, label, status, output, error, fingerprint
  FROM run_steps WHERE run_id = $1 … ORDER BY seq ASC
```

**没有 LIMIT**。单个 step output 有 256 KiB 上限,但 step 行数没有任何上限(kernel 里任何地方都没有)。这条查询跑在 claim 事务内部——该事务同时用 `FOR UPDATE SKIP LOCKED` 锁着整个候选窗口的 queue 行。对比:PF3 已经给 detail 读加了 `DEFAULT_DETAIL_STEPS_LIMIT = 500` / `MAX_DETAIL_PAGE = 5000`(`runs.ts:110-112`),claim 路径漏了。

## 影响

agent 型长 run(正是本项目的目标负载)累积几千 step 后,一次 claim 物化几百 MB 结果集;流式读取期间候选窗口的 queue 行全程被锁,同伴 worker `SKIP LOCKED` 跳过 → 一条肥账本让全 fleet 的 claim 吞吐劣化,而且每次 reclaim / resume / retry 重演一遍。

## 实现方案

1. **把账本读取挪出 claim 事务**:claim 事务只做 CTE 认领 + lease + fencing 递增并 COMMIT;随后在事务外按 run 逐个读快照。安全性论证:COMMIT 后该 run 的 lease/fencing 已归本 worker,`run_steps` 对已认领 run 是只追加账本(旧 fencing 的迟到写会被拒),事务外读不会读到撕裂状态。读取失败(连接错误)时按现有 claim 错误路径释放该 run。
2. **给快照加行数上限**:新 env `BETTER_TRIGGER_MAX_STEPS`(默认建议 10000,0 = 不限)。超限时该 run 以非重试 `AbortError` 失败,错误信息引导 `continueAsNew`(architecture.md P5 已排)。上限同时是对 run_steps 无界增长的第一道显式护栏。
3. 快照查询加 `LIMIT max_steps + 1` 用于探测超限,避免为判断"是否超限"再 count 一次。
4. `--help` / README / `.env.example` 记入新 env(与 p2-26 的单一来源表衔接)。

## 验收标准

- stub 测试:claim SQL 不再包含 run_steps 读取;快照读取带 LIMIT。
- 真 PG:构造 1.2 万 step 的 run,claim 后 run 以 AbortError 终态、错误信息含 `BETTER_TRIGGER_MAX_STEPS`;正常 run 的 crash/fencing/replay 验收场景全绿(快照移出事务不改变重放语义)。
- `claim-scan-bench.ts` 增加一个"窗口内含大账本 run"的用例,断言其余 run 的 claim 延迟不受其影响(锁窗口时间不含账本读取)。

## 涉及文件

- `packages/kernel/src/queue.ts:200-400`(claim 事务与快照读取)
- `apps/worker/src/main.ts`(env 解析)、`apps/worker/README.md`、`.env.example`
- `examples/basic/scripts/claim-scan-bench.ts`
