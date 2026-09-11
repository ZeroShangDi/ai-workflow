# CC Hooks 模块 — 测试用例

> 对应功能文档：`docs/features/hooks.md`
> 源码：`plugin/config.json`（hooks 段，`__PORT__`）+ `plugin/core/hooks/hooks.json`（渲染产物）+ `plugin/core/hooks/gateway.cjs` + `src/server/server.cjs`（`/hook`）+ `src/server/hook-adapter.cjs`
> 测试文件：`tests/unit/hooks.test.js` / `tests/unit/gateway.test.js` / `tests/unit/hook-adapter.test.js` / `tests/integration/decision.test.js`

---

## 测试场景总览

### config.json hooks 结构（`tests/unit/hooks.test.js`）

| # | 场景 | 类别 |
|---|------|------|
| 1 | 文件存在且为合法 JSON，含 `hooks` 键 | 存在性 |
| 2 | 恰好 7 个 Hook 事件键 | 结构 |
| 3 | 7 个 hook 命令均指向 `gateway.cjs`（无 curl，含 `__PORT__`） | 结构 |
| 4 | `__PORT__` 占位符 ≥5 处 | 模板 |
| 5 | `PreToolUse` matcher 为 `AskUserQuestion`，其余 4 个状态/工具 hook 无 matcher | 结构 |
| 18 | `SessionStart` 命令走 gateway（透传 stdin，带 `?p/&sid`） | 命令 |
| 19 | `Stop` 命令指向 gateway（非裸 curl、非 `sh -c`） | 命令 |
| 20 | `PreToolUse` 命令指向 gateway 且 matcher 保留 | 命令 |
| 21 | 裸 curl 事件（当前为空集）仍是 `-m 2` + 容错形态 | 命令 |

### gateway 输出协议（`tests/unit/gateway.test.js`）

| # | 场景 | 类别 |
|---|------|------|
| 22 | 响应含 `ccOutput` → stdout 恰为 `JSON.stringify(ccOutput)`，exit 0 | 协议 |
| 23 | 响应无 `ccOutput`（如 `{ok:true}`）→ stdout 空、exit 0 | 协议 |
| 24 | 响应非 JSON → 视为无 `ccOutput`：stdout 空、exit 0 | 边界 |
| 25 | server 不可达（连接失败）→ stdout 空、exit 0 | 异常 |
| 26 | payload 无 `hook_event_name` → 不发请求、exit 0 空输出 | 边界 |

### hook→领域事件接缝（`tests/unit/hook-adapter.test.js`）

| # | 场景 | 类别 |
|---|------|------|
| 27 | `SessionStart→run.started`；`Stop→run.stopped` | 映射 |
| 28 | cc 细节字段透传进事件 `payload.cc` | 映射 |
| 29 | `SubagentStart/Stop → agent.started/stopped`（带 agentId/taskId） | 映射 |
| 30 | `UserPromptSubmit→run.phase`；`PreToolUse/PostToolUse/未知 → 空` | 映射 |
| 31 | `createHookAdapter.hook` 翻译并 emit（带 runId）返回事件数；缺 `emit` 抛错 | 协议 |

### `/hook` 路由（`tests/integration/decision.test.js`，真实 server）

| # | 场景 | 类别 |
|---|------|------|
| 11 | `SessionStart` → setReady + resetTranscript | 正常 |
| 12 | `UserPromptSubmit` → setBusy | 正常 |
| 13 | `Stop` → clearDecision + setReady + captureTranscript | 正常 |
| 14 | `PreToolUse(AskUserQuestion)` → setDecision | 正常 |
| 15 | `PostToolUse(AskUserQuestion)` 已回答 → answer + answered，原字段保留 | 正常 |
| 16 | `PostToolUse` tool_response 为 string | 格式 |
| 17 | `PostToolUse` tool_response 为 `{answers:{}}` → join values | 格式 |

---

## 详细测试用例

### TC1: 文件存在且为合法 JSON

**前置条件**：项目目录
**执行**：`JSON.parse(fs.readFileSync('plugin/config.json'))`
**断言**：文件存在、解析不抛、含 `hooks` 键

### TC2: 恰好 7 个 Hook 事件键

**执行**：`Object.keys(config.hooks)`
**断言**：含 `SessionStart / UserPromptSubmit / Stop / SubagentStart / SubagentStop / PreToolUse / PostToolUse`，`toHaveLength(7)`

### TC3: 7 个 hook 命令均指向 gateway.cjs

**执行**：遍历 `GATEWAY_EVENTS`（=全部 7 个），读取 `config.hooks[e][0].hooks[0]`
**断言**：`type === 'command'`；`cmd` 含 `node` 与 `${CLAUDE_PLUGIN_ROOT}/hooks/gateway.cjs` 与 `__PORT__`；`cmd` **不含** `curl`
**说明**：`CURL_EVENTS` 当前为空集 —— v0.2.0 后不再有裸 curl hook

### TC4: `__PORT__` 占位符存在

**执行**：`raw.match(/__PORT__/g)`
**断言**：`matches.length >= 5`

### TC5: PreToolUse matcher

**执行**：读 `config.hooks.PreToolUse[0].matcher`
**断言**：`=== 'AskUserQuestion'`；`SessionStart/UserPromptSubmit/Stop/PostToolUse` 的 `matcher` 为 `undefined`

### TC18: SessionStart 命令走 gateway

**断言**：`cmd` 含 `node` / `gateway.cjs` / `__PORT__`，不含 `curl`

### TC19: Stop 命令指向 gateway

**断言**：`cmd` 含 `node` / `gateway.cjs` / `__PORT__`；不含 `curl`、不含 `sh -c`

### TC20: PreToolUse 命令指向 gateway 且 matcher 保留

**断言**：`entry.matcher === 'AskUserQuestion'`；`cmd` 含 `gateway.cjs`、不含 `curl`

### TC21: 裸 curl 事件形态（当前为空集）

**执行**：遍历 `CURL_EVENTS`（空）
**断言**：每个 command 含 `-m 2` 与 `>/dev/null 2>&1`，且以 `; exit 0'` 或 `|| true` 收尾（保留对历史形态的守卫）

### TC22: gateway 响应含 ccOutput

**前置条件**：异步 stub HTTP server 返回 `{ ccOutput: {...} }`；spawn `gateway.cjs <port>`
**执行**：stdin 写 `{ "hook_event_name": "Stop" }`
**断言**：stdout 恰为 `JSON.stringify(ccOutput)`，exit code 0

### TC23: gateway 响应无 ccOutput

**执行**：stub 返回 `{ ok: true }`
**断言**：stdout 空、exit 0

### TC24: gateway 响应非 JSON

**断言**：stdout 空、exit 0

### TC25: gateway server 不可达

**断言**：连接失败 → stdout 空、exit 0（静默）

### TC26: gateway payload 无 hook_event_name

**断言**：不发请求、stdout 空、exit 0

### TC27-30: `translateHook` 映射

**执行**：`translateHook({ hook_event_name: ... })`
**断言**：
- `SessionStart → [{type:'run.started'}]`；`Stop → [{type:'run.stopped'}]`
- cc 字段（`session_id` 等）进事件 `payload.cc`
- `SubagentStart → agent.started`（`payload.agentId`）；`SubagentStop → agent.stopped`（`agentId`/`taskId`）
- `UserPromptSubmit → run.phase`；`PreToolUse/PostToolUse/未知 → []`

### TC31: `createHookAdapter`

**执行**：`createHookAdapter({ emit }).hook(payload, { runId })`
**断言**：翻译后逐事件 emit（带 `runId`），返回事件数；未知 hook 返回 0 不 emit；缺 `emit` 抛错

### TC11: /hook SessionStart

**前置条件**：真实 server（port 0），state='busy'
**执行**：`POST /hook { "event": "SessionStart" }`
**断言**：state → 'ready'；`logger.resetTranscript()` 被调用；返回 `{ ok:true, event:'SessionStart', state:'ready' }`

### TC12: /hook UserPromptSubmit

**执行**：`POST /hook { "event": "UserPromptSubmit" }`
**断言**：state → 'busy'；返回 `{ state:'busy' }`

### TC13: /hook Stop

**前置条件**：state='busy'，decisionPending 非 null
**执行**：`POST /hook { "event": "Stop" }`
**断言**：decisionPending → null；state → 'ready'；`captureFromTranscript()` 被调用

### TC14: /hook PreToolUse AskUserQuestion

**执行**：POST `tool_name:'AskUserQuestion'` + `tool_input.questions[0]`（question/multiSelect/options/header）
**断言**：`decisionPending = { type, multiSelect, question, options:[labels], header, source:'AskUserQuestion' }`；返回 200

### TC15: /hook PostToolUse 已回答

**执行**：POST `tool_response: { answer: '方案A' }`
**断言**：`decisionPending.answer==='方案A'`；`answered===true`；原字段保留

### TC16 / TC17: PostToolUse tool_response 格式

**执行**：`tool_response` 为 string / `{ answers:{q1,q2} }`
**断言**：string → answer 直取；`{answers}` → `Object.values().join(', ')`

---

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| `plugin/config.json` | 直接读取文件 | 静态结构验证，不用 mock |
| gateway | 真实 spawn `gateway.cjs` + stub HTTP server | 验证 stdout 输出协议与 exit code |
| `/hook` 路由 | 真实 `server.start(0)`（集成） | 直发 hook payload 驱动状态机，不依赖真实 Claude |
| `hook-adapter` | 纯函数直测 | `translateHook` / `createHookAdapter`，注入 spy `emit` |
| tmuxlib / run-logger | `vi.mock` | `hasSession`、`sendText/sendEnter`、`resetTranscript/captureFromTranscript` |
| state 变量 | 经 pcx / 槽访问 | 集成测试用真实 server 状态与 `/status` 断言 |
