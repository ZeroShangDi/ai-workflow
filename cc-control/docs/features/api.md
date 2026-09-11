# Session Server HTTP API — 参考

> 对应 WBS：W3-003（server 控制平面分层 + 编排迁入；本页是其对外 HTTP 面）
> 源码：`src/server/server.cjs`（路由分发唯一依据）
> 配套模块：`src/server/project-context.cjs`（`?p` 路由）、`src/server/static.cjs`（静态托管）、`src/server/ws.cjs`（WebSocket）、`src/server/run-host.cjs`（`/run/*` 响应形状）
> 客户端实现：`src/lib/session/client.js`、`src/cli/run-client.js`；hook 网关：`plugin/core/hooks/gateway.cjs`
> 测试交叉验证：`tests/integration/server.test.js`、`tests/integration/write-requires-project.test.js`

常驻 HTTP Session Server 是 CLI / tmux 会话内 Claude Code 的 hooks / 插件 MCP / 前端 web 三方的共同后端。v0.2.0 起支持**单实例多项目**：请求用 `?p=<projectRoot>` 指定项目上下文。

---

## 1. 约定

### 1.1 监听地址与端口

| 项 | 值 | 来源 |
|---|---|---|
| 绑定地址 | `127.0.0.1`（仅回环） | `server.listen(port, '127.0.0.1', …)`（server.cjs L1421/L1470） |
| 默认端口 | `8787` | `plugin/config.json` 的 `port`（单源），经 `runtime-config.getServerPort()` |
| 端口覆盖 | `CC_PORT`（env） | `runtime-config.cjs`（env > config 文件） |
| 协议 | HTTP/1.1；另有 WebSocket 升级通道 | 见 §5 |

单进程单端口，所有项目共用一个端口，靠 `?p` 区分项目上下文。启动日志形如：
`[server] listening http://127.0.0.1:<port> project=<root> pid=<pid> at <ts>`

### 1.2 项目路由 `?p`

请求经 `resolveCtxForUrl(url)` → `registry.resolveCtx({ p })` 解析出**项目上下文（ProjectCtx）**：

```
root = p || bodyProjectRoot || projectRoot || boot
```

- `p` = `?p=<projectRoot>`（URL 未编码原样，`URLSearchParams` 已解码）→ 归一化为绝对路径，懒建/复用该项目的 ctx。
- 缺省回落 **boot 上下文** —— `boot` = 启动 server 的那个项目（`CC_PROJECT` env || `process.cwd()`），registry 构造时预置。
- **boot 兜底只对读类请求成立**；写类请求缺 `?p` 在入口即被拒（§1.3）。

每个 ProjectCtx 持有独立的 `.awf/state.json` / 日志 / tmux 会话（`cc-<projectSid>`）/ ready-busy 内存槽 / run host。跨项目完全隔离。

```js
// src/lib/session/client.js — 客户端拼 ?p
projectQuery(project) => project ? `?p=${encodeURIComponent(project)}` : ''
// src/cli/run-client.js — 已有 query 时用 & 追加
addP(p) => enc == null ? p : (p.includes('?') ? `${p}&p=${enc}` : `${p}?p=${enc}`)
```

### 1.3 写类端点缺 `?p` → 400（铁律）

`writeNeedsProject(method, pathname)`（server.cjs L859）：

```
method 为 GET / HEAD / OPTIONS      → 不算写类
其余（POST/…）                        → 算写类，必须显式带 ?p
唯一豁免：/shutdown（server 全局操作，不读不写任何项目 state，见 PROJECT_AGNOSTIC_WRITES）
```

写类请求缺 `?p` 时，**在解析上下文之前**直接返回 `400`，一个字节都不写：

```json
{
  "ok": false,
  "error": "写类端点缺 ?p：拒绝兜底到 boot 项目（<bootRoot>）。请显式带 ?p=<projectRoot>；hook 网关 / CLI / MCP 会自动带上。",
  "endpoint": "<pathname>"
}
```

**为什么**：2026-09-10 真机事故 —— w-monitor 手写 `curl -X POST …/run/state/mode -d '{"mode":"pause"}'`（**没带 `?p`**），旧实现 `resolveCtx` 静默兜底到 boot 项目，把**正在跑**的 cc-control run 暂停了 4 小时，且返回 200、无任何异常输出。读错项目只是看到错数据，**写**错项目直接改变别人 run 的状态 —— 故写类端点绝不猜项目。详见 `.awf/bugs/write-endpoint-missing-p-fell-back-to-boot.md`、任务 T1-110。

正常调用方都会带上 `?p`：

| 调用方 | 来源 |
|---|---|
| hook 网关 | bootstrap 注入 `CC_PROJECT` → `gateway.cjs` 拼 `&p=` |
| CLI | `client.js` 的 `projectQuery` / `run-client.js` 的 `addP` |
| MCP（awf-state / awf-session / awf-oneshot） | `AWF_PROJECT_ROOT \|\| CC_PROJECT` |

**读类端点保留 boot 兜底**（`GET /status` 是 CLI 的 server 发现与探活入口，改掉会破坏既有链路）。

### 1.4 响应信封

**无统一信封**，逐端点形状见 §3，但绝大多数 API 端点遵循同一约定：

```
成功：{ "ok": true, ...端点专属字段 }
失败：{ "ok": false, "error": "<人读描述>", ...可选的定位字段 }
```

**例外**（不遵循 `{ok,…}`）：

- `GET /awf/state` → 直接返回 state.json 原文（`JSON.stringify(s, null, 2)`），**没有** `ok` 字段；缺失 → `404 {ok:false,error}`。
- 前端页面路径（`/`、`/dashboard` 等）→ 返回 `text/html` 的 index.html 内容，不是 JSON。
- 静态产物（`/assets/*` 等）→ 返回文件原文 + 对应 MIME。
- `/run/status`、`/run/events` → 返回 `runHost.snapshot()` / `runHost.pollEvents()` 的结果，其内部已含 `ok:true`，但形状由 run-host 决定。

Content-Type：JSON 端点统一 `application/json`；页面为 `text/html; charset=utf-8`。

### 1.5 错误码约定

| 码 | 语义 | 典型场景 |
|---|---|---|
| `200` | 成功（读 + 同步写） | 大部分端点 |
| `202` | 已接受（异步） | `POST /run/submit`、`POST /awf/diagnostics` |
| `400` | 请求非法 | 缺 `?p`（写类）、body 字段不合规 |
| `404` | 未找到 | 未知路径、`GET /awf/state` 无 state、override 的目标决策不存在 |
| `409` | 冲突 / 前置条件不满足 | 会话仍 busy（ready 超时）、run 已在驱动、诊断已在跑、介入未先 pause |
| `500` | 服务端错误 | override 已记录但纠偏任务追加失败、state 落盘失败 |
| `503` | 依赖未就绪 | tmux 会话不存在（未 bootstrap）、run host 未就绪、state api 未就绪、前端产物缺失 |

### 1.6 `sid`（run 槽）

`?sid=<runSid>` 把请求路由到**项目内按 sid 隔离的内存槽**（`pcx.runSlotFor(sid)` → `run-slot.cjs`），ready/busy/decisionPending/contextReady 互不串扰。当前仅用于：

- `POST /hook?sid=…`（hook 网关经 `CC_SID` 注入）— 独立 run 槽的 ready/busy/decision
- `GET /status?sid=…` — 读该槽快照
- `GET /awf/state?sid=…` — 读 `<root>/.awf/runs/<sid>/state.json`（per-run 磁盘分片，**非**默认布局）
- `POST /run/state/apply?sid=…` — 写该 per-run state 文件（原子写 + 锁）

无 `sid` 时走项目的**单槽**与默认布局 `<root>/.awf/state.json`。注意：默认磁盘布局不做 sid 分片（Q1 裁定），sid 只作 run 标签（tmux 会话名 + hook 路由）。

### 1.7 鉴权

**无鉴权**。仅绑定 `127.0.0.1`，信任本机调用方。协议为明文 HTTP（无 TLS）。

### 1.8 空闲回收

server 为常驻进程（由 CLI 惰性拉起、多项目复用）。`process` 直启模式（`require.main === module`）下带空闲回收：任一项目有 run 在驱动则不回收；否则 `lastActivityAt` 空闲超阈值即自动 `stop()` 退出。

| 项 | 默认 | 覆盖 |
|---|---|---|
| 空闲阈值 | 30 min | `CC_SERVER_IDLE_MS`（`0` = 禁用回收） |
| 检查间隔 | 60 s | `CC_SERVER_IDLE_CHECK_MS` |

任何请求都会刷新 `lastActivityAt`。

---

## 2. 路由表（总览）

「写类?」= 非 GET/HEAD/OPTIONS（即受 §1.3 约束）；「需要 `?p`?」指写类端点是否必须显式带 `?p`。

| 方法 | 路径 | 用途 | 写类? | 需要 `?p`? |
|---|---|---|---|---|
| GET | `/` `/dashboard` `/dashboard.html` `/diagnostics` `/diagnostics.html` `/decisions` `/decisions.html` | 前端页面（一律返回构建产物 index.html） | 否 | 否 |
| POST | `/hook` | Claude Code hook 回调（事件转发 + 决策闸门） | 是 | 是 |
| GET | `/awf/state` | 读 state.json（可选 `?sid=` 读 per-run） | 否 | 否 |
| GET | `/awf/metrics` | 读 run 指标快照 | 否 | 否 |
| GET | `/awf/diagnostics` | 读 run 诊断记录 | 否 | 否 |
| POST | `/awf/diagnostics` | 触发一次 run 诊断（异步） | 是 | 是 |
| GET | `/awf/decisions` | 决策聚合列表 | 否 | 否 |
| POST | `/awf/decisions/:id/override` | 人工覆盖某决策 + 追加纠偏任务 | 是 | 是 |
| GET | `/status` | 服务器/会话状态（多项目快照、可选 `?sid=` `?snapshot=`) | 否 | 否 |
| POST | `/context-ready` | 置位「上下文快照就绪」 | 是 | 是 |
| GET | `/context-ready` | 一次性消费「上下文快照就绪」标记 | 否* | 否 |
| POST | `/choice` | AI 通知：需要人做选择 | 是 | 是 |
| POST | `/ask` | AI 通知：需要人自由输入 | 是 | 是 |
| POST | `/send` | 注入一条 prompt 到 tmux 会话 | 是 | 是 |
| POST | `/cmd` | 注入一条本地 slash 命令（`/clear` 等） | 是 | 是 |
| POST | `/intervene` | w-monitor 受控介入（需 mode=pause） | 是 | 是 |
| POST | `/intervene/interrupt` | w-monitor 升级中断（Ctrl-C，需 mode=pause） | 是 | 是 |
| POST | `/stop` | 中断当前正在运行的 Claude 流（Ctrl-C） | 是 | 是 |
| POST | `/respond` | CLI 回应决策 | 是 | 是 |
| POST | `/run/submit` | 提交一个 run 给常驻宿主 | 是 | 是 |
| GET | `/run/status` | run 状态快照（可选 `?runId=`) | 否 | 否 |
| GET | `/run/events` | 轮询 run 事件（`?afterSeq=` `?runId=`) | 否 | 否 |
| POST | `/run/state/mode` | 置工作流 mode（run/idle/pause） | 是 | 是 |
| POST | `/run/state/task/active` | 标记任务 active | 是 | 是 |
| POST | `/run/state/gate` | 门禁完成闭环（派生修复 + 回退复审） | 是 | 是 |
| POST | `/run/state/backup` | run 完成版本归档 | 是 | 是 |
| POST | `/run/state/apply` | 整体写 state（可选 `?sid=` 写 per-run） | 是 | 是 |
| POST | `/oneshot` | 无状态 LLM 调用（`claude -p`） | 是 | 是 |
| POST | `/shutdown` | 优雅关闭 server | 是 | **否**（豁免） |
| GET | 其它任意路径 | 静态产物托管（含 SPA 回退） | 否 | 否 |
| WS 升级 | `/run/events` | run 事件实时推送 | — | 否 |
| — | 其它任意方法/路径 | `404 {ok:false,error:"not found"}` | — | — |

\* `GET /context-ready` 是 GET（不受 §1.3 约束），但**有副作用**（消费标记）——见 §3.8。

---

## 3. 路由详情

### 3.1 前端页面 —— `GET /` `GET /dashboard` …

`PAGE_PATHS`（server.cjs L807）：`/`、`/dashboard`、`/dashboard.html`、`/diagnostics`、`/diagnostics.html`、`/decisions`、`/decisions.html`。

- 产物存在（`<webRoot>/index.html` 可读）→ `200 text/html`，返回 index.html 内容（**所有页面路径返回同一份 SPA 入口**，不再各自读 legacy html）。
- 产物缺失 → `503`（见 §4），并 `console.warn` 提示 `npm run build`。

```json
{ "ok": false, "error": "前端产物缺失：请运行 npm run build（构建 web/ → src/server/public）", "expected": "<webRoot>/index.html" }
```

> 注：`/ui` 等未列入 `PAGE_PATHS` 的路径不在此处理，落到 §4 静态托管判定。

### 3.2 `POST /hook` —— Claude Code hook 回调

hook 网关（`gateway.cjs`）把 stdin 的 hook JSON 原样 POST 到此端点，并把响应里的 `ccOutput` 透传回 stdout。

**查询参数**

| 参数 | 必填 | 说明 |
|---|---|---|
| `p` | 写类必填 | 项目根（网关经 `CC_PROJECT` 注入） |
| `event` | 视情况 | 事件名；**事件来源 = `body.event` 优先，否则 query `event=`**。网关把 `hook_event_name` 放进 query，故经网关调用时 body 无需带 `event` |
| `sid` | 否 | 有则路由到该项目内独立 run 槽（`handleSidHook`），忽略项目单槽 |

**请求体**：Claude Code hook 原始 JSON payload。被读取的字段：

`session_id`、`agent_id`、`agent_transcript_path`、`tool_name`、`tool_input.questions`、`tool_response`、`last_assistant_message`、`stop_hook_active`。

**处理的事件（`event`）**

| 事件 | 行为 |
|---|---|
| `SessionStart` | 复位 run 日志/run-meta（新主会话时）、记录 `mainSessionId`、`sessionSeq += 1`、置 **ready** |
| `UserPromptSubmit` | 主会话 → 置 **busy** |
| `Stop` | 主会话 → 走**统一决策闸门** `handleStop`：识别 `<AWF_DECISION_REQUIRED>` 进入决策态并回 `ccOutput` 阻断；识别 `<AWF_DECISION_RESULT>` 落决策；否则置 ready |
| `SubagentStart` | 记录子 agent（`pcx.agents` + run-meta），事件写 `.awf/logs/subagent-events.jsonl` |
| `SubagentStop` | 标记子 agent stopped；解析 `RESULT:` / `NEEDS_INPUT:` 落账（`settleSubagent`）或记 needs-input；写事件/失败日志 |
| `PreToolUse` + `tool_name=AskUserQuestion` | 决策化：捕获问题置 decisionPending，或在决策闸门开启时 deny 并回 `ccOutput` |
| `PostToolUse` + `tool_name=AskUserQuestion` | 捕获回答，回填 decisionPending（`answered:true`） |

其它事件：仅记录、不改 state。

**响应**

```json
{ "ok": true, "event": "<event|null>", "state": "<ready|busy>", "ccOutput": <object?> }
```

- `ccOutput` 仅在被闸门阻断时出现，由网关作为 hook 输出回传 Claude Code。
- 带 `sid` 时走 `handleSidHook`，响应为 `{ ok, event, state, sid }`（无 `ccOutput`）。

### 3.3 `GET /awf/state` —— 读 state.json

**查询参数**：`p`（否）、`sid`（否）。

- 无 `sid` → `pcx.stores.state.readSync()` → `<root>/.awf/state.json`
- 有 `sid` → `storeCore.readJsonSync(pcx.runStateFile(sid))` → `<root>/.awf/runs/<sid>/state.json`

**响应**：`200` + state.json 原文（`JSON.stringify(s, null, 2)`，**无 `ok` 字段**）。读不到 → `404 {ok:false,error:"state.json not found[ for run <sid>]"}`。

### 3.4 `GET /awf/metrics` —— run 指标快照

**响应**：`{ ok: true, metrics: <readRunMetrics 输出> }`（含 `sources.mainSessionId`、`activeAgents` 等；内部 1s 缓存）。

### 3.5 `/awf/diagnostics` —— run 诊断

- `GET`：`{ ok: true, diagnosis: <readDiagnosis 输出 | null> }`
- `POST`：触发 `startRunDiagnosis`（内部 spawn `claude -p`，异步）。
  - 已在进行中 → `409 {ok:false, error:"diagnosis already running"}`
  - 已受理 → `202 {ok:true, diagnosis:<pending 记录>}`

### 3.6 `GET /awf/decisions` —— 决策聚合列表

**响应**：`{ ok: true, total: <n>, decisions: [...] }`（`DecisionStore(root).listAll()`）。

### 3.7 `POST /awf/decisions/:id/override` —— 人工覆盖决策

路径：`/awf/decisions/<decisionId>/override`，`decisionId` 经 `decodeURIComponent`。

**请求体**

| 字段 | 必填 | 说明 |
|---|---|---|
| `instruction` | 是 | 非空字符串（trim 后），覆盖指令 |
| `original_answer` | 否 | 原决策 answer（字符串，否则记 null） |

**响应**

- `200 { ok:true, decision_id, runStamp, reviewTaskId }`（`reviewTaskId` = 追加的纠偏任务 id，形如 `<decisionId>-REV`）
- `400 { ok:false, error:"override 需要非空 instruction" }`
- `404 { ok:false, error }`（商店 override 抛错）
- `500 { ok:false, error:"override 已记录但纠偏任务追加失败：…", decision_id }`

副作用：写决策存储 + 记 `decision_overridden` 日志 + 向任务列表追加 `kind=dev / source=decision_review` 的纠偏任务（幂等，已存在则 `reviewTaskId` 复用）。

### 3.8 `/context-ready` —— 上下文快照就绪标记

- `POST`（写类）：置 `pcx.contextReady = true` → `{ ok:true, contextReady:true }`
- `GET`：**一次性消费** —— 读到即复位 → `{ ok:true, ready:<boolean> }`

> **坑**：`GET /context-ready` 是 GET，不受 §1.3 约束，但**有副作用**（把解析出的项目上下文的 `contextReady` 复位）。缺 `?p` 时它会消费 **boot 项目**的标记。客户端 `client.js` 的 `getContextReady(port, project)` 会带 `project`，正常调用无碍。
>
> 另注：`/context-ready` 只操作项目级 `pcx.contextReady`，与 `?sid` 的 run 槽 `contextReady` **不互通**（见 §6 观察项）。

### 3.9 `POST /choice` —— AI 通知：需要人做选择

**请求体**（`interact.validateDecisionRequest('choice', …)`）：`{ question: string, options?: string[], context?: string }`

**响应**：`200 { ok:true, decisionPending:<decision> }`；非法体 → `400 {ok:false, error:"body must be {question: string, options?: string[]}"}`。

### 3.10 `POST /ask` —— AI 通知：需要人自由输入

**请求体**：`{ question: string, context?: string }`

**响应**：`200 { ok:true, decisionPending }`；非法体 → `400 {ok:false, error:"body must be {question: string}"}`。

### 3.11 `POST /send` —— 注入 prompt

**请求体**：`{ text: string }`（非空）

**响应**：`200 { ok:true, sent:<text> }`

**错误**：`400`（body 非 `{text:非空}`）、`503 {ok:false,error:"tmux session '<name>' not found; run bootstrap.sh"}`、`409 {ok:false,error:"still busy (ready timeout)"}`。

语义：等就绪 → 标 busy → `captureFromTranscript` → 记 prompt 日志 → tmux 注入 → 立即返回（不等本回合结束）。

### 3.12 `POST /cmd` —— 注入本地 slash 命令

**请求体**：`{ cmd: string }`（非空）

**响应**：`200 { ok:true, sent:<cmd> }`；错误同 `/send`（`400`/`503`/`409`）。

语义：本地命令不产生 Stop hook，故注入后起 `CC_LOCAL_CMD_MS`（默认 1500ms）兜底回 ready。

### 3.13 `POST /intervene` —— w-monitor 受控介入

**前置**：`requirePaused` —— 当前项目 `state.mode === 'pause'`，否则 `409 {ok:false, error:"intervention requires mode=pause (current: <mode|unknown>)"}`。

**请求体**：`{ text: string, reason?: string }`

**响应**：`200 { ok:true, sent:<text>, intervention:true }`；`400`（body 非法）、`409`（未 pause）、`503`（无 tmux）。

语义：记介入日志 → 标 busy → 注入（**允许 busy 排队**）。

### 3.14 `POST /intervene/interrupt` —— w-monitor 升级中断

**前置**：同样 `requirePaused`（`409` 否则）。

**请求体**：`{ reason?: string }` → `200 { ok:true, interrupted:true, reason:<reason|null> }`；`409`/`503`。

语义：tmux `sendCtrlC()` → 清决策 → 清兜底定时器 → 起本地命令兜底定时器回 ready。

### 3.15 `POST /stop` —— 中断当前 Claude 流

**请求体**：无。

**响应**：`200 { ok:true, stopped:true }`；`503`（无 tmux）。

语义：`sendCtrlC()` + 清决策 + 兜底定时器。**无 pause 前置**（与 `/intervene/interrupt` 的区别）。

### 3.16 `POST /respond` —— CLI 回应决策

**请求体**：`{ value: string }`（非空）

**响应**：`200 { ok:true, sent:<value> }`

**错误**：`400`（body 非法；同时清决策）、`503`（无 tmux；同时清决策）、`409`（无 pending 且会话 busy）。

语义：若无 pending 则先等 ready；有 pending 则记 choice 日志并清决策 → 标 busy → 注入 value；兜底定时器：有 pending 用 `CC_DECISION_FALLBACK_MS`（默认 300000ms），否则用本地命令超时。

### 3.17 `POST /run/submit` —— 提交 run

**请求体**：`{ runId?: string, mode?: 'single'|'batch' }`（`mode` 缺省由宿主按 `cfg.agents.max` 判定；`runId` 缺省 `"default"`）

**响应**：`202 { ok:true, runId, mode }`；`409 {ok:false,error,runId}`（已在跑/同 id 冲突）；`503 {ok:false,error:"run host 未就绪: …"}`。

语义：惰性装配 run host（`bootstrapRunHost`）→ `host.submitRun` → 驱动异步进行，本调用立即返回。同一宿主同时只驱动一个 run。

### 3.18 `GET /run/status` —— run 状态快照

**查询参数**：`p`（否）、`runId`（否）

**响应**：`runHost.snapshot(runId)` 原样返回：

- 带 `runId`：`{ ok:true, run: <runSummary> }`，或 `{ ok:false, error:"run <id> 不存在" }`
- 不带：`{ ok:true, runs: [<runSummary>, …] }`

`runSummary` 字段：`runId, mode, status, error, queuedAt, startedAt, finishedAt, updatedAt, counts{total,done,blocked,active,pending}, currentTaskId, currentTaskTitle, currentChain, currentStage`。
`status` ∈ `queued | running | done | error | stopped`。

未就绪 → `503`。

### 3.19 `GET /run/events` —— 轮询 run 事件

**查询参数**

| 参数 | 默认 | 说明 |
|---|---|---|
| `afterSeq` | `0` | 返回 seq 大于该值的增量事件（非整数/负数 → 0） |
| `runId` | 不过滤 | 仅返回该 run 的事件 |

**响应**：

```json
{ "ok": true, "events": [ { "seq": 1, "runId": "default", "type": "run.started", "at": "<ISO>", "payload": {} } ],
  "afterSeq": <本批最后一条 seq | 入参 afterSeq>, "tailSeq": <事件环最大 seq>, "trimmed": <已裁剪的最小 seq> }
```

事件类型：`run.submitted` `run.started` `run.phase` `run.stopped` `run.error` `task.started` `task.done` `task.blocked` `gate.fix`；server 另经 `publishHostEvent` 推送 `decision.required`、`decision.record`。事件环上限 10000（超限从头部裁剪，seq 单调不回退）。服务端单批**硬上限 200 条**（`limit` 参数**不被读取**）。未就绪 → `503`。

### 3.20 `POST /run/state/mode` —— 置工作流 mode

**请求体**：`{ mode: 'run'|'idle'|'pause' }`

**响应**：`200 { ok: <bool>, mode }`；`400 {ok:false,error:"body must be {mode: run|idle|pause}"}`；`503 {ok:false,error:"state api 未就绪"}`。

> `mode=pause` 是编排闩锁：宿主所有派发路径（单 agent executor / `sessionChannel.send` / `batchTransportFor.send`）都 `waitWhilePaused`，暂停期间不再派发新任务。这正是 §1.3 事故的触发端点。

### 3.21 `POST /run/state/task/active` —— 标记任务 active

**请求体**：`{ taskId: string }` → `200 { ok:<bool>, taskId }`；`400`/`503`。

### 3.22 `POST /run/state/gate` —— 门禁完成闭环

**请求体**：`{ taskId: string }`

**响应**：
- 任务存在 → `{ ok:true, applied:true, taskId }`（内部执行 `handleGateCompletion`：blocked+非 pass → 派生修复 + 回退复审）
- 任务不存在 → `{ ok:true, applied:false, reason:"task not found" }`
- `400`（body 非法）

### 3.23 `POST /run/state/backup` —— 版本归档

**请求体**：无（`{}`）→ `200 { ok:true }`；`503`（state api 未就绪）。

### 3.24 `POST /run/state/apply` —— 整体写 state

**请求体**：`{ state: object, expectedLastUpdated?: string|null, expectedStateFingerprint?: string }`（非对象/数组 → `400 {ok:false,error:"body must be {state: object}"}`）。新版 MCP 总是同时发送两个 expected 字段；server 在锁内比较，陈旧快照返回 `409`。不带 expected 字段保留给旧调用方，仍按原有整体写语义处理。

**查询参数**：`sid`（否）—— 有则写 `<root>/.awf/runs/<sid>/state.json`（原子写 + 锁），无则走 `saveState` 写默认 `<root>/.awf/state.json`。

**响应**：`200 { ok:true }`；`409 {ok:false,conflict:true,...}`（CAS 版本冲突）；`400`；`503`（无 sid 且 state api 未就绪）；`500 {ok:false,error:"state 落盘失败: …"}`。

### 3.24a 动态任务规划

- `POST /run/dynamic-planning/proposals?p=<projectRoot>`：提交 `{reason,trigger?,requestedBy?,operations}`；返回已应用、待人工批准或待决策的 proposal。
- `GET /awf/dynamic-planning/proposals?p=<projectRoot>&proposalId=<id>`：读取单个 proposal；不传 `proposalId` 返回列表；对外不返回内部 `proposedState`。
- `POST /run/dynamic-planning/proposals/<id>/approve?p=<projectRoot>`：人工批准 `{reviewer,note?}`；基线指纹冲突时不落 state。
- `POST /run/dynamic-planning/proposals/<id>/reject?p=<projectRoot>`：人工拒绝 `{reviewer,note?}`。
- `POST /awf/decisions/<decisionId>/resolve?p=<projectRoot>`：高风险动态规划的正式人工决策入口；body `{outcome:"approve"|"reject",reviewer,note?}`。成功追加 `decision_completed(status=reviewed)`，并应用或拒绝关联 proposal；普通 proposal approve/reject 不能绕过它。

执行模式来自 `.awf/config.json` 的 `run.dynamicPlanning.mode`：`auto_then_review` 或 `approve_then_apply`。完整协议见 `docs/discuss/dynamic-task-planning-capability.md`。

人工批准或待决策期间，server 会在 state 控制区安装 execution hold，调度器会跳过受影响任务及其下游；第一版每个项目只允许一个开放 proposal。任务派发采用“先原子占用、再发送”，发送失败会安全释放占用，从而关闭 proposal 创建与批量派发之间的竞态窗口。

高风险 proposal 创建时会同步追加 `decision_requested(status=awaiting_human, source=dynamic_planning)`。decision 完成记录与 proposal 应用之间支持同 outcome 幂等补记：若 state 已应用但 decision 记录写入中断，重复 resolve 只补 `decision_completed`，不会再次应用 proposal，也不能改换原人工结论。

### 3.25 `POST /oneshot` —— 无状态 LLM 调用

**请求体**：`{ prompt: string, cwd?: string }`（`prompt` 非空；`cwd` 非字符串则忽略）

**响应**：`200` + `runOneShot` 结果（固定 `timeoutMs: 300000`）：

- 成功：`{ ok:true, text:<stdout.trim()> }`
- 失败：`{ ok:false, error:<stderr | "claude -p exited <code>"> }`
- body 非法 → `400 {ok:false,error:"body must be {prompt: non-empty string}"}`

### 3.26 `POST /shutdown` —— 优雅关闭

**请求体**：无。**唯一豁免 `?p` 的写类端点**。

**响应**：`200 { ok:true, shutting:true }`，随后 ~60ms 内 `stop()`（停所有项目的 run host + `server.close()`；若 `require.main === module` 则 `process.exit(0)`）。

### 3.27 兜底 `404`

未命中任何路由的方法/路径 → `404 { ok:false, error:"not found" }`（前端页面产物缺失时，未知 GET 也落此，见 §4）。

---

## 4. 静态托管与前端页面

`GET` 请求若未命中任何显式 API 路由，进入静态托管（`static.cjs` 的 `createStaticHost`）。

**根目录**：`CC_WEB_PUBLIC` env（可覆盖，测试用）|| 默认 `src/server/public`（`npm run build` 构建 `web/` 而来）。

**解析规则**（`resolve(urlPath)`）：

1. 去 query/hash；含 `..` → 拒绝（返回 null）。
2. 别名表 `aliases = { '/': 'index.html' }` 命中即返回对应文件。
3. 直接命中文件 → 返回；否则尝试 `<path>.html`。
4. 仍无 && 启用 SPA 回退（`spa: 'index.html'`）&& 路径 basename 无 `.` → 回退 `index.html`（前端路由如 `/wbs-tree`）。
5. 都失败 → null（交由上层 404）。

**MIME 表**：`.html/.css/.js/.mjs/.json/.svg/.png/.jpg/.ico/.woff2`，其余 `application/octet-stream`。

**产物缺失行为**（server.cjs 刻意不静默）：

- `PAGE_PATHS` 页面路径 → `503 {ok:false, error:"前端产物缺失：请运行 npm run build…", expected}` + `console.warn`。
- 其它未知 GET（如 `/nope-404`）→ `404 {ok:false, error:"not found"}`（**不回退、不空白页**）。

> 历史：legacy 观测页（dashboard/decisions/diagnostics.html/ui.html）与 `theme.css`/`common.js` 已随 T1-119 退役，前端只剩 `src/server/public` 一个来源。`static.cjs` 顶部的文档注释仍描述「临时承载 legacy html、迁移后退役」，属**遗留陈述**，与其 `aliases` 只含 `'/'` 的现状不符。

---

## 5. WebSocket / 事件流

`server.on('upgrade')`（server.cjs L1396）：

- 仅接受路径 `/run/events`；其它路径 → `socket.destroy()`。
- 解析 `?p` 得项目上下文（解析失败回落 boot）→ `bootstrapRunHost(pcx)`。
- run host 未就绪 → destroy socket。
- 成功：`ws.cjs` 完成 RFC6455 握手（`Sec-WebSocket-Accept`），随后订阅 `runHost.subscribe`，把每个事件以**文本帧**推送（`encodeTextFrame(JSON.stringify(event))`，形状同 §3.19 单条事件）。
- 连接关闭/错误 → 取消订阅。

协议实现为极简单向推送：服务端只发文本帧（不掩码），上行只处理 `close(opcode 8)` 与 `ping(9)→pong`。

> 客户端现状：`run-client.js` 的 `subscribe()` 仍是**轮询 `status` 的桩**（注释自述待 WS 接入），`pollRunEvents()` 走 HTTP 轮询 `/run/events`；WS 通道已由 server 侧就绪，前端 web 可直连。

---

## 6. 调用方对照与观察项

### 6.1 端点 → 调用方

| 端点 | CLI | hook 网关 | MCP |
|---|---|---|---|
| `/hook` | — | ✔（`gateway.cjs`，7 事件） | — |
| `/status` | ✔（发现/探活，无 `p`；`?sid` 查槽） | — | awf-session |
| `/send` `/respond` `/cmd` | ✔ | — | — |
| `/context-ready` | ✔（GET 消费） | — | awf-session（POST） |
| `/choice` `/ask` | — | — | awf-session（`awf_await_choice`/`awf_await_input`） |
| `/intervene` `/intervene/interrupt` | — | — | awf-session（`awf_session_intervene` 等） |
| `/awf/state` | ✔ | — | awf-state |
| `/run/state/*` | ✔（`run-client`） | — | awf-state（经 apply） |
| `/run/submit` `/run/status` `/run/events` | ✔（`run-client`） | — | — |
| `/oneshot` | — | — | awf-oneshot |
| `/shutdown` | ✔ | — | — |

### 6.2 通读源码时发现的「文档/注释与实现不符」或潜在坑

1. **`run-client.pollRunEvents({ limit })` 被静默忽略** —— 客户端会拼 `limit=`（`API_ENDPOINTS`/`pollRunEvents`），但 `server.cjs` 的 `/run/events` 处理器**不读 `limit`**（`grep` 无命中），服务端固定按 200 截断。传 `limit` 不报错也无效果。
2. **`?sid` 槽的 `contextReady` 是死值** —— `GET /status?sid=` 会返回 `slot.contextReady`，但 server 从无任何地方调用 `run-slot.setContextReady()`（`/context-ready` 只写项目级 `pcx.contextReady`）。故 sid 槽的 `contextReady` 恒为 `false`。
3. **`body.event` vs `hook_event_name`** —— `/hook` 读的是 `body.event`（或 query `event=`），而 Claude Code 的原生 hook payload 字段是 `hook_event_name`。经 `gateway.cjs` 调用时事件名走 query，无碍；若有人**绕过网关**直接 POST 原始 payload 且不带 query `event=`，事件名会被解析为 `null`。
4. **`GET /context-ready` 是带副作用的 GET** —— 绕过 §1.3 的写类判定，无 `?p` 时消费 boot 项目标记（见 §3.8）。
5. **CLAUDE.md 与实现不符（决策入口）** —— 项目说明称「旧的 `awf_await_choice`/`awf_await_input` 入口已停用（T1-106）」，但 `/choice`、`/ask` 端点仍在 server 存活，且 `plugin/core/mcp/awf-session/server.cjs` 的 `awf_await_choice`/`awf_await_input` 仍实际 POST 它们。停用的只是 tmux 会话内的旧决策语义，HTTP 端点与 MCP 工具未移除。
6. **`static.cjs` 顶部注释已过时** —— 仍描述「承载 legacy html、迁移完成后退役、`defaultAliases()`」，而实际 `aliases` 只剩 `'/'`，legacy 页已随 T1-119 删除（与 §4 末注一致）。
