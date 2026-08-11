# better-trigger TODOs

这组 TODO 记录的是当前代码审查后最值得投入的改进项。每个条目都包含：

- 当前问题和影响
- 推荐的修复方向
- 可验证的完成标准

## 状态：全部完成 ✅

三个文件的所有条目均已实现、通过对抗式校验并提交，已归档到 `todos/done/`。

### P0：先保护正确性 ✅

- [done/01-correctness.md](./done/01-correctness.md) ✅
  - C1：step replay fingerprint 与不可变账本 ✅
  - C2：`env` / `project_id` 的真实隔离语义 ✅（方案 B：完整 namespace）
  - C3：JSON 序列化错误和持久化大小边界 ✅
  - C4：cron 注册和版本更新的竞态 ✅
  - C5：数据库引用完整性和状态约束 ✅

### P1：再处理数据量增长后的性能 ✅

- [done/02-performance.md](./done/02-performance.md) ✅
  - PF1：Dashboard 统计的时间窗口和全表扫描 ✅
  - PF2：轮询改为通知优先、轮询兜底 ✅
  - PF3：run detail / logs 分页和一致性快照 ✅
  - PF4：health/metrics 超时不能占满连接池 ✅
  - PF5：batch trigger 和 claim 路径的查询成本 ✅

### P1/P2：最后修复上线体验和工程护栏 ✅

- [done/03-operability.md](./done/03-operability.md) ✅
  - O1：修正过期的 Dashboard onboarding ✅
  - O2：API key 开启后 Dashboard 仍可用 ✅
  - O3：daemon 托管 Dashboard 静态资源 ✅
  - O4：统一版本来源和发布 smoke test ✅
  - O5：后端 lint、Dashboard 测试和 CI 覆盖 ✅
  - O6：网络暴露时的限流、审计和密钥轮换 ✅
