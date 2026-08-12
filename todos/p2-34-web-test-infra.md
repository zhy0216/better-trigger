# P2-34 — apps/web 的 vitest 靠未声明的提升依赖运行;无 vitest 配置,jsdom 靠每文件 docblock

- 优先级:P2(测试基建卫生)
- 区域:web
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」web #9)

## 现状

`apps/web/package.json`:`"test": "vitest run"`,devDependencies 有 `jsdom`、`@testing-library/*`,**没有 `vitest`**——它只经 bun 提升从根 devDependencies 解析。全仓 `find -name "vitest.config.*"` 零结果;`vite.config.ts` 无 `test` 块;环境靠每个测试文件的 `// @vitest-environment jsdom` docblock。

## 影响

O5 立起来的 51 个 dashboard 测试跑在一个未声明的依赖上(bun 换 isolated linker 或根依赖调整即断);新建 `.test.tsx` 忘写 docblock 会落进 node 环境,报 `document is not defined` 而不是任何有指向性的信息。

## 实现方案

1. `apps/web/package.json` devDependencies 显式加 `vitest`(与根同版本区间)。
2. `vite.config.ts` 加 `test: { environment: 'jsdom' }`(Vitest 读 vite config 的 test 键;或独立 `vitest.config.ts`,与现有 vite 配置合并方式取团队惯例)。
3. 删除各测试文件的 `@vitest-environment` docblock。
4. 验证 `turbo run test` 下 web 项目照常被收集、51 个用例数不变。

## 验收标准

- 根目录 `bun run test` 与 `cd apps/web && bun run test` 都绿,用例数不减。
- 新建一个无 docblock 的冒烟 `.test.tsx`(临时)确认默认落 jsdom,验证后删除。

## 涉及文件

- `apps/web/package.json:13,17-40`
- `apps/web/vite.config.ts`
- `apps/web/test/*.tsx`(删 docblock)
