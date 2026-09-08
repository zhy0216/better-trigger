difficulty: medium
agent: inherit

# JSON 数据保真与错误边界

对应 F2–F4。优先级 P1。前置依赖：无。只处理 core 的序列化和诊断，不改 kernel fingerprint；后者交给依赖本任务的 03。

## T1 · 保留 JSON 值语义

- 要做什么：修复 `canonicalizePlain` 的自有特殊键丢失；梳理 canonicalize 对 boxed primitive、Date、数组、toJSON(key) 的处理，既按 JSON.stringify 的值语义转换，也递归稳定排序。toJSON 返回自身不能无限重入。
- 预计修改：`packages/core/src/serialize.ts`、`packages/core/test/serialize.test.ts`；必要时新增 core 内部 helper 并调整 `packages/core/src/index.ts`，方便 03 复用。不能引入运行时依赖。
- 验收：JSON.parse 创建的 `__proto__` 等自有键完整保留，原型不变；boxed Number/String/Boolean、root/对象属性/数组位置的 toJSON key、self-return、Date、循环引用和非 JSON 值均有明确结果。普通嵌套 JSON 的原有 canonical 字节不变，Unicode 字节数和 maxBytes 限制仍准确。
- 前置依赖：无。

## T2 · 诊断路径本身不得再次抛错

- 要做什么：防护 `serializeError` 中 Error 属性访问、String/JSON 转换，以及 `safeSerializeJson` catch 内的诊断转换，使用保守字符串 fallback；保留可正常读取的原始诊断。
- 预计修改：`packages/core/src/errors.ts`、`packages/core/src/serialize.ts`、`packages/core/test/errors.test.ts`、`packages/core/test/serialize.test.ts`。
- 验收：无原型 thrown value、抛错的 message/name/stack/toString/toJSON getter、toJSON 抛无原型值、循环、BigInt 均不让失败报告路径抛异常；所有 error message 为 string，失败返回稳定 serialization_error。不能吞掉本来可保留的常规 Error 信息。
- 前置依赖：无；与 T1 在同一文件中一起实现。

验证：`bun run --cwd packages/core test`；完整仓库 gate；`bun run check:deps` 确认 core 仍零依赖。输出给 03 的共享行为说明和普通 JSON golden vectors，一个最终 commit。

## 完成记录

在独立分支 `herdr/plan-repo-20260907-02-json` 完成 T1/T2；只修改 core 的两个实现文件、两个测试文件及本任务归档/README 行。没有修改 kernel fingerprint、plan.md、其他任务状态或 roadmap。实现阶段未执行 rebase/merge/push/PR；协调器授权后的 rebase 复核见文末。

### 逐条验收证据

| 验收项 | 结果与回归证据 |
| --- | --- |
| 自有特殊键、原型不变 | `serialize.test.ts` 的 special keys 回归同时覆盖根/数组内的 `__proto__`、`constructor`、`prototype`、`toString`，断言完整 JSON、输入未变、解析后值相等及原型仍为 `Object.prototype`。排序对象使用 null prototype，赋值不触发 setter。 |
| boxed Number/String/Boolean | 参数化覆盖 root、对象属性、数组位置及 NaN；另测 Number/String 自定义 coercion、Boolean 内部值、boxed 值上的 toJSON 优先执行。boxed BigInt 与 primitive BigInt 在所有位置均拒绝。 |
| toJSON(key) 与 self-return | 覆盖 root `""`、属性名、数组 `"0"`、原始 receiver、非 enumerable getter 只读一次、共享 self-return 值每位置一次调用；返回对象不再调用其 toJSON，返回 boxed Number 正确拆箱；function/array 的 toJSON 也按原生语义执行。 |
| Date、数组与非 JSON 值 | 覆盖有效/无效 Date、数组空槽、自定义 map 不执行、数组非索引 BigInt 忽略、undefined/function/symbol 的对象省略及数组 null、NaN/Infinity/-0、root 无 JSON 拼写的稳定失败。 |
| 循环与异常 | 数组循环、self-return 后的真实循环返回 `serialization_error`；共享但非循环的对象成功；toJSON/property getter 抛错保留原 TypeError message。 |
| 普通 JSON canonical 字节 | 下方 8 组 golden vectors 在修复前后的 `safeSerializeJson` 均通过；修复后也通过公共 `canonicalStringify` 导出。整数索引键仍按原生数字顺序，其余键按 UTF-16 code unit 排序。 |
| Unicode 与 maxBytes | 保留原有 `中` UTF-8 检查；toJSON 转换后的 `{"a":"中","z":"😀"}` 恰为 22 bytes，cap=22 成功、cap=21 返回实际 bytes=22 的 `payload_too_large`。 |
| Error 属性与转换防护 | `errors.test.ts` 分别覆盖 message/name/stack getter 抛错，保留另外两个可读字段，getter 每次只读一次；非 string 字段安全转 string，不能转换时 message 使用 `unreadable error message`，name/stack 省略。 |
| 诊断路径不得再次抛错 | 无原型对象、循环、BigInt、抛错的 toJSON/toString getter/method、Symbol.toPrimitive、revoked Proxy/getPrototypeOf trap 均覆盖。JSON 与 String 都失败时使用固定 `[unprintable value]`；`safeSerializeJson` catch 复用 `serializeError`，所有失败 message 为 string。 |
| 正常诊断不丢失 | 原有 Error/TypeError message/name/stack、普通字符串/JSON 保持；JSON 可读时不调用坏 toString，Error 属性可读时不调用坏 toJSON/toString；JSON 失败时保留可读 String fallback。 |
| core 零运行时依赖 | 未修改 package.json/bun.lock；`bun run check:deps` 通过；共享实现只依赖标准 JSON/Object/TextEncoder 及 core 内部错误 helper。 |

### 交接给 03：共享行为

```ts
import { canonicalStringify, safeSerializeJson } from '@better-trigger/core';

// canonicalStringify(value: unknown): string | undefined
// safeSerializeJson(value, maxBytes?, field?): SerializeResult
```

`canonicalStringify` 位于 `packages/core/src/serialize.ts`，通过已有 `src/index.ts` 的 `export * from './serialize'` 自动导出，不需要额外入口或依赖。测试从 core index 导入；ESM/CJS 构建的类型文件均包含该签名。

入口先用原生 `JSON.stringify` 解析用户值语义，再 `JSON.parse` 得到纯 JSON 树、递归稳定排序并生成最终字节。用户 getter/toJSON 按原生遍历顺序执行；排序发生在值转换之后，因此有副作用的 getter 结果也与原生顺序一致。共享 self-return 对象不会被视作循环，真正的循环由原生 JSON 拒绝。

root undefined/function/symbol（及 toJSON 返回这些值）返回 `undefined`；BigInt、循环、抛错 hook 会向调用方原样抛出。`safeSerializeJson` 将其转换为稳定失败。03 必须显式处理 `undefined` 返回值；不得把 core 的 BigInt/circular 失败改成合法 payload。本任务没有迁移 kernel 旧 BigInt marker 或 fingerprint v1；由 03 处理调用方契约和回放测试。

普通 JSON 的既有字节保持不变。以前被丢弃的特殊键或被误转的 boxed/toJSON 输入现在正确表示，03 的指纹可能因此改变；不要覆盖既有 ledger 或无理由整体升级 v1。实现多一次 JSON 解析和中间树分配；未做吞吐/内存性能基准，也不承诺保留 `JSON.rawJSON` 高精度数字的原始字面量（共享入口基于解析后的 JSON 值）。

语义参考：[ECMAScript SerializeJSONProperty](https://tc39.es/ecma262/multipage/structured-data.html#sec-serializejsonproperty)。

### 普通 JSON golden vectors

完整输入和字节断言见 `packages/core/test/serialize.test.ts` 顶部的 `goldenVectors`；下表输入按 JavaScript 表达式书写，输出栏为最终 JSON 文本。

| 输入 | canonical JSON |
| --- | --- |
| `null` | `null` |
| `'中😀'` | `"中😀"` |
| `{ z: [], a: {} }` | `{"a":{},"z":[]}` |
| `{ b: 2, a: { y: 1, x: 0 } }` | `{"a":{"x":0,"y":1},"b":2}` |
| `[{ z: 3, a: 1 }, null, [true, false, 'x']]` | `[{"a":1,"z":3},null,[true,false,"x"]]` |
| `{ '10': 'ten', '2': 'two', b: 2, '01': 'one', a: 1 }` | `{"2":"two","10":"ten","01":"one","a":1,"b":2}` |
| `{ z: '\n"\\', a: '\ud800' }` | `{"a":"\ud800","z":"\n\"\\"}` |
| `{ v: 1, kind: 'step', label: 'fetch', input: { z: [3, { y: 2, a: 1 }], a: true }, code: null }` | `{"code":null,"input":{"a":true,"z":[3,{"a":1,"y":2}]},"kind":"step","label":"fetch","v":1}` |

### 全部验证命令与日志

Bun 1.4.2；依赖使用当前 worktree 的 `bun install --frozen-lockfile` 安装。修复后根 gate 设置 `TURBO_CACHE_DIR="$PWD/.turbo/task-02-cache"`，避免从其他 worktree 恢复 dist。完整日志保留在 `/tmp/bt-02-json-evidence-zD6CoC/`，各次运行使用不同日志，不覆盖失败。

| 命令 | 结果 | 日志文件 |
| --- | --- | --- |
| `bun install --frozen-lockfile` | 通过，588 packages；lockfile 未变 | `01-install.log` |
| `bun run --cwd packages/core test`，新增回归、旧实现 | **失败**：21 failed / 91 passed，112 tests；包含特殊键丢失、boxed 值、toJSON key 与诊断再次抛错 | `02-core-before-fix.log` |
| `bun run --cwd packages/core test`，实现修复后 | 通过，112/112 | `03-core-after-fix.log` |
| `bun run --cwd packages/core test`，共享 API 契约补齐后 | 通过，115/115，6 files；根 tests 再次验证最终稀疏数组 fixture | `04-core-shared-api.log` |
| `bun run lint`，首次 | **失败**：稀疏数组测试字面量触发 `no-sparse-arrays`；8/9 tasks（7 个无关 task 命中 Turbo 默认共享缓存，未进行构建） | `05-lint.log` |
| `bun run lint`，修复 fixture 后 | 通过，9/9 tasks，0 cache，6.439s | `06-lint-fixed.log` |
| `bun run typecheck` | 通过，14/14 tasks，0 cache，4.748s；在本 worktree 实际构建依赖 | `07-typecheck.log` |
| `bun run build` | 通过，7/7 tasks，15.664s；5 项仅复用本 worktree 刚产生的缓存，worker/docs 实际构建 | `08-build.log` |
| `bun run test -- --force`，独占临时 PostgreSQL 16 | 通过，156 files / **1,634 tests**，13/13 tasks，0 cache，45.151s；kernel 59 files / 435 tests，**无 PG test skip** | `09-root-test-pg.log` |
| `bun run check:deps` | 通过，core 无运行时依赖，SDK 仅依赖 core | `10-check-deps.log` |
| `git diff --check` | 通过；归档后另检查完整 staged diff | `11-diff-check.log`、`12-final-diff-check.log` |

根 tests 的包级统计：core 115、db 78、SDK 174、testing 104、web 180、worker 548、kernel 435，总计 1,634；比 1,594 基线增加 40 项，测试文件总数仍为 156。19 acceptance harnesses 属于协调器最终集成 gate，本 todo 没有额外声称执行。

PG runner 为 `/tmp/bt-02-json-evidence-zD6CoC/run-root-pg.ts`（通过 Bun 执行）。使用 mkdtemp 独占 `/tmp/bt-02-json-pg-3Jx3lC`、随机 loopback port 38023、合成 role，通过 `DATABASE_URL` 注入 Turbo 已声明的 test.env。`finally` 已停止并删除该 cluster；`09a-initdb.log`、`09b-postgres.log`、`09c-pg-start.log`、`09d-pg-stop.log` 保留创建/停止证据。此 URL/端口不可作为后续任务的固定数据库。

### 首次失败、修复与保留的基线

本任务的 21 项回归失败已由 core 修复解决；lint 的稀疏字面量改为先创建普通数组再 `delete value[1]`，保持空槽语义和断言，没有关闭 lint 规则。

计划中原有第一次真实 PG 根测试的复制反馈失败及后续复核通过均保留，原文为：

```text
FAIL test/runView.test.tsx > Inspector content and copy feedback > puts the error before a collapsed large payload and copies the complete hidden content
AssertionError: expected '' to be 'Copied' // Object.is equality
```

后续原计划复核通过为 1,594 tests / 19 acceptance harnesses；本任务这一次 PG 根 gate 中 web 180 项通过，但不能据此宣称已修复 F17，仍由 08 调查。构建沿用既有 TypeScript 7 experimental API 警告，没有升级工具链。T1/T2 无剩余 blocker，03 尚需完成 kernel 共享入口迁移与真实回放验证。

### 集成阶段 rebase 复核

协调器明确持有集成锁并授权后，在本任务 worktree 执行 `git rebase main`，目标为 `b7265e3acf244cb52dd430a6b5ccceb9b632af79`。无冲突；已合入的 09 workflow 和归档与 main 完全一致，README 的 09 已完成行保留，本任务只改变自己的 02 行。`git range-diff ba0b9b8..e74a101 b7265e3..HEAD` 确认 rebase 后任务补丁一致；两个 core 实现与两个测试文件均无变化。本次仅 amend 本归档以保留复核证据，仍为 main 之上的一个任务 commit，没有 merge/push 或切换原 checkout。

新日志目录 `/tmp/bt-02-json-rebase-ZBtkCb/`；旧日志及首次失败原文全部保留。使用本 worktree 新建的 `TURBO_CACHE_DIR="$PWD/.turbo/task-02-rebase-cache"`，依次重新校验：

| 命令 | rebase 后结果 | 日志 |
| --- | --- | --- |
| `bun run --cwd packages/core test` | 115/115，6 files | `02-core.log` |
| `bun run lint` | 9/9 tasks，0 cache，5.334s | `03-lint.log` |
| `bun run typecheck` | 14/14 tasks，0 cache，4.096s | `04-typecheck.log` |
| `bun run build` | 7/7 tasks，15.668s；5 项仅复用本 worktree 刚产生的缓存 | `05-build.log` |
| `bun run test -- --force` | 156 files / 1,634 tests，13/13 tasks，0 cache，37.608s；kernel 59 files / 435 tests，无测试 skip | `06-root-test-pg.log` |
| `bun run check:deps` | core 零运行时依赖，SDK 仅依赖 core | `07-check-deps.log` |
| `git diff --check`、任务 patch / staged diff 检查 | 全部通过 | `10-diff-check.log` |

根 tests 由新日志目录内的 `run-root-pg.ts` 驱动，通过 mkdtemp 新建独占 `/tmp/bt-02-json-pg-klkzOK`、随机 loopback port 45473、全新合成 role；`DATABASE_URL` 传入 Turbo test.env。`finally` 已停止并清理该 cluster，`09d-pg-stop.log` 保留停止证据。本轮没有验证失败，没有源码修复；既有 TypeScript 7 experimental API 警告保持。
