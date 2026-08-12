# P1-09 — cron 用 daemon 时钟算 next_run_at、用 DB now() 判定 due:时钟偏移触发重复 run

- 优先级:P1(正确性,重复真实副作用)
- 区域:kernel / orchestrator
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#9)

## 现状

- due 判定:`scanCron` 用 `next_run_at <= now()`(**数据库时钟**)。
- 写回:`orchestrator.ts:470-497` 起 run 后 `SET … next_run_at = $3`,`$3 = nextCronAt(pattern, tz)`(`orchestrator.ts:112-115`),即 croner 基于 **daemon 进程的 `new Date()`** 计算。
- 两个时钟之间没有任何"新值必须在 DB 未来"的守护。

## 影响

daemon 时钟落后数据库(VM suspend/resume、容器无 NTP、笔记本休眠唤醒——本项目"纯本地"定位下都常见)时:写回的 `next_run_at` 在 DB 看来仍 `<= now()`,下一个 1s tick 再次 due,再次起 run——偏移 5 分钟 × `*/1 * * * *` ≈ 300 个重复 run,每个都带真实副作用。反向偏移则静默延迟。`docs/backend-contract.md` §3.6 "错过的窗口不补跑" 的承诺在反方向被违反。

## 实现方案

1. due 扫描的 SELECT 顺带取回数据库时钟:`SELECT …, now() AS db_now`;`nextCronAt(pattern, tz, from)` 的 `from` 用 `db_now` 而不是进程 `new Date()`——croner 的计算基准从此与 due 判定同源。
2. 写回语句加钳制作为第二道防线:`next_run_at = GREATEST($3::timestamptz, now() + interval '1 second')`——无论计算侧发生什么,一次触发后的 schedule 绝不可能在下一 tick 立即再次 due。
3. `nextCronAt` 单测:显式传 `from` 的行为(现有签名已支持 `from ?? new Date()`,只需消除调用点的缺省)。
4. `docs/backend-contract.md` §3.6 补一句实现注记:cron 触发以数据库时钟为准,daemon 时钟偏移不影响正确性。

## 验收标准

- stub 测试:写回 SQL 含 `GREATEST`;due 扫描 SELECT 含 `now() AS db_now` 且 `nextCronAt` 收到它。
- 单测:`nextCronAt(pattern, tz, from)` 对给定 from 产生严格大于 from 的时刻。
- 真 PG(可并入 p1-22 suite):把一条 schedule 的 `next_run_at` 手动设为过去 5 分钟,连续跑 3 个 tick,断言只产生 1 个 run 且新 `next_run_at > now()`。
- e2e 验收场景(含 2s cron)全绿,无重复触发。

## 涉及文件

- `packages/kernel/src/orchestrator.ts:112-115`(nextCronAt)、`:470-497`(scanCron 写回)
- `packages/kernel/src/workers.ts:288`(如涉及注册路径的 next_run_at 初算,同样以 DB 时钟或钳制兜底)
- `docs/backend-contract.md` §3.6
