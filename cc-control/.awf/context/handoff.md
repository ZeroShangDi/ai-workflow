# Handoff Snapshot — T1-105 server run-host 接线（待实现）

> 生成：2026-09-08（会话为 17:52 run 的主会话，任务 T1-105 已派发、未实现）
> 目录：`/Users/shangjunhao/Project/ai-workflow/ai-workflow/cc-control-wt/cc-control`
> 分支：`wt/cc-control-v0.2.0`（git worktree，隔离开发基线，基线 commit `1a9c6bd`）
> 交接对象：重开后的 Claude（冷启动读本文件 + 下方 architecture 引用即可续接 T1-105）

## Goal

实现 **T1-105**（wbsRef `W3-003`，deps `T1-057`，当前 `pending`）：
让 **server 真正托管 run 编排** —— `server.cjs` 接线 `run-driver.cjs`（单 agent 阶段链）+ `run-scheduler.js`（多 agent）+ `gateCompletionHook` 进**常驻 run 循环**，暴露 **run 提交端点 + 事件订阅（先轮询/可订阅桩，真实 WS 留 T1-091）**；使 `cli/run.js` 可改薄为「提交 run→订阅事件展示→人机应答中继→收尾」。**保持单 run 全流程行为不变**（正跑在自托管 live run 上，不得破坏 cli/server 现行路径）。

验收（T1-105 acceptance）：server 实际托管 run 编排（单 agent 阶段链经 run-driver、多 agent 经 run-scheduler live 接线 + run 提交/事件端点）；run.js 提交后由 server 驱动；单 run 全流程行为不变；相关单测绿。

## State

- T1-105 本次派发后**尚未实现**（工作树无对应改动）。基线 commit `1a9c6bd` 只含「W3-003 各接缝模块 + 单测」，全部**零 live 接线**。
- 已上抛**落地边界决策给用户（A/B/C，见 Decisions），decisionPending 挂起、尚未选**。用户上一条指令改为「记录当前上下文到 .awf 确保重开可续」→ 本轮只落盘，不写实现代码。
- 现状代码事实（均已实测确认，标识符原文）：
  - `src/server/server.cjs`（967 行）＝旧 relay 单块：HTTP + `/hook` 中继（SessionStart/Stop/SubagentStart/Stop/PreToolUse AskUserQuestion/PostToolUse）+ ready/busy + decision gate + SubagentStop 落账（`settleSubagent` 解析 `RESULT` 写 state）。**无 run 提交端点、无常驻 run 循环、未 import 下方任一接缝模块**（仍走 `tmux.cjs` 单会话）。导出：`server/start/stop/_getState/_resetForTest/setDecision/clearDecision/setReady/setBusy/waitReady`。
  - `src/cli/run.js`（526 行）＝**唯一真实 driver**：`runCommand`（起环境 ensureServer/ensureSession/writeRunSettings + dashboard）→ `runLoop`（单 agent：`findNextTask`→`maybeCompactContext`→`executeTask`(`/send`→`waitForReady`→决策处理→`settleTask` 收尾协商)→门禁 `handleGateCompletion`）→ 收尾 `mode=idle`+cleanup。多 agent 时动态 import `run-batch.js`。
  - `src/cli/run-batch.js`（189 行）＝多 agent 集成：调 `src/server/run-scheduler.js` 的 `runScheduler`（CLI 拥有调度权），dispatcher 经 `subagentDispatch` 模板 + `POST /send`，`waitAnyDone`=轮询 state + `/status` decisionPending + 读 `subagent-failed.jsonl`/`subagent-needs-input.jsonl`，门禁走 `run-driver.gateCompletionHook(handleGateCompletion)`。
  - `src/server/run-driver.cjs`（71 行，纯规则，CJS）：`STAGE_CHAINS`(simple=DEV→COMMIT/medium=DEV→TEST→COMMIT/complex=DEV→DOCS→REVIEW→TEST→COMMIT)、`decideChain/classifyComplexity/nextStage/assertStage`、`gateCompletionHook(projectRoot,{handleGateCompletion,kinds=['review','test']})`。**阶段链函数无 live 调用**；`gateCompletionHook` 仅被 run-batch live。
  - `src/server/run-scheduler.js`（168 行，纯逻辑，**ESM**）：`runScheduler({projectRoot,cfg,dispatcher,waitAnyDone,onTaskComplete})`。被 cli/run-batch live。内部 makeQuota/makeRunning/pickFromPool 未导出。
  - `src/cli/run-client.js`（79 行，scaffold）：`createRunClient({port,http,sleep})` → submit(`/send`)/respond(`/respond`)/status()/waitReady()/subscribe()（轮询 status 桩，事件仅 `{type:'status'}`）。`API_ENDPOINTS` 端点表。**生产无人调用**。
  - `src/server/api.cjs`（scaffold）：`API_CATALOG`(20+ 条 legacy + `/api/v1/*` 别名)、`createRouter().dispatch`、`assertHandlersComplete`。**live server 未挂载 router**（`/api/v1/*` 目前 404）。
  - `src/server/app.cjs`（scaffold）：`createServerApp({projectRoot,sid,env})`→ctx/stores/config.infra/config.run/health/onShutdown/shutdown。不监听端口。
  - `src/server/host.cjs`（scaffold）：`createHost({sessionName})` tmux 原语参数化（多 run 用 `cc-<sid>`）。仅被 `src/adapters/ports.cjs:21` 引用。
  - `src/server/hook-adapter.cjs`（scaffold）：`translateHook/createHookAdapter`。PreToolUse/PostToolUse/未知 → `[]`（**不产 AskUserQuestion/决策事件**——决策闸门若经 adapter 接会丢，须另设消费者）。
  - `src/server/statemachine.cjs`（scaffold）：`createStateMachine/createStateMachineRegistry`（idle/ready/busy/deciding/paused/error；**无 stopped 态**）。used-by-nobody。
  - `src/lib/events.cjs`（scaffold）：`EVENT_DEFS`(run.started/stopped/phase、task.started/done/blocked、agent.started/stopped、usage/metrics/decision.record)、`HOOK_EVENT_MAP`、`createEventBus`、`wirePersist`。
  - `src/lib/gate-loop.cjs`（live）：`buildFixTarget/verdictSummary`。`src/cli/gate-fix.js`（live）：`handleGateCompletion`（loadState→gateFixMeta→gateFixPrompt→spawnGateFixTask→saveState）。
  - `src/lib/state.js`（ESM，live）：loadState/saveState/setWorkflowMode/markTaskActive/getNextTask/findNextTask/peekReadyTasks/EXCLUSIVE_KINDS(commit)/buildScopeIndex/filesConflict/MAX_RECHECK=3/gateFixMeta/spawnGateFixTask/backupState。
  - `src/lib/session/client.js`（live）：SERVER_PORT（config 单源）/`READY_TIMEOUT=1800000`(30min 已改)/POLL_INTERVAL/baseUrl/httpPost/httpPostJson/getStatus/sendText/sendCmd/sendRespond/getContextReady/waitForReady/autoSelect/sleep。run.js/run-batch 依赖它。
  - `src/lib/run-context.cjs`（live）：buildRunContext({sid,projectRoot,env})→runSessionName/port/各路径；无 sid 时单 run 布局。
  - CJS/ESM 边界注意：server.cjs 与 run-driver.cjs 是 CJS；run-scheduler.js / state.js / plugin-bridge.js / run.js 是 ESM。server 侧组装 run-host 需处理该边界（现由 run-batch 这个 ESM 桥接）。

## Tried

- 已用两个 Explore 子代理（只读）完成设计意图 + 代码/测试双地图，结论一致：
  - 设计意图源：`.awf/logs/0.2.0-2026-09-07T13-32-37/main.log`（L1625-1665、L3134-3194：T1-058 曾因「run.js 是唯一真实 driver，server 常驻托管未落地」被推迟）；`0.2.0-2026-09-07T16-54-59/main.log`（L129-171：用户选「重排」→ 新建 T1-105 作 T1-058 前置，T1-058 deps 改 `['T1-105']`）。`docs/discuss/architecture-notes.md` L100-141、`docs/discuss/multi-run-server-architecture.md`（单实例常驻+sid 远期方向）。bug 记录 `docs/bugs/t1058-prereq-appended-tail.md`（T1-105/104 曾排队尾致依赖倒挂，已手工重排）。
  - 目标形态（多日志原文）：编排（调度/阶段链/决策/门禁）搬进**常驻 server 进程**；cli 只剩「提交 run→订阅事件→应答→收尾」。真实 run/双 run 回归留给 **T1-098**。
- 方案三选一（重排时用户已选一次）：**重排（推荐）** = 先 server run-host 接线、T1-058 保持 pending 后再薄化（即本任务 T1-105 的本意）。扩 T1-058 / 强制薄化 均被否。

## Decisions

- 【本轮挂起】T1-105 **落地边界 A/B/C 待用户选择**（decisionPending 已上抛，未答）：
  - **A（严格分工，推荐）**：只做 server 侧 —— server.cjs 接线 run-driver+run-scheduler+gateCompletionHook 常驻 run 循环 + run 提交/事件端点 + 单测；run.js 本任务不动（保持 driver），薄化留 T1-058。不重复 T1-058、不碰 live driver 宿主；「run.js 提交后由 server 驱动」到 T1-058 才真闭环。
  - **B**：server 托管 + run.js 改提交/订阅/应答一次做掉（与 T1-058 验收重叠；改 live driver 风险最高）。
  - **C**：最小切片 —— 先加 run 提交/事件端点 + run-client.submit/subscribe 桩 + 单测；run-driver/run-scheduler 常驻接线做成可注入纯逻辑层，不真迁 driver 宿主。
- 已确认的既有方向（前序 run 决策，勿推翻）：T1-058 薄化依赖 server 真托管 → **先 W3-003(server 常驻) 后 W3-005(cli 薄化)**；保持单 run 全流程行为不变是硬约束；真实回归在 T1-098。
- 测试漂移待修：`tests/unit/run.test.js` TC17 必失败（假设 waitForReady 超时 300s、`advanceTimersByTimeAsync(310000)`，但 `client.js READY_TIMEOUT` 已改 30min/1800000）→ 须同步常量或测试。

## Evidence

- 单测基线：相关 13 文件 / 155 例，**154 过、1 败**（run.test.js TC17，原因见上）。改前基线绿：run-driver 6 例、scheduler TC-S1~S8 滑动窗口+门禁闭环+MAX_RECHECK、run-batch、server-api、server-app、host、statemachine、run-client、events、hook-adapter、run-context/run-settings/run-resume。
- `tests/integration/server.test.js` 是 server.cjs monolith 行为最大回归网（~58 项，直接调 `setBusy/setReady/waitReady/_resetForTest`；TC7 锁「启动即绑 CC_PROJECT、换 env 不改绑」——server 顶层单例 ctx，改造勿破坏导出面/ready-busy 语义）。
- `run-driver` 阶段链函数生产无 live 调用者（仅 gateCompletionHook live）→ server run-host 引入阶段链推进属**新增行为**，纯规则已被 run-driver.test.js 钉死可复用。
- `run-scheduler` 契约由 scheduler.test.js 最强锁定（真实 loadState 读写 tmp .awf/state.json；dispatcher/waitAnyDone 注入）。
- `hook-adapter` 明确「不产 AskUserQuestion/决策事件」且被 hook-adapter.test.js 锁定；决策闸门仍内联 server.cjs `/hook`。若改 `/hook` 收口须补决策消费者，否则行为断裂。
- events 类型与 statemachine 状态集不同构（Stop→run.stopped，但 statemachine 无 stopped 态；Stop 多解析为回 ready/busy 延续）。
- 端口 8787 为 config 单源（`plugin/config.json` port，CC_PORT 可覆盖；run-context 装配），非硬编码。
- 相关 task 详情在 `.awf/state.json`：T1-105 / T1-058(薄化 run.js, deps=[T1-105]) / T1-056(client 基座 done) / T1-057(去硬编码 done) / T1-091(轮询→事件订阅) / T1-098(真 run 回归)。

## Feedback

- 用户本次指示：**把当前已知上下文记录到 .awf，确保下次重开不需要重新梳理**（非「开始实现」）。故本轮只落盘本文件，不写 T1-105 实现代码。
- 前序用户选择（logs 记录）：T1-058 结构性缺口 → 选「重排」，接受新建前置 T1-105；倾向「server 侧先行、run.js 薄化后置」的推进顺序。

## Next

接手者（重开后）：
1. 读本文件 → 问用户 **T1-105 落地边界 A/B/C**（若上抛的 decisionPending 已因会话重开丢失，直接用普通提问/awf_await_choice 重新收集）。
2. 按所选边界实现 T1-105；推荐 A：新 server run-host 组装点（建议 CJS 模块或经 app.cjs 装配）+ server.cjs 挂 run 提交端点 + 事件订阅轮询端点 + run-client 补 submitRun/subscribe 方法 + 单测；run-driver 阶段链/gateCompletionHook 与 run-scheduler 由 server 注入接线。ESM/CJS 边界照 run-batch 桥接法处理。
3. 修 `tests/unit/run.test.js` TC17（READY_TIMEOUT 同步）。
4. 保持 `tests/integration/server.test.js` 与相关单测绿；单 run 行为不变。
5. 完成时落账：`awf_task_complete`(T1-105, status done, files/commits/result)。
6. 计划链：完成后 T1-058(薄化 run.js) → T1-059(--resume/--attach) → … → T1-067(单写者/常驻/attach 冒烟) → T1-098(真 run 全流程回归)。
