# W3-005 模块测试门禁 — 非真结构核查（T3-005）

> 2026-09-09 · kind=test（非真模块核查，不跑整套真实测试）
> 范围：cli 薄化 + client + 常驻生命周期（T1-058/059/060/061/062/063/064/065/066/067/104）
> 真 run 全流程回归由 T1-098 承担，本门禁只做结构/验收点自检。

## 模块 acceptance → 结构证据

| 模块验收点 | 结构证据 | 判定 |
|---|---|---|
| cli 由 run 司机 → 薄终端面（无任务选择/阶段推进/调度） | run.js：`runCommand→driveSingle(fresh/resume/attach)→observeRun/follow`，编排全在 `run-host.cjs`；CLI 零 `findNextTask/saveState/markTaskActive` | ✔ |
| 新增 server client（HTTP 提交/状态/事件 + 写端点） | `run-client.js`：`submitRun/runSnapshot/pollRunEvents/getState/setRunMode/markRunTaskActive/runGateComplete/backupRun`，端点路径与 server 全 27 路由逐条一致（T2-021 pass） | ✔ |
| cli 调度写路径改经 server run api → 单写者成立 | `/run/state/{mode,task/active,gate,backup}`；src/cli 零 lib/state.js 写函数；gate-fix 归位 src/server（T2-023 pass）；server-lifecycle 并发冒烟 20+40 写不丢不坏 | ✔ |
| server 常驻生命周期（复用/空闲回收/stop；run 结束不关） | ensureServer 存在即复用（无 kill-by-port，T1-063）；CC_SERVER_IDLE_MS 空闲回收 + /shutdown（T1-064）；server-lifecycle 冒烟：空闲自动退出 code0、shutdown 优雅退出 | ✔ |
| 死代码清理（messaging/inbox / open tree CLI 渲染） | messaging.js 已删、bootstrap/session-launch/run-context 去 socket 参数；open tree 去 renderTree 指向 web（T1-065/066）；grep 仅剩注释引用 | ✔ |
| --resume/--attach 重连 + attach/follow 终端跟随 | driveSingle 挂接续观（不重复提交）+ store 落盘进度；run-follow TTY 重绘（T1-059/060；T2-022 pass） | ✔ |
| 现有测试适配后全绿（e2e 两既有环境失败除外） | unit+integration 75 文件 / 704 例绿（run 相关 38、client 124、lifecycle 3、gate 4 等）；e2e 两个既有失败属文档已知基线 | ✔ |

## 遗留（不阻塞本门禁，链路已标注）

1. 宿主单 agent executor：收尾 settle 回退 / 每任务上下文压缩待补（真实长 run 依赖）→ T1-098 真机回归验证。
2. run-client `API_ENDPOINTS` 与 server `api.cjs API_CATALOG` 双表、`/api/v1` 路由挂载时收拢单源（后续模块）。
3. 多 agent 宿主 batch 传输未接线，--multi-agent 暂经 run-batch live 路由（run.js 无调度）。

## 结论

模块 acceptance 结构/验收点全部成立；无阻断问题 → verdict: pass。
