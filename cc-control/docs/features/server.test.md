# 常驻 Session Server — 测试用例

> 对应功能文档：`docs/features/server.md`
> 源码：`src/server/server.cjs`（+ `project-context.cjs` / `run-slot.cjs` / `static.cjs` / `ws.cjs` / `interact.cjs` / `decision-gate.cjs`）
> 测试文件：
> - `tests/integration/server.test.js`（路由 / 状态机 / hook / 落账 / 静态托管）
> - `tests/integration/server-lifecycle.test.js`（单写者 / 常驻回收 / sid 槽与分片）
> - `tests/integration/one-server-two-projects.test.js`（单 server 多项目）
> - `tests/integration/write-requires-project.test.js`（写类缺 `?p` 拒绝）
> - `tests/integration/decision-gate.test.js`（决策闸门）
> - `tests/integration/two-project-smoke.test.js`（两项目 host / 决策归属隔离）
> - `tests/unit/static.test.js`、`tests/unit/ws.test.js`、`tests/unit/project-registry.test.js`、
>   `tests/unit/run-slot.test.js`、`tests/unit/server-idle.test.js`、`tests/unit/server-log.test.js`、`tests/unit/interact.test.js`

## 测试场景总览

| # | 场景 | 类别 | 文件 |
|---|------|------|------|
| 1 | 前端产物缺失 → 页面路径 503 + 告警 | 异常 | server.test.js |
| 2 | legacy 页面路径（/ui、/dashboard 等）退役 | 边界 | server.test.js |
| 3 | `/awf/state` 读取 + 单项目绑定 | 正常 | server.test.js |
| 4 | `/awf/metrics`、`/awf/diagnostics`（读/触发/隔离会话） | 正常 | server.test.js |
| 5 | `/status`（含 snapshot） | 正常 | server.test.js |
| 6 | `/send`、`/cmd`、`/respond`、`/choice`、`/ask` 正常与校验 | 正常/验证 | server.test.js |
| 7 | `/stop` 中断 + fallback | 正常 | server.test.js |
| 8 | w-monitor 受控介入（要求 pause） | 权限 | server.test.js |
| 9 | ready/busy 状态机（waitReady） | 正常/边界 | server.test.js |
| 10 | `/hook` 事件分发 + 主会话隔离 | 集成 | server.test.js |
| 11 | SubagentStop 落账 / NEEDS_INPUT / 良性拒绝 | 集成 | server.test.js |
| 12 | web 产物 SPA 静态托管 | 正常 | server.test.js / static.test.js |
| 13 | 单写者：并发写不丢不坏 + apply 读回 | 集成 | server-lifecycle.test.js |
| 14 | 常驻回收 / `/shutdown` | 集成 | server-lifecycle.test.js |
| 15 | `/hook?sid=` 槽隔离 + run-state 按 sid 分片 | 集成 | server-lifecycle.test.js |
| 16 | 单 server 多项目 `?p` 路由 + 每项目配置 | 集成 | one-server-two-projects.test.js |
| 17 | 写类缺 `?p` → 400（不写任何项目） | 验证 | write-requires-project.test.js |
| 18 | 决策闸门（Stop 三分支 / AskUserQuestion / 闭环 / override） | 集成 | decision-gate.test.js |
| 19 | 两项目 host / 决策归属隔离 | 集成 | two-project-smoke.test.js |
| 20 | 静态托管原语、ws、注册表、槽、空闲、日志、interact 单测 | 单元 | tests/unit/* |

## 详细测试用例

### TC1: 前端产物缺失 → 页面路径 503 + 明确告警

**前置条件**：`process.env.CC_WEB_PUBLIC` 钉在空目录（未构建态）
**执行**：`GET /`
**断言**：
- 状态码 503，`body.ok === false`
- `body.error` 含 `npm run build`
- `body.expected.endsWith('index.html')`（报缺哪个路径）

### TC2: legacy 页面路径退役

**前置条件**：同上
**执行**：`GET /ui`；再循环 `GET /diagnostics`、`/decisions.html`、`/dashboard`
**断言**：
- `/ui` → 404 `{ ok:false, error:'not found' }`（ui.html 已删除）
- 其余三个页面路径 → 均 503 且 error 含 `npm run build`（同一套处理，不再各自读 html）

### TC3: `/awf/state` 读取 + 单项目绑定

**前置条件**：boot 项目 `.awf/state.json` 存在
**执行**：`GET /awf/state`；随后切换 `CC_PROJECT` 再请求
**断言**：
- 200 + `content-type: application/json`，`mode/currentState/tasks` 正确
- 切换 `CC_PROJECT` 后仍返回启动项目 state（装配器启动即绑定，不是每请求重读）

### TC4: `/awf/metrics` / `/awf/diagnostics`

**前置条件**：写 `.awf/context/usage.json`（used_percentage=62）+ `~/.claude/projects/<slug>/sess-main.jsonl`（含 usage + cost-state）
**执行**：`POST /hook{SessionStart, session_id:'sess-main'}` → `GET /awf/metrics`；`GET /awf/diagnostics`；`POST /awf/diagnostics` 后 `GET`；诊断进行中喂一个隔离 `SessionStart`
**断言**：
- metrics：`agentMode='single'`、`tokens.total=150`、`coverage='exact'`、`context.usedPercentage=62`、`outputSpeed.currentTokensPerSecond>0`、`elapsedMs>0`
- 未诊断：`{ ok:true, diagnosis:null }`
- `POST /awf/diagnostics` → 202 + `status:'running'`；落盘后 `GET` 得 `status:'complete'` + summary
- 隔离会话（`sess-diagnosis`）不重置 `mainSessionId`（仍为 `sess-main`）

### TC5: `/status` 与 snapshot

**执行**：`GET /status`；`GET /status?snapshot=true`
**断言**：
- `body.ok=true`、`state='ready'`、`session=true`、`decisionPending=null`、`projectRoot=项目根`
- snapshot：`body.snapshot='pane content'`，`m.tmux.capture` 被调用

### TC6: `/send` / `/cmd` / `/respond` / `/choice` / `/ask`

**执行与断言**：
- `POST /send{text:'do something'}` → 200 `{ok:true,sent:'do something'}`；`captureFromTranscript`/`logPrompt('do something')`/`sendText`/`sendEnter` 被调用；`_getState().state='busy'`
- `POST /send{text:''}` → 400 `body must be {text: non-empty string}`，`sendText` 未被调用
- `POST /send`（`hasSession=false`）→ 503，error 含 `tmux session`
- `POST /send`（busy 且 300ms 超时）→ 409 `still busy (ready timeout)`，耗时 ≥250ms
- `POST /cmd{cmd:'/clear'}` → 200；60ms 后 `_getState().state='ready'`（fallback）；空 cmd → 400；无 session → 503
- `POST /respond{value:'1'}`（先 `/choice` + busy）→ 200，`logChoice('Q','1')` 被调用、`sendText('1')`
- `POST /choice{question,options}` → `decisionPending.type='choice'`、`options` 正确
- `POST /ask{question}` → `decisionPending.type='text'`、`question` 正确

### TC7: `/stop` 中断

**执行与断言**：
- 有 session：200 `{ok:true,stopped:true}`、`sendCtrlC` 被调用、`decisionPending=null`
- 无 session：503，`sendCtrlC` 未调用
- 无 Stop hook：立即仍 `busy`，120ms 后 fallback 回 `ready`

### TC8: w-monitor 受控介入

**执行与断言**：
- mode≠pause：`POST /intervene` → 409，error 含 `mode=pause`，`sendText` 未调用
- mode=pause 且 busy：`/intervene` → 200，`sendText` 收到文本，`logPrompt` 含 reason
- `/intervene/interrupt`：非 pause → 409；pause → 200 且 `sendCtrlC` 调用一次

### TC9: ready/busy 状态机

**执行与断言**：
- `SessionStart` 唤醒 2 个 waiters（`waitReady(10000)` 均 resolve true）→ `state='ready'`、`resetTranscript` 被调用
- `UserPromptSubmit` → `busy`
- `Stop`（有 decision）→ `decisionPending=null` + `ready` + `captureFromTranscript`
- `/send` 后 `/status` 为 busy → `Stop` 后为 ready（完整往返无死锁）
- `waitReady`：当前 ready 立即 true 且 waiters 空；busy 时 `setReady` 后返回 true；超时返回 false 且 waiter 出队

### TC10: `/hook` 事件分发 + 主会话隔离

**执行与断言**：
- `SessionStart` → `{ok:true,event:'SessionStart',state:'ready'}` + `resetTranscript`
- `UserPromptSubmit` → busy；`Stop` → ready
- `PreToolUse`+`AskUserQuestion` → `decisionPending.source='AskUserQuestion'`、`question/options/type` 正确
- `PostToolUse` → `decisionPending.answer`/`answered=true`
- `SessionStart{session_id:'sess-main'}` → `mainSessionId` 记录
- 子 agent（非主 session）`UserPromptSubmit`/`Stop` 不翻转主闩锁（仍 ready/busy）
- `SubagentStart/Stop` 只进 registry（`activeAgents` 1→0），不驱动主闩锁
- `/status` 隔离非主会话子 agent：`activeAgents=0`
- 外部监控子 agent（`sess-monitor`）不进 worker 失败补发链路（不写 `subagent-failed.jsonl`）

### TC11: SubagentStop 落账 / NEEDS_INPUT / 良性拒绝

**执行与断言**：
- 有效 `RESULT{taskId:T1,status:done,...}` → state `T1.status='done'`、`exec` 含 result/files；`captureSubagentTranscript` 被调用
- 无有效 RESULT → 不落账（T1 仍 pending）+ 写 `subagent-failed.jsonl`（reason 含 `no valid RESULT`）
- `taskId` 不存在 → 写失败记录（`resultTaskId` 为 T999、reason 含 `not found`），state 不变
- `RESULT` 指向已 `done` 任务 → 良性拒绝：T3 保持 done、X1 仍 pending、**不写**失败记录
- `NEEDS_INPUT` → 写 `subagent-needs-input.jsonl`（taskId/question/options），不落账、不写失败记录
- 未跟踪 SubagentStop（无 Start）→ 不落账、不写失败记录
- `status=failed/fail` → 落账映射为 `blocked`
- 带 `verdict` → `exec.verdict` 落账（`level`/`conclusion`）

### TC12: web 产物 SPA 静态托管

**前置条件**：临时目录写入 `index.html` + `assets/app.js`，`CC_WEB_PUBLIC` 指向它
**执行与断言**：
- `GET /` → 200 + 含 `awf-web-app`
- `GET /assets/app.js` → 200 + `content-type` 含 `javascript`
- `GET /wbs-tree`（无扩展名前端路由）→ 200 + SPA 回退 index
- `GET /status` 仍走 API（不被静态托管吞掉）
- 未构建态：页面 503，未知 GET 404（不回退、不空白页）

### TC13: 单写者（并发写 / apply）

**前置条件**：项目 state 含 20 个 pending 任务
**执行**：并发 40 路 `POST /run/state/task/active` + 40 路 `POST /run/state/mode`
**断言**：state 无损坏、20 任务全 `active`（无丢写）、`mode` ∈ {run,pause}（原子覆盖末次胜出）；`POST /run/state/apply` 后 `GET /awf/state` 读回一致

### TC14: 常驻回收 / `/shutdown`

**执行与断言**：
- spawn 子进程（idleMs=400/checkMs=80）→ 一次 `/status` 活动 → server 自动退出（exit code 0）
- `idleMs=0`（禁用回收）→ `POST /shutdown` → `{ok:true,shutting:true}` → 优雅退出

### TC15: `/hook?sid=` 槽隔离 + run-state 分片

**执行与断言**：
- `SessionStart`/`UserPromptSubmit` 喂 sid=a → a busy、b ready（不串）；a `PreToolUse` 捕获只落 a；a `Stop` 清 a 决策，b 无决策
- `POST /run/state/apply?sid=ra` / `?sid=rb` → 各落 `.awf/runs/<sid>/state.json`，`GET /awf/state?sid=` 各自读回
- `POST /oneshot{}`（空 prompt）→ 400 含 `prompt`

### TC16: 单 server 多项目（`?p` 路由 + 每项目配置）

**前置条件**：A（gate off）、B（gate on），`CC_PROJECT=A`
**执行与断言**：
- `GET /awf/state?p=A|B` 各回各自 marker；无 p → boot（A）
- `POST /run/state/apply?p=B` 只写 B（A/boot 不动）；`POST /run/state/mode?p=B` 只翻 B 的 mode
- `POST /hook?p=A`（AskUserQuestion）→ 捕获（`decisionPending` 有值、无 ccOutput）；`?p=B` → deny（`ccOutput` 有值、`decisionPending=null`）
- 跨项目同 `sid=rb`：B busy、A ready（按项目隔离）
- `GET /status`（无 p）→ `projects` 枚举 [A,B]、会话名互异、`projectRoot=A`

### TC17: 写类缺 `?p` → 400（不写任何项目）

**执行与断言**：
- `POST /run/state/mode`（缺 `?p`）→ 400，error 含 `?p` 与 BOOT 路径，boot 的 `state.json` **逐字节未变**
- `POST /run/state/{task/active,gate,backup,apply}` 四个写端点缺 `?p` → 均 400
- `/intervene`、`/intervene/interrupt` 缺 `?p` → 400
- `/send`、`/cmd`、`/choice`、`/ask`、`/respond`、`/context-ready`、`/hook`、`/oneshot` 缺 `?p` → 400 且 error 含 `?p`
- 带 `?p` 正常：`/run/state/mode?p=BOOT` 落到 boot；`?p=OTHER` 只写 OTHER，不动 boot
- 读类保留 boot 兜底：`GET /status`、`GET /awf/state`、`GET /awf/decisions` 缺 `?p` 仍 200（`projectRoot=boot`）
- `/shutdown` 豁免：缺 `?p` → 200 `{shutting:true}`（非 400）

### TC18: 决策闸门

**执行与断言**：
- gate off：含 `<AWF_DECISION_REQUIRED>` 的 Stop 也走现状（ready + 采集，无 ccOutput、无落盘）
- gate on ① 普通完成：不触发、不落盘、ready
- gate on ② 触发：文本以 `<AWF_DECISION_REQUIRED>` 结尾且非 `stop_hook_active` → `deciding` + `ccOutput.decision='block'`（reason=决策模式指令）、`busy` 不翻转
- gate on ③a：deciding 中带有效 `<AWF_DECISION_RESULT>` → 落盘 + `decisionResume` + ready
- gate on ③b：deciding 中无有效结果 → `deferredFallbackResult` 落盘 + `decisionResume.fallback=true` + ready
- `/status` 暴露 `decisionGate`/`decisionResume`（空态/触发/闭合三态）
- 幂等：同 decision 重复 Stop 不重复落盘
- `PreToolUse`：gate off → 捕获（不拦截）；gate on 非 deciding → deny（reason 指引改以标签收尾）；gate on deciding → 重复提问 deny
- 两入口合一：AskUserQuestion deny 后模型以标签收尾 → Stop ② 进入 deciding
- 捕获记录字段完整（`decision_completed` + `pending_review`）；fallback 亦落完整记录
- 文字入口一次事务只 block 一次（触发 → deciding；再次无结果 Stop → fallback 闭合，不二次 block）
- Review API：`GET /awf/decisions` 倒序聚合；`POST /awf/decisions/<id>/override` 追加 `decision_overridden`（原记录保留）；缺 instruction → 400、目标不存在 → 404；override 追加纠偏任务（kind=dev/source=decision_review）

### TC19: 两项目 host / 决策归属隔离

**执行与断言**：
- 两独立 projectRoot 的 host 并发 run → 各自 state 到 done，registry 各列其 run
- 两真实 server 进程并发驻留：`projectRoot` 互异、hook sid 路由只影响本 server、进程互不 kill
- 单/双 run：状态 done + 决策只落该 run 的 `.awf/runs/<sid>/decisions/<sid>.jsonl`，不串写对端

### TC20: 单元测试（原语层）

| 文件 | 用例要点 |
|------|---------|
| `static.test.js` | `createStaticHost` resolve（别名/同 html 兜底/`..` 越权拒绝/query 剥离）、serve（200+MIME、未命中 false）、SPA 回退（无扩展名 → index，真实文件优先，带扩展名缺失仍 null） |
| `ws.test.js` | `acceptKey` RFC6455 官方向量；`encodeTextFrame` 0x81 起始；`encodeFrame` 126/127 长度边界；`parseFrameHeader` 识别 masked close 帧 |
| `project-registry.test.js` | boot 上下文最先注册；`ctxFor` 懒建+记忆化+路径归一化；`resolveCtx` 无 p→boot、p/bodyProjectRoot 兜底；`list` 枚举；`reset` 复位 mutable；会话名按 projectSid 确定性派生且两项目相异；磁盘锚点各自独立；mutable/per-sid 槽独立 |
| `run-slot.test.js` | ready/busy 按槽隔离、`waitReady` 不跨槽唤醒；`decisionPending` 按槽隔离 + snapshot/reset；**不暴露**永假字段 `contextReady`（issue 004-2） |
| `server-idle.test.js` | `isIdleDue` 达阈值触发、阈值 ≤0/非法永不触发；`idleDefaultMs` 默认 30min、env 覆盖、0=禁用 |
| `server-log.test.js` | 路径落 `.awf/logs`；目录自建；追加写不丢旧内容；超上限单代轮转 `.1`；未超不轮转；`maxBytes<=0` 不轮转；`close()` 幂等 |
| `interact.test.js` | `validateDecisionRequest` choice/text 决策模型与缺 question 报错；`isAwaitDecision`；ready latch mark/consume/reset；handoff 原子写读 |

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| tmux | `global.__CC_TMUX__` 注入 mock 对象 | 原生 require 的 CJS 依赖无法 `vi.mock`；mock `hasSession/sendText/sendEnter/sendCtrlC/capture/SESSION` |
| RunLogger | `global.__CC_RUNLOGGER__ = { RunLogger: MockRunLogger }` | 拦截 `resetTranscript`/`captureFromTranscript`/`captureSubagentTranscript`/`logPrompt`/`logChoice`/`logDecision` |
| run-diagnosis | `global.__CC_RUN_DIAGNOSIS__` | 覆盖 `diagnoseWithClaude` 返回固定诊断 |
| run host 依赖 | `global.__CC_RUN_HOST_DEPS__`（stateApi/cfg/chain/scheduler/executor/batch 整体覆盖） | 隔离 host 装配 |
| oneshot | `global.__CC_ONESHOT__` | 覆盖 `claude -p` 调用 |
| 前端产物 | `process.env.CC_WEB_PUBLIC` 指向临时目录（或空目录模拟未构建） | 钉住「已构建/未构建」态，避免随本地 `npm run build` 漂移 |
| 时间/超时 | `CC_READY_TIMEOUT_MS`/`CC_ENTER_DELAY_MS`/`CC_LOCAL_CMD_MS` + `sleep` | 加速 waitReady 超时与 fallback 路径 |
| 常驻/回收 | `child_process.spawn` 真起 server 子进程 | `CC_PORT`/`CC_PROJECT`/`CC_SERVER_IDLE_MS`/`CC_SERVER_IDLE_CHECK_MS` 经 env 下发 |
| HTTP 请求 | `tests/helpers/http-api.js`（`makeApi`/`withProject`） | 统一 JSON 请求与 `?p` 拼接 |
