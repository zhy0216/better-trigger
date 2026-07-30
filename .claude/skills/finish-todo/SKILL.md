---
name: finish-todo
description: 按 todos/README.md 给出的顺序,用 ultracode(Workflow 多 agent 编排)逐个做完 todos/ 下的待办文件;每做完一个就跑校验、git commit、并把该文件 git mv 到 todos/done/。用户说 /finish-todo、"把 todos 做完"、"按顺序清 todo" 时使用。
disable-model-invocation: true
---

# finish-todo

把 `todos/` 当成一条有序的工作队列,一次只推进一个文件,每个文件一个 commit。

**本 skill 显式授权你调用 `Workflow` 工具**(ultracode 多 agent 编排)——每个 todo 文件一个
workflow。不要用单个 inline agent 代替:条目需要独立实现 + 独立对抗式校验。

`args` 可选,用来缩小范围:文件名或序号(`01`、`04-security.md`)、优先级(`P0`)、
或条目 id(`c3`、`t1`)。不给 args 就做全部。

---

## 0. 前置检查(失败就停,不要硬上)

1. `git status --porcelain` —— 工作区必须干净。有未提交改动时**停下来问用户**是先提交、
   先 stash 还是忽略;不要自己替他决定。
2. 当前分支是默认分支(`main`)时,先建工作分支:`git switch -c finish-todo/<yyyy-mm-dd>`。
   用户明确说"就在 main 上提交"时才留在 main。
3. 确认校验命令可用:`bun run typecheck`、`bun run build`(仓库里有 `test` script 就一起跑)。

## 1. 定顺序

读 `todos/README.md`,顺序来源按优先级:

1. README 里显式写出的顺序 —— "优先级" 表格(P0 → P1 → P2)和 "## 文件" 列表;
   两者冲突时以优先级表格里首次出现的文件为先。
2. README 没写顺序 → 文件名数字前缀升序。

跳过 `todos/README.md` 本身和 `todos/done/` 下的一切。

开工前把有序计划报给用户(一行一个文件,附条目 id),然后**直接开始**——除了 §0 里
那两种情况,不要再征求批准。

## 2. 主循环(严格串行,一个文件一轮)

后面的文件常常依赖前面的修复,所以**绝不跨文件并行**。对顺序里的每个文件:

### a. 读

Read 整个 todo 文件,枚举其中的条目(`## C1 · …{#c1}` 这种小节)。每条记下
id、标题、涉及的源文件路径。

条目带 `[roadmap]` 标记的:先读 `docs/architecture.md` 确认它属于哪个阶段。如果是后续
阶段的大改造,**不要动**,记为 deferred 并在本轮报告里点出来。

条目依赖尚未完成的后续文件时(例:回归测试依赖 `05-tests-and-dx.md` 里的测试框架),
不要提前把那个框架搭起来 —— 记为 blocked-on,等到那个文件那一轮再回填。

### b. 一个 workflow 做完这个文件

条目多于 6 条时拆成两个 workflow(先 P0/P1 条目,再其余),别让单个 workflow 超过
~15 个 agent。

Workflow 里**不做任何 git 操作** —— commit 和 mv 由你在 workflow 返回后做,agent 并发
跑 git 会互相踩。

脚本骨架(照这个结构写,prompt 里填进真实的条目正文):

```js
export const meta = {
  name: 'finish-todo-file',
  description: '实现单个 todo 文件里的条目,逐条对抗式校验',
  phases: [{ title: 'Plan' }, { title: 'Implement' }, { title: 'Verify' }],
}

const { file, items } = args // items: [{ id, title, body, hints }]

const PLAN = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'string' } },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['items', 'files'],
      },
    },
  },
  required: ['groups'],
}

const IMPL = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['done', 'blocked', 'deferred'] },
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['id', 'status', 'summary'],
}

const VERDICT = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    fixed: { type: 'boolean' },
    evidence: { type: 'string' },
    problems: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'fixed', 'evidence'],
}

phase('Plan')
const plan = await agent(
  `读 ${file} 和它引用的源文件。对这些条目:${items.map((i) => i.id).join(', ')},
   列出每条会改到的文件,然后分组:会碰同一个源文件的条目必须在同一组,互不相交的分开。
   只做分析,不要改任何代码。`,
  { label: 'plan', schema: PLAN },
)

phase('Implement')
// 组间并行,组内串行 —— 同一个源文件绝不被两个 agent 同时编辑
const grouped = await parallel(
  plan.groups.map((g) => async () => {
    const out = []
    for (const id of g.items) {
      const item = items.find((i) => i.id === id)
      out.push(
        await agent(
          `在这个仓库里落地 ${file} 的条目 ${id}:${item.title}
           条目原文:
           ${item.body}
           要求:只改这一条相关的代码,不顺手重构、不动无关文件;沿用周围代码的风格;
           改完自己跑 \`bun run typecheck\` 确认没坏。判断这条属于后续 roadmap 阶段、
           或依赖尚不存在的基础设施时,返回 status:'deferred'/'blocked' 并说明,不要硬做。`,
          { label: `impl:${id}`, phase: 'Implement', schema: IMPL },
        ),
      )
    }
    return out
  }),
)
const impls = grouped.filter(Boolean).flat().filter(Boolean)

phase('Verify')
const verdicts = await parallel(
  impls
    .filter((im) => im.status === 'done')
    .map((im) => () =>
      agent(
        `对抗式校验条目 ${im.id}。读 \`git diff\` 里 ${(im.files || []).join(', ')} 的改动,
         再读条目原文,回答:这个改动真的消除了条目描述的问题吗?有没有引入回归、
         改错锁序、破坏幂等?默认怀疑 —— 证据不足、只是"看起来对"就判 fixed:false,
         并在 problems 里写清缺什么。`,
        { label: `verify:${im.id}`, phase: 'Verify', schema: VERDICT },
      ),
    ),
)

return { impls, verdicts: verdicts.filter(Boolean) }
```

`args` 用真正的 JSON 值传(`args: { file: "...", items: [...] }`),不要传 JSON 字符串。

### c. 处理 workflow 的结论

- verifier 判 `fixed: false` 的条目:自己读 diff 判断谁对。verifier 说得对就补修,然后
  再跑一次那条的校验;补不动就把这条降级成未完成。
- `blocked` / `deferred` 的条目:保留原样,不要删,不要假装做了。

### d. 仓库级校验(硬门槛)

依次跑 `bun run typecheck` → `bun run build`(有 `test` script 就再跑 test)。
失败就修;修不动就**停下,不 commit**,把失败输出原样报给用户。
每个 commit 都必须能通过这三步。

### e. 归档 + commit(同一个 commit 里)

本文件**所有**条目都完成并通过校验时:

```bash
mkdir -p todos/done && git mv todos/0X-<name>.md todos/done/
```

再更新 `todos/README.md`:把指向该文件的链接改成 `done/0X-<name>.md`,并在优先级表格里
把对应行标 ✅。

有条目没完成时:**不移动该文件**。在文件顶部加一小节写清剩余条目和卡住的原因,已完成
的部分照常 commit,README 里该文件标为部分完成。

然后一次 commit(代码 + mv + README 更新):

```bash
git commit -m "$(cat <<'EOF'
fix(kernel): 01-correctness C1–C8

- C1 scanWaits 改为 SKIP LOCKED
- ...

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

commit message 跟着仓库现有风格(Conventional Commits,`git log --oneline` 看得到);
type/scope 按实际改的包选(`fix(kernel)`、`chore(ci)`、`docs` …),标题里带上文件名和
条目区间,正文一行一条。

### f. 报一行进度,进入下一个文件。

## 3. 收尾

- `git log --oneline <起点>..HEAD` 列出本次所有 commit。
- 汇总:哪些文件归档进 `todos/done/`、哪些条目遗留(blocked / deferred / 校验没过)及原因。
- **不 push、不开 PR**,除非用户要求。

## 硬性规则

- 一次一个文件,严格按顺序;不许跨文件并行。
- 每个 commit 必须通过 typecheck / build(有测试则含 test)。
- 只动条目要求的代码;不顺手重构、不改无关文件、不升级依赖。
- 条目没真做完就不能移进 `todos/done/`,也不能在报告里说完成。
- 中途出现需要用户拍板的事(要不要动 roadmap 大改造、校验一直修不过),停下来问,
  别自己扩大或缩小范围。
