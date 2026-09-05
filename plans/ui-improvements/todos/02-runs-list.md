difficulty: medium

# Runs 列表与筛选

优先级：P1。模型：flash。前置依赖：01-responsive-shell 全部完成并合并。一个 worktree、一个最终 commit；与 03、04、05 可并行。

## T1 · 响应式运行行与工具栏

- **工作**：桌面保留可扫描的对齐列，小屏按状态/任务为主、run ID/耗时/触发方式/版本/开始时间为辅重排；每条运行维持唯一的键盘打开入口。状态筛选组换行或局部滚动，搜索栏有明确名称，所有状态与 Live/Paused 操作可达。将页面布局移入独立样式并直接 import。
- **预计修改文件**：`apps/web/src/screens/RunsList.tsx`、新增 `apps/web/src/screens/runs-list.css`；`apps/web/test/runsList.test.tsx`。
- **验收**：390、768、1440px 下无页面水平溢出；375px 边界也能访问完整状态集合和主要运行信息；超长 task/run ID 不撑破布局，全文可以查看；行仍可通过点击、Enter、Space 打开；状态 aria-pressed 与 Live/Paused 语义保留。样式使用页面前缀，不修改共享组件、全局 CSS、App 或 API hooks。
- **前置依赖**：01-responsive-shell。

## T2 · 区分空态并支持筛选恢复

- **工作**：未筛选且无数据时说明尚未产生运行；筛选无匹配时显示对应空态和清除筛选入口，一次清空 status + taskId。可显示已加载条数和当前跟随状态，不声称它是服务端总数或全局统计。保留初始加载/错误、分页中/失败和重试提示。
- **预计修改文件**：`apps/web/src/screens/RunsList.tsx`、`apps/web/src/screens/runs-list.css`、`apps/web/test/runsList.test.tsx`。
- **验收**：清除筛选后请求不再含 taskId/status，环境和 live 状态保持；无筛选空态不误称筛选无匹配；taskId 和 status 仍交由服务端筛选，不新增改变查询语义的客户端过滤。已加载计数与当前渲染数据一致；暂停轮询、恢复即时刷新、loadMoreError 和重试入口不回退。
- **前置依赖**：01-responsive-shell；本文件 T1。

## T3 · 验证运行浏览行为与布局

- **工作**：沿用服务端搜索、完整状态词汇和 toolbar 可访问性测试，补充空态分支/联合筛选清除的行为测试；检查当前真实数据和隔离 fixture 中的长字段及分页错误。
- **预计修改文件**：`apps/web/test/runsList.test.tsx`，以及 T1/T2 的必要修正。
- **验收**：运行 `bun run --cwd apps/web typecheck`、`bun run --cwd apps/web lint`、`bun run --cwd apps/web test test/runsList.test.tsx`。用浏览器检查三个主尺寸、深/亮主题及 comfortable/compact，记录筛选/空态/加载更多/暂停恢复结果；CSS 布局不以 JSDOM 通过代替验证。不修改真实业务运行来制造测试状态。
- **前置依赖**：本文件 T1、T2。
