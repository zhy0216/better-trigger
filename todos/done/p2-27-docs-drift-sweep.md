# P2-27 — 文档漂移清扫:验收数量、僵尸环境变量、apps/web README、architecture 的 ctx 承诺

- 优先级:P2(文档正确性,一次性清扫 + 少量防回归)
- 区域:docs / README
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#11/#12-web、SDK #10)

## 现状(逐条核实过)

1. **验收场景数量三处过时**:`README.md:255` 写 "the 8 acceptance scenarios",而 `acceptance.ts:47-108` 的 `HARNESSES` 有 **17** 个(README:262-266 自己列了 17 个名字);`acceptance.ts:4` 写 "The sixteen scenarios";`examples/basic/README.md:98` 写 "all sixteen"。
2. **backend-contract 僵尸内容**:`docs/backend-contract.md:50` 表格仍列 `BETTER_TRIGGER_API_URL`(同文件第 10 行自己声明它"不复存在";全源码 grep 零命中);`:51` 与 §7 仍描述 "不设置时前端用 mock 数据" / "Alerts / Deployments 页面保持 mock"——`apps/web/src/api/hooks.ts:3` 明写 "No mock fallback",`src/data/mock.ts` 不存在。
3. **apps/web/README.md 三处失实**:命令全用 `pnpm`(repo 是 bun workspaces);源码地图列不存在的 `src/data/mock.ts` 且**漏掉整个 `src/api/`**(client/adapter/hooks/mergeRuns);末行 "playback position still persists to localStorage (`bt_playback`)" 与同文件 40 行前"绝不写 localStorage"的安全声明自相矛盾(代码 grep 零命中,安全声明才是对的,且有 `apiAuth.test.tsx:29-37` 背书)。
4. **architecture.md 的 ctx 承诺**:`:104` 与 `:204` 说 `ctx` 暴露 `idempotencyKey` / `attempt`("自动提供")——`RunCtx`(`sdk/context.ts:98-131`)两者都没有,`attempt` 只在 `ctx.run.attempt`。

## 实现方案

1. 数量类:`acceptance.ts` 的 suite 头输出改为打印 `HARNESSES.length`,散文数字全部删掉;`README.md:255` 改为不含具体数字的表述("every harness in …")或引用列表。
2. backend-contract:删 `:50` 僵尸行、修 `:51`、删 §7 的 mock 段落。
3. apps/web/README:命令换 bun;源码地图按当前树重生成(补 `src/api/` 四件);删 localStorage 句。
4. architecture.md:要么把 `:104`/`:204` 的承诺改为现实(`ctx.run.attempt`,幂等键经 `options.idempotencyKey` 传入),要么把 `ctx.idempotencyKey` 补进 `RunCtx`(倾向前者——加 API 不是文档清扫的事,若确要加另开 todo)。
5. 防回归(轻量):在 `acceptance.ts` 加一个启动断言/注释,提醒散文数字禁止回来;其余靠 review。

## 验收标准

- 上述四组文件逐条修正;全文 grep `BETTER_TRIGGER_API_URL`、`mock.ts`、`sixteen`、`the 8 acceptance` 零命中。
- `bun run test:acceptance` 头部输出正确数量。
- apps/web/README 的源码地图与 `find apps/web/src -type f` 一致。

## 涉及文件

- `README.md:255`、`examples/basic/scripts/acceptance.ts:4`、`examples/basic/README.md:98`
- `docs/backend-contract.md:10,50,51,§7`
- `apps/web/README.md`
- `docs/architecture.md:104,204`
