# P1-16 — SDK 顶层 eager import `node:async_hooks`:edge/浏览器环境模块加载即失败

- 优先级:P1(SDK 可移植性,与"零依赖可安心 import"卖点冲突)
- 区域:sdk
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#16)

## 现状

`packages/sdk/src/registry.ts:15`:`import { AsyncLocalStorage } from 'node:async_hooks'`,并在 `:36` 模块加载时就实例化。import 链 `index.ts → instance.ts/task.ts → context.ts → registry.ts` 使它无条件到达每个消费者。`tsup.config.ts` target node18。

README(`:12-14`)承诺 SDK "zero runtime dependencies… safe to import into a web server or a CLI"。但 ALS 只有 **daemon 内**执行 task 时才需要(ctx 检测);应用侧触发只需要 fetch。

## 影响

`import { betterTrigger } from 'better-trigger'` 在 Vercel Edge、无 `nodejs_compat` 的 Cloudflare Workers、浏览器 bundle 中于模块加载期直接失败。应用为一个自己用不到的能力背上 Node-only 硬约束。

## 实现方案

1. 把 ALS 获取改为惰性 + 环境守护,注意 SDK 是 ESM/CJS 双构建:
   - 新建 `als.ts`,导出 `getExecutorStorage(): AsyncLocalStorage<T> | undefined`;
   - 实现:首次调用时 try/catch 加载 `node:async_hooks`——CJS 构建下用 `require`,ESM 构建下用 `createRequire(import.meta.url)`(tsup 对两种格式分别产出;验证产物,必要时用 `typeof require !== 'undefined'` 分支);不可用则缓存 `undefined`;
   - `registry.ts` 存储惰性 slot 而不是实例;`currentExecutor()` 在 storage 为 undefined 时返回 undefined(应用进程里本来就恒为空)。
2. daemon 侧(`better-trigger/internal` 缝)首次真正使用 ALS 时必然处于 Node/bun,惰性加载必成功——不需要 daemon 改动,但加一条断言:daemon 环境下 storage 必须非 undefined,否则抛清晰错误。
3. 冒烟测试:vitest 用 alias 把 `node:async_hooks` stub 成 throw 的模块,断言 `import 'better-trigger'` 成功、`betterTrigger({url}).trigger(...)`(mock fetch)可用、`currentExecutor()` 返回 undefined。
4. registry 的跨副本共享语义不受影响(slot 仍挂在 `Symbol.for` 上);与 p1-17 的 registry 版本校验改动同文件,建议排在其前后相邻实施。

## 验收标准

- edge 模拟测试(async_hooks 不可用)全绿:import 不炸、trigger 可用。
- Node/bun 下 daemon 的 ctx 检测(`triggerAndWait` in-run)行为不变,现有 e2e 全绿。
- `check:exports`(publint + attw)通过,双格式产物均验证。
- README 的 "safe to import" 卖点补一句:edge/浏览器可用于触发(ctx 检测自动降级)。

## 涉及文件

- `packages/sdk/src/registry.ts:15,28-39`、新建 `packages/sdk/src/als.ts`
- `packages/sdk/src/context.ts`、`packages/sdk/tsup.config.ts`(验证,不一定改)
- `packages/sdk/test/`(新增 edge 冒烟)
- `README.md:12-14`、`packages/sdk/README.md`
