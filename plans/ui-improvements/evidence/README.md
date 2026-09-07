# UI 验收证据

2026-09-05 在当前工作区源码的 Vite 预览 http://127.0.0.1:5173 上使用本机 Chrome 验证。以下是最终主要截图，记录中的其他截图路径指向验收时的临时文件。

| 页面 | 尺寸与主题 | 数据来源 | 截图 |
| --- | --- | --- | --- |
| Runs | 1440px、深色、comfortable | Playwright page.route 受控 fixture | [桌面运行列表](runs-1440-dark-comfortable.png) |
| Runs | 375px、亮色、compact | 受控 fixture | [移动运行列表](runs-375-light-compact.png) |
| Tasks | 1440px、深色、comfortable | 独立预览数据库的 live API | [桌面任务列表](tasks-final-1440-dark-comfortable.png) |
| Schedules | 390px、亮色、compact | 独立预览数据库的 live API | [移动定时任务](schedules-final-390-light-compact.png) |
| Run detail | 1440px、深色、Trace | 受控 fixture | [桌面运行详情](run-detail-final-1440-dark-trace.png) |
| Run detail | 390px、亮色、Details | 受控 fixture | [移动运行详情](run-detail-final-390-light-details.png) |

Tasks/Schedules 使用新建的本地示例数据库，未写用户业务数据库。异常、长内容、写操作、复制失败和日志分页通过浏览器请求拦截验证；fixture 未进入产品源码或真实服务。

机器可读报告：

- [Runs 布局与交互](runs-report.json)；[最终颜色复核](runs-final-colors.json)。
- [Tasks/Schedules 布局与交互](tasks-schedules-report.json)；[最终主题复核](tasks-schedules-final-report.json)；[无运行样本统计复核](tasks-statistics-final-report.json)。
- [Run 详情布局与交互](run-detail-report.json)。

矩阵覆盖 375/390/768/1440px、深色/亮色和 comfortable/compact。缩放边界使用 720×480 CSS 视口模拟 1440×960 下 200% 缩放后的可用布局空间，未自动设置浏览器原生缩放。正常页面无新增 console/page error；预期失败 fixture 的 HTTP 500/503 资源错误单独记录。

最终文字对比度抽测：Runs 深色最低 6.55:1、亮色最低 5.23:1；占位文字 7.63:1 / 6.07:1；Tasks/Schedules 最低 5.63:1；Run 深色最低 6.63:1、亮色最低 5.25:1。抽测不涵盖所有自定义配色组合。

整仓 build、typecheck、lint、test 均通过；1494 个测试通过、100 个条件性测试跳过。前端 21 个测试文件、180 个测试通过。完整交付说明见 [计划验收记录](../plan.md#实施验收记录)。
