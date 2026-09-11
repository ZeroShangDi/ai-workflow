# 常驻 Session Server — 功能文档

> 对应 WBS：v0.2.0 控制平面收敛（T1-063 常驻 / T1-064 空闲回收 / T1-067 单写者 / T1-071 sid 槽 / T1-076 决策归属 /
> T1-093 web 产物托管 / T1-105 常驻 run host / T1-110 写类必带 ?p / T1-112 server 日志 / T1-119 退役 legacy 观测页）
> 源码：`src/server/server.cjs`
> 配套：`src/server/project-context.cjs`、`src/server/run-slot.cjs`、`src/server/static.cjs`、`src/server/ws.cjs`、
> `src/server/interact.cjs`、`src/server/decision-gate.cjs`、`src/lib/server-idle.cjs`、`src/lib/server-log.js`、`src/lib/run-context.cjs`

## 功能描述

HTTP Session Server 是 `awf run` 的**常驻控制平面**：单进程、单端口，按 `projectRoot` 主键同时服务多个项目。
它把 tmux 里的 Claude Code 会话与外部调用方（CLI / hook 网关 / MCP / 前端）解耦，承担六类职责：

1. **tmux 桥接** — 接收 `/send`、`/cmd`、`/intervene` 等写请求，经 `src/server/tmux.cjs` 把文本/命令注入会话。
2. **hook 驱动状态机** — Claude Code Hooks 回调 `/hook`，驱动 `ready`/`busy` 与决策挂起（子 agent 不翻转主闩锁）。
3. **子 agent 观测与落账** — `SubagentStart`/`Stop` 登记观测；`SubagentStop` 解析 `last_assistant_message` 的 `RESULT` 写 state.json。
4. **决策门阀接线** — `Stop`/`PreToolUse(AskUserQuestion)` 统一走决策闸门：触发决策模式 → 落盘 Decision Result → 回灌 resume。
5. **常驻 run host** — 每项目一份 run host（`src/server/run-host.cjs`），持有编排调度权；server 只做提交/事件/落账的表面。
6. **静态托管** — 前端页面一律由 web/ 构建产物（`src/server/public`）承载，缺产物明确告警。

### 进程模型

- **常驻单实例多项目**：CLI 侧「存在即复用」（`src/cli/server.js:17`：`getStatus` 探活成功即复用，他项目占用也复用）；server 进程按 `projectRoot` 懒建 `ProjectCtx`，请求带 `?p=<归一化 projectRoot>` 路由（`src/server/project-context.cjs` 的 `createProjectRegistry`）。
- **boot 上下文**：不带 `?p` 的请求落到 boot 上下文，其 `projectRoot` 由 `env.CC_PROJECT || cwd` 决定（`server.cjs:42`）。boot 兜底**只对读类请求成立**（见「写类端点缺 `?p` 拒绝」）。
- **磁盘锚点**：一律落在 `<projectRoot>/.awf/`（无 sid 分片）。`?sid=` 只作 run 标签（tmux 会话名 + hook 路由 + `GET /awf/state?sid=` 软边界），不切分磁盘。
- **tmux 会话名**：`cc-<projectSid>`，`projectSid` 由归一化 projectRoot 的 SHA-1 前 12 位派生（`src/lib/run-context.cjs` `projectSid`），跨进程/重启稳定，多项目间唯一不互杀。

```
┌────────────┐  HTTP    ┌───────────────────────────────┐  tmux  ┌──────────────┐
│ CLI (run)  │─────────►│ 常驻 Session Server（单进程）   │───────►│ tmux session │
│ hook 网关   │◄─────────│  ?p 路由 → ProjectCtx[A|B|…]   │ send   │  claude      │
│ MCP / 前端  │ /hook …  │  ready/busy · 落账 · 决策 · host│ capture│  └ 子 agent  │
└────────────┘          └───────────────▲───────────────┘        └──────────────┘
                                        │ POST /hook（CC_PROJECT → &p=）
                                        │
                       Claude Code Hooks（gateway.cjs → server）
```

## 执行流程

### 1. 请求入口与 `?p` 路由

每个请求先解 `new URL(req.url)`，然后：

1. `lastActivityAt = Date.now()` —— 任何请求刷新空闲回收计时（`server.cjs:867`）。
2. **写类缺 `?p` → 400**：`writeNeedsProject(method, pathname)` 对非 `GET`/`HEAD`/`OPTIONS` 且不在 `PROJECT_AGNOSTIC_WRITES` 白名单（仅 `{ /shutdown }`）的请求要求显式 `?p`，缺失即 400 返回，报错里带上被拒绝兜底的 boot 项目（`server.cjs:859-877`）。**绝不兜底到 boot**——2026-09-10 事故（无 `?p` 的 `curl /run/state/mode` 把 boot 项目暂停 4 小时）即由此而来。
3. `pcx = resolveCtxForUrl(url)` —— `registry.resolveCtx({ p })` 解析/懒建该项目上下文；无 `p` → boot（读类）。

### 2. 路由表

| 方法 | 路径 | 用途 | 关键逻辑 |
|------|------|------|---------|
| GET | `/`、`/dashboard(.html)`、`/diagnostics(.html)`、`/decisions(.html)` | 前端页面 | 由 web 产物承载；缺产物 → 503 + 告警（`PAGE_PATHS`，`server.cjs:807,883`） |
| POST | `/hook` | CC Hook 回调 | 事件分发 → 状态转换 / 落账 / 决策闸门（`server.cjs:899`） |
| GET | `/awf/state` | 读 state.json | 带 `?sid=` 读 `.awf/runs/<sid>/state.json`，否则读主 state；缺失 404 |
| GET | `/awf/metrics` | 运行指标快照 | `getMetricsSnapshot`（含 token/上下文/产出速度） |
| GET | `/awf/diagnostics` | 读诊断结果 | `readDiagnosis(projectRoot)` |
| POST | `/awf/diagnostics` | 触发独立 AI 诊断 | 202 = 已排队；`startRunDiagnosis`（oneshot 端口） |
| GET | `/awf/decisions` | 决策聚合列表 | `DecisionStore.listAll()`（供 Review） |
| POST | `/awf/decisions/<id>/override` | 人工纠偏 | 追加 `decision_overridden` + 追加纠偏任务（kind=dev） |
| GET | `/status` | 查询状态 | 见下；带 `?sid=` 只回该槽；`?snapshot` 附 tmux capture；无 `?p` 附 `projects` 枚举 |
| POST / GET | `/context-ready` | 上下文快照就绪标记 | POST 置位；GET 一次性消费后复位 |
| POST | `/choice` / `/ask` | AI 通知需选择 / 需输入 | `interact.validateDecisionRequest` → `setDecision` |
| POST | `/send` | 发送 prompt | hasSession → waitReady → capture → logPrompt → setBusy → submit |
| POST | `/cmd` | 发送本地 slash 命令 | hasSession → waitReady → setBusy → submit → `LOCAL_CMD_FALLBACK_MS` 兜底回 ready |
| POST | `/respond` | CLI 回应决策 | 有 decisionPending 跳过 waitReady（避免死锁）→ logChoice → submit → fallback 5min/1.5s |
| POST | `/stop` | 中断运行流 | sendCtrlC + clearDecision + fallback 兜底回 ready |
| POST | `/intervene` | w-monitor 受控介入 | **要求 `mode=pause`**（`requirePaused`）→ logPrompt → setBusy → submit |
| POST | `/intervene/interrupt` | w-monitor 升级中断 | 要求 `mode=pause` → sendCtrlC + clearDecision + fallback |
| POST | `/run/submit` | 提交 run | `bootstrapRunHost` → `runHost.submitRun({ runId, mode })`（202） |
| GET | `/run/status` | run 快照 | `runHost.snapshot(runId)` |
| GET | `/run/events` | 轮询事件 | `runHost.pollEvents({ afterSeq, runId })` |
| POST | `/run/state/mode` | 写 mode | `setWorkflowMode`（run/idle/pause） |
| POST | `/run/state/task/active` | 标任务 active | `markTaskActive` |
| POST | `/run/state/gate` | 门禁完成处理 | `gate-fix.handleGateCompletion` |
| POST | `/run/state/backup` | 版本归档 | `backupState` |
| POST | `/run/state/apply?sid=` | 整份 state 落盘 | 单写者收口（T1-077）；带 sid 写 `.awf/runs/<sid>/state.json` |
| POST | `/oneshot` | 无状态 LLM 调用 | `oneshotLib.runOneShot` |
| POST | `/shutdown` | 优雅关闭 | `PROJECT_AGNOSTIC_WRITES` 唯一豁免；200 后 60ms `stop()` → exit |
| GET | 其余 | 静态托管 | `createStaticHost` SPA 回退 index.html；未命中 → 404 |

**`GET /status` 返回体**（无 `sid`）：

```json
{
  "ok": true, "state": "ready|busy", "session": true, "projectRoot": "…",
  "decisionPending": null, "contextReady": false,
  "decisionGate": null, "decisionResume": null,
  "mainSessionId": "session_id|null", "sessionSeq": 0, "activeAgents": 0,
  "projects": [{ "projectRoot": "…", "runSessionName": "cc-…", "state": "…" }]
}
```

- `decisionPending`：挂起决策（`/choice`/`/ask` 或 gate 关时 `AskUserQuestion` 捕获）。
- `decisionGate` / `decisionResume`：决策闸门当前阶段与上一次闭合的 resume（`{ decision_id, answer, type, finality, fallback }`）。
- `activeAgents`：agents registry 中 `status=running` 的子 agent 数。
- `projects`：仅无 `?p`（boot）请求附带，枚举已注册项目（`registry.list()`）。
- `?snapshot` → 附 `snapshot: tmux.capture()`。

### 3. hook 驱动状态机

`handleSidHook`（`server.cjs:359`）：带 `?sid=` 的 hook 路由到该项目内独立 `runSlot`（`src/server/run-slot.cjs`），只做 ready/busy/decision 隔离，**不做决策闸门**（gate 关时仍捕获 `AskUserQuestion`）。

无 `sid` 时按 `event` 分发表：

| event | 动作 |
|-------|------|
| `SessionStart` | 记录 `mainSessionId`（首个 session_id）+ `sessionSeq += 1`；新会话先 `resetRunLogs`/`resetRunMeta`；`setReady` + `logger.resetTranscript`。诊断进行中的隔离会话被忽略 |
| `UserPromptSubmit` | **仅主会话** `setBusy`（`isMainSession`：`mainSessionId` 未记录或无 `session_id` 时向后兼容全接受） |
| `Stop` | **仅主会话** → `handleStop`（决策闸门，见 §4） |
| `SubagentStart` | 只观测：agents registry 登记 `running` + `updateRunMeta`；外部监控会话（非主 session_id）跳过 |
| `SubagentStop` | 置 `stopped` + `updateRunMeta`；**已跟踪**的 agent → 解析 `NEEDS_INPUT`/`RESULT`（见 §5）；未跟踪（无 Start）→ 跳过不落账 |
| `PreToolUse` + `AskUserQuestion` | `handleAskUserQuestion`（决策化，见 §4） |
| `PostToolUse` + `AskUserQuestion` | 兜底回写 `decision.answer` / `answered`（兼容 `answers` 对象 / `answer` / 字符串 / 兜底 JSON） |

**主闩锁隔离**：子 agent 的 `UserPromptSubmit`/`Stop` 不翻转主 `ready`/`busy`，避免引用计数悬挂。hook 网关（`plugin/core/hooks/gateway.cjs`）注入 `&p=CC_PROJECT` 与 `&sid=CC_SID`，把事件路由到正确项目/槽。

### 4. 决策门阀接线（v0.2.0，单 agent）

决策闸门规则层在 `src/server/decision-gate.cjs`（纯分类），副作用编排在 `server.cjs`。开关来自项目自身 config（`pcx.decisionEnabled()` → `isDecisionEnabled(root)`，缺省关）。

**Stop 闸门**（`handleStop`，`server.cjs:456`；`classifyStop`）：

| 分支 | 条件 | 动作 |
|------|------|------|
| `complete` | gate 关；或 gate 开但文本不以 `<AWF_DECISION_REQUIRED>` 结尾 | `clearDecision` + `setReady` + `captureFromTranscript` |
| `deciding` | gate 开、非 deciding、文本以 `<AWF_DECISION_REQUIRED>` 结尾且 `stop_hook_active !== true` | 置 `decisionGate={phase:'deciding'}`，回 `ccOutput` = `ccShapes.blockDecision(决策模式指令)`（读 `plugin/decision/decision/mode-instruction.md`）→ 逼模型产出 Decision Result 收尾本回合 |
| `resolve` | gate 开且已在 deciding | `parseDecisionResult` 解析 `<AWF_DECISION_RESULT>`；有效 → 落盘；无效 → `deferredFallbackResult` 兜底（不悬空）→ `persistDecision` + 置 `decisionResume` + clear + `setReady` |

**`persistDecision`**（`server.cjs:397`）：生成 `decision_id`（`createDecisionSeq`：`D-<base36 时间戳>-<seq>`）→ `buildCompletedRecord` → `pcx.newDecisionStore().append(record)`（追加进 `.awf/decisions/runs/<runStamp>.jsonl`，`DecisionStore` 幂等去重）→ `logger.logDecision` → 置 `decisionResume` → 推 `decision.record` 进 run host 事件环。

**`AskUserQuestion` 决策化**（`handleAskUserQuestion`，`server.cjs:427`；`classifyAskQuestion`）：

| 分支 | 条件 | 动作 |
|------|------|------|
| `capture` | gate 关；或非 deciding | `setDecision({ type:'choice'/'multiSelect', source:'AskUserQuestion', … })`（维持现状上抛，不拦截） |
| `deny_deciding` | gate 开且 deciding | deny（`ccShapes.denyPermission`）——决策闭合前禁再问 |
| `deny_gate` | gate 开且非 deciding | deny，指引改以 `<AWF_DECISION_REQUIRED>` 标签收尾 |

> 旧入口 `awf_await_choice` / `awf_await_input` 已停用（T1-106）；运行期需决策一律走 `<AWF_DECISION_REQUIRED>` 标签，门阀自决，不再抛回用户。

### 5. 子 agent 落账（SubagentStop）

```
子 Agent 结束 → SubagentStop hook（payload.last_assistant_message）
  → 未跟踪（无 SubagentStart / 外部监控会话）→ 仅观测，不落账、不写失败记录
  → 已跟踪 → 先 parseSubagentNeedsInput（NEEDS_INPUT: {…}）
       有 → logSubagentNeedsInput（.awf/logs/subagent-needs-input.jsonl），不落账（任务保持等待）
       无 → parseSubagentResult（RESULT: {…}）→ settleSubagent
```

**`settleSubagent`**（`server.cjs:113`）在 `stores.state.updateSync`（带 `state.lock` 文件锁）下写：

- `task.status` = `result.status`（`failed`/`fail` 映射为 `blocked`——调度只认 `done`/`blocked` 为终态）
- `task.exec.result` / `files` / `verdict` / `architecture`、`task.commits` 追加
- **防 taskId 错写**：`RESULT` 指向已 `done`/`blocked` 的任务 → 良性拒绝（`recoverable:false`），不写失败记录（避免重复补发循环）
- 可恢复失败（无有效 RESULT / taskId 不存在）→ `.awf/logs/subagent-failed.jsonl`（CLI 据此补发，`RESEND_MAX=2`）

**`resetRunLogs`**（`server.cjs:106`）：每次 run 启动（`start()` / main 启动）清空 `subagent-failed.jsonl` / `subagent-needs-input.jsonl`，避免跨 run 残留触发伪补发；`subagent-events.jsonl` 纯观测保留。

`RESULT` 解析原语在 `src/lib/extract.cjs`（`RESULT_RE` / `RESULT_STATUSES = ['done','blocked','failed','fail']`）；协议与 `plugin/core/agents/awf-worker.md` 对齐。

### 6. 静态托管（web/ 构建产物）

- 页面路径集合 `PAGE_PATHS`（`server.cjs:807`）统一处理：读 `webIndexHtml()` = `fs.readFileSync(<webPublicRoot>/index.html)`。
- `webPublicRoot()` = `process.env.CC_WEB_PUBLIC || src/server/public`（`server.cjs:795`）。
- **产物缺失 → 503 + 告警**：`console.warn('[web] 前端产物缺失：…请运行 npm run build')`，响应体含 `expected` 路径（`server.cjs:889-895`）——不给空白页、不静默 404。
- GET 兜底：`webHostInstance()` = `createStaticHost({ root, aliases:{ '/':'index.html' }, spa:'index.html' })`（`src/server/static.cjs`）；命中即响应，无扩展名前端路由 SPA 回退 `index.html`。
- 旧静态页 `dashboard.html` / `decisions.html` / `diagnostics.html` / `theme.css` / `common.js` / `ui.html` 已删除（T1-119）；`/ui` 现为 404。

### 7. 空闲回收与 server 日志

**空闲回收**（`server.cjs:1477-1490`，仅 `require.main === module`）：

- 阈值 `idleDefaultMs()`：默认 30min，`CC_SERVER_IDLE_MS` 覆盖，`<=0` 禁用（`src/lib/server-idle.cjs`）。
- 检查间隔 `CC_SERVER_IDLE_CHECK_MS`（默认 60000）。
- 触发条件：`anyHostActive()` 为假（**全部项目无 queued/running run**）且 `isIdleDue({ now, lastActivityAt, idleMs })` → `stop()` → `process.exit(0)`。

**server 日志**：`server.cjs` 自身只写 `console.log/error`（启动行 `[server] listening … project=… pid=…`；`notice()` 落 run 日志 + console）。stdout/stderr 由**启动方**接到 `.awf/logs/server.log`：

- `src/cli/run.js:213` 与 `src/cli/server.js:25` 用 `openServerLog(serverLogPath(logsDir))`（`src/lib/server-log.js`）取 fd，spawn server 时 `stdio: ['ignore', fd, fd]`。
- 单文件上限 5MB（`CC_SERVER_LOG_MAX_MB`，`<=0` 不轮转）；超限时单代轮转为 `server.log.1`。

## 核心常量 / 配置

| 常量 | 值 | 说明 |
|------|-----|------|
| `READY_TIMEOUT_MS` | 120000（`CC_READY_TIMEOUT_MS`） | `/send`、`/cmd` waitReady 超时；单 agent 执行器「无变化窗口」判据 |
| `ENTER_DELAY_MS` | 200（`CC_ENTER_DELAY_MS`） | `sendText` 后等再 `sendEnter` |
| `LOCAL_CMD_FALLBACK_MS` | 1500（`CC_LOCAL_CMD_MS`） | `/cmd`、`/stop`、`/respond`（无 decision）兜底回 ready |
| `DECISION_FALLBACK_MS` | 300000（`CC_DECISION_FALLBACK_MS`） | `/respond`（有 decision）兜底回 ready |
| `WEB_PUBLIC_DEFAULT` | `src/server/public`（`CC_WEB_PUBLIC`） | 前端产物根目录 |
| `PAGE_PATHS` | `/,/dashboard(.html),/diagnostics(.html),/decisions(.html)` | 统一走 web 产物承载 |
| `PROJECT_AGNOSTIC_WRITES` | `{ /shutdown }` | 唯一可不带 `?p` 的写类端点 |
| `IDLE_MS_DEFAULT` | 30min（`CC_SERVER_IDLE_MS`，0=禁用） | 空闲回收阈值 |
| `CC_SERVER_IDLE_CHECK_MS` | 60000 | 空闲检查间隔 |
| `SERVER_LOG_MAX_MB` | 5（`CC_SERVER_LOG_MAX_MB`） | server.log 单文件上限 |
| `RESULT_STATUSES` | `done/blocked/failed/fail` | 子 agent RESULT 合法状态 |

## 函数清单

| 函数 | 说明 | 位置 |
|------|------|------|
| `writeNeedsProject(method, pathname)` | 写类请求是否必须显式带 `?p` | `src/server/server.cjs:859` |
| `resolveCtxForUrl(url)` | 解析请求的项目上下文（缺省 boot） | `src/server/server.cjs:837` |
| `isMainSession(pcx, body)` | 是否影响主 ready/busy 的会话（隔离子 agent） | `src/server/server.cjs:262` |
| `setReady/setBusy/waitReady` | ready/busy 状态机 + 等待队列 | `src/server/server.cjs:290,297,301` |
| `setDecision/clearDecision` | 决策挂起置位/清除（开闸时推 host 事件） | `src/server/server.cjs:273,286` |
| `handleStop(pcx, body)` | Stop 统一决策闸门（三分支） | `src/server/server.cjs:456` |
| `handleAskUserQuestion(pcx, body)` | AskUserQuestion 决策化（捕获/deny） | `src/server/server.cjs:427` |
| `persistDecision(pcx, result, source)` | 决策落盘 + 置 decisionResume | `src/server/server.cjs:397` |
| `handleSidHook(pcx, sid, event, body, res)` | 带 sid 的 hook 路由到独立 run 槽 | `src/server/server.cjs:359` |
| `settleSubagent(pcx, body)` | 子 agent RESULT 落账写 state | `src/server/server.cjs:113` |
| `logSubagentEvent/Failure/NeedsInput` | 子 agent 观测/失败/决策日志 | `src/server/server.cjs:66,75,89` |
| `resetRunLogs(pcx)` | run 启动清空驱动 CLI 的日志 | `src/server/server.cjs:106` |
| `bootstrapRunHost(pcx)` | 装配本项目 run host（惰性单例） | `src/server/server.cjs:622` |
| `anyHostActive()` | 任一项目有 run 在驱动（空闲回收/关机判据） | `src/server/server.cjs:684` |
| `defaultSingleExecutor(pcx)` | 单 agent 执行器：发 prompt → 等自我结算 | `src/server/server.cjs:503` |
| `sessionChannel(pcx)` | 会话通道（上下文压缩/收尾协商） | `src/server/server.cjs:568` |
| `batchTransportFor(pcx, stateApi)` | 多 agent 传输层端口接线 | `src/server/server.cjs:731` |
| `notice(pcx, kind, level, msg)` | 运维通知：run 日志 + console | `src/server/server.cjs:821` |
| `webPublicRoot/webIndexHtml/webHostInstance` | web 产物根/首页/静态宿主 | `src/server/server.cjs:795,798,811` |
| `start/stop` | 监听/优雅关闭（含 stop 全部 run host） | `src/server/server.cjs:1417,1431` |

## 接口 / 依赖

| 模块 | 用途 |
|------|------|
| `node:http` | HTTP server 创建 + `upgrade` 处理 |
| `node:fs` / `node:path` | 读 state/产物；子 agent 日志、state.lock 写 |
| `src/server/tmux.cjs` | `hasSession/sendText/sendEnter/sendCtrlC/capture`（每项目一实例） |
| `src/server/project-context.cjs` | 单 server 多项目：ProjectCtx 容器 + 注册表（`?p` 寻址） |
| `src/server/run-slot.cjs` | per-sid 内存状态机（ready/busy/decision/contextReady 隔离） |
| `src/server/static.cjs` | 静态托管原语（web 产物 SPA 回退） |
| `src/server/ws.cjs` | 极简 WebSocket 助手（`/run/events` 实时推送） |
| `src/server/interact.cjs` | 决策请求校验 / handoff 读写（`validateDecisionRequest`） |
| `src/server/decision-gate.cjs` | 决策闸门规则层（分类/兜底/记录构造） |
| `src/server/decision-store.cjs` | 决策记录追加式存储（幂等 + override） |
| `src/server/decision.cjs` | `<AWF_DECISION_RESULT>` 解析与轻量校验 |
| `src/server/decision-instruction.cjs` | 读 `plugin/decision/decision/mode-instruction.md` |
| `src/server/run-logger.cjs` | transcript 采集 / `logPrompt`/`logChoice`/`logDecision`/`logNotice` |
| `src/server/run-host.cjs` | 常驻 run host（driveSingle / driveBatch + 事件环 + 收尾） |
| `src/adapters/ports.cjs` | `ccShapes`（blockDecision / denyPermission）、`oneshot` 端口 |
| `src/lib/extract.cjs` | RESULT / NEEDS_INPUT / transcript 提取原语 |
| `src/lib/server-idle.cjs` | 空闲回收纯判定 |
| `src/lib/server-log.js` | server 输出落盘（启动方使用） |
| `src/lib/run-context.cjs` | sid→路径/会话名/端口装配（单源） |

## 验收标准

- [ ] 常驻单进程服务多项目：`?p` 路由到各自 `ProjectCtx`，磁盘锚点互不干扰；无 `p` 回落 boot（读类）。
- [ ] 写类端点（非 GET/HEAD/OPTIONS，`/shutdown` 除外）缺 `?p` → 400，且不写任何项目 state。
- [ ] hook 驱动 `ready`/`busy`；子 agent 事件不翻转主闩锁（`UserPromptSubmit`/`Stop` 仅主会话生效）。
- [ ] `SubagentStop` 解析 `RESULT` 落账（status/exec/commits）；`NEEDS_INPUT` 只记不落账；已 done 任务良性拒绝。
- [ ] 决策闸门：gate 开时 Stop 三分支（complete/deciding/resolve）生效，`<AWF_DECISION_RESULT>` 落盘并回灌 decisionResume；gate 关时 `AskUserQuestion` 维持捕获。
- [ ] 前端页面由 `src/server/public` 承载；产物缺失 → 503 + 告警（提示 `npm run build`），不回退 legacy 页面。
- [ ] 空闲回收：全部项目无 run 驱动且空闲超时 → 自动 `stop()` 退出；`/shutdown` 优雅关闭。
- [ ] server 输出（含启动行、`notice` 运维行）落 `.awf/logs/server.log`，超限单代轮转。
