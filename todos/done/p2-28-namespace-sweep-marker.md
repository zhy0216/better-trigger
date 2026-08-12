# P2-28 — C2 namespace sweep 测试的 marker 可被 SELECT 列表满足,守不住它要守的不变量

- 优先级:P2(测试有效性;p1-06 的漏网正是它放过的)
- 区域:kernel / testing
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」kernel #10)

## 现状

`packages/kernel/test/namespace-isolation.test.ts` 的 sweep 断言"每条涉及 scoped 表的语句都带 namespace 标记",但 marker 是 `/(project_id|env|namespaces)/` 对**整条 SQL 文本**的裸子串匹配。于是:

```sql
SELECT id, run_id, project_id, env, step_seq, fingerprint
  FROM waits WHERE child_run_id = $1 AND kind = 'run' AND status = 'pending'
```

(`runs.ts:1471-1474`,p1-06 的问题语句)因为 **SELECT 列表**里有 `project_id, env` 就通过了——WHERE 里根本没有 namespace 谓词。C2 的"完整 namespace 隔离"验收在机制上是可绕过的。

## 实现方案

1. marker 只匹配谓词部分:解析语句取 `WHERE` 之后的文本(含 JOIN ON),要求命中 `project_id\s*=`、`(alias.project_id, alias.env) IN (VALUES` 或 `namespaces` 参数形式之一;UPDATE/DELETE 同理;INSERT 检查列清单含 project_id/env。
2. 收紧后跑全量 sweep,预期至少揪出 `runs.ts:1471`(p1-06 修掉)与 `getRunDetail` 的 waits 查询——**本文件应与 p1-06 同批或紧随其后**,否则测试直接红。
3. 对确属全局语义的语句(如 notify 通道、workers 心跳)维持现有豁免清单机制,逐条注明豁免理由。

## 验收标准

- 人为构造"SELECT 列表带 project_id、WHERE 不带"的语句,sweep 必红(加一个自测用例锁住 marker 本身)。
- p1-06 落地后全量 sweep 绿;豁免清单每项有一行理由。

## 涉及文件

- `packages/kernel/test/namespace-isolation.test.ts`
- `packages/kernel/src/runs.ts:1471-1474`、`:2163-2167`(配合 p1-06)
