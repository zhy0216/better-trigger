# P1-21 — docker-compose 缺 `stop_grace_period`:Docker 默认 10s SIGKILL 对上代码 30s drain

- 优先级:P1(运维,一行修复)
- 区域:部署工件
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#21)

## 现状

`docker-compose.yml` 的 worker 服务只声明 build/container_name/restart/depends_on/environment/ports/command——没有 `stop_grace_period`。Docker 默认宽限 10s;`apps/worker/src/runtime.ts:122` 的 `SHUTDOWN_DRAIN_MS = 30_000`。

## 影响

`docker compose restart|stop|down` 对任何执行超过 ~10s 的 run 都是 drain 中途 SIGKILL:claim 不被交还,run 等 lease reaper 接管并烧一次 recovery。graceful-restart 验收场景证明**代码**做对了;发布的**部署工件**交付不了这个语义。README "A clean restart hands claims back without spending a retry attempt" 对 compose 用户不成立。

## 实现方案

1. worker 服务加 `stop_grace_period: 40s`(> SHUTDOWN_DRAIN_MS + handoff 余量),并加注释说明与 `SHUTDOWN_DRAIN_MS` 的排序关系。
2. `runtime.ts:122` 的 `SHUTDOWN_DRAIN_MS` 常量旁加对向注释:改这个值要同步 compose 的 stop_grace_period。
3. (依赖 p1-12)shutdown 兜底超时落地后,验证 40s 覆盖"drain 30s + 兜底路径"的最坏时序。

## 验收标准

- `docker compose up -d` 后触发一个 sleep 20s 的 run,`docker compose stop worker`:容器以 SIGTERM 优雅退出(exit 0),日志可见 drain 完成/hand-back,重启后该 run 不消耗 recovery。
- compose 文件通过 `docker compose config` 校验。

## 涉及文件

- `docker-compose.yml`(worker 服务)
- `apps/worker/src/runtime.ts:122`(注释)
