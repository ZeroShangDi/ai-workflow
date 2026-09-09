# Handoff Snapshot — AWF v0.2.0 重构执行现场

> 生成 2026-09-09（awf run 主会话压缩点）。目录：`/Users/v-shangjunhao/MyProject/cc-control-wt-v0.2.0/cc-control`
> 分支 `wt/cc-control-v0.2.0`（repo root=cc-control-wt-v0.2.0，本项目为子目录 cc-control）。端口 8787 被当前 awf run 占用（禁嵌套真 run；真 run/双 run 回归留 T1-098）。本快照供冷启动续接。

## Goal

在 AWF v0.2.0 重构上继续执行剩余任务（当前进度：dev 到 T1-088、门禁至 T3-007 及 review T2-*，全量 87 文件 / 749 例绿）。剩余按 .awf/state.json 任务图推进：前端工程（web/ React：Diagnostics / WBS-Tree / 产物托管 等后续）、真实 run 自托管回归 T1-098、各模块/review 门禁。纪律：只本地 commit 不 push；commit 不带 Co-Authored-By；按任务 ID 用 MCP 落账 awf_task_complete(done, result/files/architecture/commits/verdict)；问题按门禁闭环派生修复。

## State

- 主线 commit 至 `ac108e5`（T1-088 Decisions 迁移）；此前依次 b2cffb0(T1-105)/4bb0d96/…/6de4395(T1-077)/f4f7132(T1-078)/7103b48(T1-079)/7a5d8cb(T1-080)/fe71a83(T1-081)/5fba8bd(T1-082)/73d7196(T1-083)/17df9cb(T1-085)/434bab8(T1-086)/23a4b68(T1-087)。门禁 pass：T2-021/022/023/028/033/035、T3-005/006/007。
- 代码事实（标识符原样）：
  - server 常驻控制平面：`src/server/run-host.cjs`（createRunHost：单 agent 经 run-driver.decideChain/gateCompletionHook，多 agent 经注入 runScheduler；submit/status/pollEvents 事件环；default 单 run 'default'=单写）；`run-slot.cjs`（per-sid ready/busy/decision/contextReady 内存隔离）；`run-registry.cjs`（多槽 ctx+adapter+sm，ensureLayout per-run 目录 .awf/runs/<sid>）。server.cjs 挂 `/run/*`（submit/status/events/state/{mode,task/active,gate,backup,apply}/oneshot）、`/shutdown`、`/awf/state`(?sid 分片 .awf/runs/<sid>/state.json)、`/status`(?sid 槽态)、`/hook`(sid 早路 handleSidHook)、`/theme.css` `/common.js`（共享资产托管）；空闲回收 main 进程 CC_SERVER_IDLE_MS + CC_SERVER_IDLE_CHECK_MS。
  - cli 薄化：`run.js` runCommand→driveSingle(fresh/resume/attach, runId=sid)→observeRun(follow TTY/决策中继)；mode 经 client.setRunMode；ensureServer 存在即复用（去 kill-by-port，他项目占用报错）；run 结束只关 tmux 保留 server；`run-batch.js` 多 agent 仅路由（宿主 batch 传输未接线）；`run-client.js` 提交/轮询/读/写端点方法 + slotStatus(sid)。
  - 单写者：src/cli 零 lib/state.js 写函数；gate-fix 在 `src/server/gate-fix.js`；awf-state MCP 18 tools 语义保留、env CC_AWF_STATE_SERVER=1 时读/写经 server（GET /awf/state + POST /run/state/apply，带 CC_SID）；run 会话 env 注入 CC_AWF_STATE_SERVER=1/CC_PORT（ensureSession）；plan（无 server）离线直写。
  - sid 贯穿：run-context runSessionName=cc-<sid>；run-id resolveRunStamp；DecisionStore {runStamp,runsDir} per-run 决策隔离；gateway/session/oneshot MCP 带 sid。
  - 注册/渲染单源：plugin/config.json + plugin/settings.json；plugin-config.js resolvePluginAssets/renderRepoSettings；render-config 输出各 plugin.json+.mcp/hooks + 本仓 .claude/settings.json（<pkg>→绝对 plugin 根，gitignore 不提交）；根 .mcp.json 已删。
  - 前端 `web/`（Vite+React，依赖未装、沙箱不联网）：`src/api/client.js` createApiClient({base,sid,httpFetch,wsFactory}) http+ws 带 sid；`views/dashboard-model.js`+Dashboard.jsx（T1-087：总览/任务/阶段/指标/send/respond/stop/启停，WS+3s 轮询）、`views/decisions-model.js`+Decisions.jsx（T1-088：列表/override，WS decision.record）；App 按 ?view=dashboard|decisions&sid；web dev proxy /run /awf /status → AWF_SERVER（缺省 127.0.0.1:8787）。
  - 托管页共享资产 src/server/theme.css + common.js（window.AWF_COMMON esc/fmtDuration/taskRow/renderTaskList），4 html head 已注入 link/script。
- 测试：`npx vitest run tests/unit tests/integration` = 87 文件 / 749 例绿；e2e 两既有失败为已知基线（run.e2e 端口占用、e2e-smoke 日志路径，docs/bugs/recovery-baseline-e2e-failures.md）。关键套件：run/run-batch/run-client/run-slot/run-registry/sid-naming/run-stamp-sid/run-host/scheduler/server-lifecycle/two-project-smoke/awf-state*/awf-session*/awf-oneshot*/render-config/dashboard-shell/web-* 模型。
- .awf/state.json 只能经 awf-state MCP 改；任务 exec/verdict 均在 state。

## Tried

- 按 /w-dev <id> 顺序执行 40+ 任务（T1-105…T1-088）与门禁（全 pass），固定流程：读 state 定义 → 改/补测试 → lint+全量 → commit → awf_task_complete。React 组件不纳入仓库 vitest（纯模型层测）；web 依赖留真实 dev 安装。

## Decisions

- 已定勿翻：server 常驻单写者控制平面、cli 薄化经 run-client、sid 贯穿多 run、MCP 收 server 薄代理（env 门控，缺省离线直写零回归）、注册/渲染单源、前端 web 迁移经 api+WS（模型层先测）。
- 遗留（exec 已标注，不阻塞已过门禁；真 run 前补/验证）：宿主 batch 传输、curl hooks 带 &sid + 每 run CC_SID/AWF_BASE env 注入、决策闸门 per-run 全分支、/run/state/apply last-writer-wins 缺 CAS、前端 Diagnostics/WBS-Tree/产物托管。

## Evidence

- 最近 commit ac108e5 后全量 87 文件/749 例绿。回退锚点若回归：跑 run-related + server-lifecycle + awf-* + render-config + web 模型套件。
- 各任务 exec/verdict 留存 .awf/state.json。

## Feedback

- 全局：只 commit 不 push、无 Co-Authored-By、直接执行、听指挥不扩范围。压缩轮只判断+快照。

## Next

读 .awf/state.json 取下一 pending dev（预计 web Diagnostics/WBS-Tree 等前端、或进入 T1-098 前的接线任务）→ 固定流程执行 → 保持全量绿 → T1-098 自托管真 run（含双 run/决策闸门）前补齐 exec 标注的遗留。上下文再告警时重复本流程。
