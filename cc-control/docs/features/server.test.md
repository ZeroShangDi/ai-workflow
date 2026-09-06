# 实时面板模块 — 测试用例文档

> 对应需求文档：`docs/features/server.md`
> 源码文件：`src/server/server.cjs` + `src/server/dashboard.html`
> 测试文件：`tests/integration/server.test.js`

---

## 测试场景总览

### 路由测试 — 20 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 1 | GET / → 返回 dashboard.html | 正常 |
| 2 | GET / → dashboard.html 不存在时 fallback ui.html | 异常 |
| 3 | GET / → 两者都不存在 → 500 | 异常 |
| 4 | GET /ui → 返回 ui.html | 正常 |
| 5 | GET /ui → 不存在 → 500 | 异常 |
| 6 | GET /awf/state → 200 + JSON | 正常 |
| 7 | GET /awf/state → 文件不存在 → 404 | 异常 |
| 8 | GET /status → 返回 state/session/decisionPending | 正常 |
| 9 | GET /status?snapshot=true → 包含 snapshot | 正常 |
| 10 | POST /send → 正常发送 prompt | 正常 |
| 11 | POST /send → body.text 为空 → 400 | 验证 |
| 12 | POST /send → session 不存在 → 503 | 异常 |
| 13 | POST /send → waitReady 超时 → 409 | 异常 |
| 14 | POST /cmd → 正常发送命令 | 正常 |
| 15 | POST /cmd → body.cmd 为空 → 400 | 验证 |
| 16 | POST /cmd → session 不存在 → 503 | 异常 |
| 17 | POST /respond → 正常回应 | 正常 |
| 18 | POST /choice → 正常设置 decision | 正常 |
| 19 | POST /ask → 正常设置 decision | 正常 |
| 20 | 未知路由 → 404 | 边界 |

### 状态机测试 — 7 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 21 | SessionStart → setReady | 正常 |
| 22 | UserPromptSubmit → setBusy | 正常 |
| 23 | Stop → clearDecision + setReady | 正常 |
| 24 | ready→busy→ready 完整往返 | 集成 |
| 25 | waitReady: 当前 ready → 立即返回 true | 正常 |
| 26 | waitReady: 当前 busy → 等待后返回 | 正常 |
| 27 | waitReady: 超时 → 返回 false | 边界 |

### /hook 事件测试 — 5 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 28 | /hook SessionStart → ready + resetTranscript | 正常 |
| 29 | /hook UserPromptSubmit → busy | 正常 |
| 30 | /hook Stop → clearDecision + ready + captureTranscript | 正常 |
| 31 | /hook PreToolUse AskUserQuestion → setDecision | 正常 |
| 32 | /hook PostToolUse AskUserQuestion → 更新 answer | 正常 |

### dashboard.html 测试 — 5 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 33 | 文件存在性验证（服务器目录） | 存在性 |
| 34 | 关键 DOM 元素：topbar/phaseChain/taskList/output | 结构 |
| 35 | PHASES 数组包含 8 个阶段 | 数据 |
| 36 | canon 函数：CODE/DEBUG/DOCS → DEV | 逻辑 |
| 37 | refresh 调用 /awf/state 和 /status?snapshot=true | 行为 |

---

## 详细测试用例

### TC1: GET / → 返回 dashboard.html

**前置条件**：dashboard.html 文件存在

**执行**：`GET http://127.0.0.1:8787/`

**断言**：
- 状态码 200
- Content-Type 包含 `text/html`
- body 包含 `<title>AWF Run — Dashboard</title>`
- body 包含 `id="taskList"`

---

### TC2: GET / → dashboard 不存在时 fallback ui.html

**前置条件**：dashboard.html 不存在，ui.html 存在

**执行**：`GET /`（mock fs.readFileSync('/' + dashboard) 抛异常，ui 成功）

**断言**：
- 返回 ui.html 内容
- 状态码 200

---

### TC3: GET / → 两者都不存在 → 500

**前置条件**：dashboard.html 和 ui.html 都不存在

**执行**：`GET /`

**断言**：
- 状态码 500
- `{ ok: false, error: 'no page found' }`

---

### TC4: GET /ui → 返回 ui.html

**前置条件**：ui.html 存在

**执行**：`GET /ui`

**断言**：
- 状态码 200
- Content-Type 包含 `text/html`

---

### TC5: GET /ui → 不存在 → 500

**前置条件**：ui.html 不存在

**执行**：`GET /ui`

**断言**：
- 状态码 500
- `{ ok: false, error: 'ui.html not found' }`

---

### TC6: GET /awf/state → 返回 JSON

**前置条件**：`{CC_PROJECT}/.awf/state.json` 存在

**执行**：`GET /awf/state`

**断言**：
- 状态码 200
- Content-Type 包含 `application/json`
- body 可 JSON.parse，包含 mode/version/tasks 等字段

---

### TC7: GET /awf/state → 文件不存在 → 404

**前置条件**：state.json 不存在

**执行**：`GET /awf/state`

**断言**：
- 状态码 404
- `{ ok: false, error: 'state.json not found at ...' }`

---

### TC8: GET /status → 返回状态对象

**前置条件**：server 运行中，state='ready'

**执行**：`GET /status`

**断言**：
- `res.state` = `'ready'`
- `res.session` = true
- `res.decisionPending` = null
- `res.ok` = true

---

### TC9: GET /status?snapshot=true → 包含 snapshot

**前置条件**：tmux capture 返回 `"pane content"`

**执行**：`GET /status?snapshot=true`

**断言**：
- `res.snapshot` = `"pane content"`
- 其他字段同样正常（state, session, decisionPending）

---

### TC10: POST /send → 正常发送 prompt

**前置条件**：session 存在，state='ready'，text="do something"

**执行**：`POST /send { "text": "do something" }`

**断言**：
- waitReady 被调用
- captureFromTranscript 被调用
- logPrompt("do something") 被调用
- setBusy 后 state='busy'
- submit("do something") 被调用（sendText + sendEnter）
- 返回 `{ ok: true, sent: "do something" }`

---

### TC11: POST /send → body.text 为空 → 400

**前置条件**：无

**执行**：`POST /send { "text": "" }`

**断言**：
- 状态码 400
- `{ ok: false, error: 'body must be {text: non-empty string}' }`

---

### TC12: POST /send → session 不存在 → 503

**前置条件**：`tmuxlib.hasSession()` 返回 false

**执行**：`POST /send { "text": "hi" }`

**断言**：
- 状态码 503
- error 包含 "tmux session ... not found"

---

### TC13: POST /send → waitReady 超时 → 409

**前置条件**：state='busy'，120s 内无 Stop hook

**执行**：`POST /send { "text": "hi" }`，推进 121s

**断言**：
- waitReady 返回 false
- 状态码 409
- `{ ok: false, error: 'still busy (ready timeout)' }`

---

### TC14: POST /cmd → 正常发送命令

**前置条件**：session 存在，state='ready'，cmd="/clear"

**执行**：`POST /cmd { "cmd": "/clear" }`

**断言**：
- waitReady 被调用
- setBusy → submit("/clear")
- 返回 `{ ok: true, sent: "/clear" }`
- 1.5s fallback timer 被设置

---

### TC15: POST /cmd → body.cmd 为空 → 400

**前置条件**：无

**执行**：`POST /cmd {}`

**断言**：
- 状态码 400

---

### TC16: POST /cmd → session 不存在 → 503

**前置条件**：`hasSession()` 返回 false

**执行**：`POST /cmd { "cmd": "/clear" }`

**断言**：
- 状态码 503
- submit 不被调用

---

### TC17: POST /respond → 正常回应

**前置条件**：decisionPending 存在，state='busy'

**执行**：`POST /respond { "value": "1" }`

**断言**：
- waitReady **不被调用**（跳过死锁）
- logChoice(question, "1") 被调用
- submit("1") 被调用
- 返回 `{ ok: true, sent: "1" }`

---

### TC18: POST /choice → 正常设置

**前置条件**：server 运行中

**执行**：`POST /choice { "question": "选择?", "options": ["A", "B"] }`

**断言**：
- decisionPending.type = `'choice'`
- decisionPending.options = `['A', 'B']`
- 返回 200 + decisionPending

---

### TC19: POST /ask → 正常设置

**前置条件**：server 运行中

**执行**：`POST /ask { "question": "输入?" }`

**断言**：
- decisionPending.type = `'text'`
- decisionPending.question = `'输入?'`
- 返回 200

---

### TC20: 未知路由 → 404

**前置条件**：server 运行中

**执行**：`GET /nonexistent`

**断言**：
- 状态码 404
- `{ ok: false, error: 'not found' }`

---

### TC21: SessionStart → setReady

**前置条件**：state='busy'，有 2 个 waiters

**执行**：`POST /hook { event: 'SessionStart' }`

**断言**：
- state 变为 'ready'
- waiters 全部 resolve(true)
- resetTranscript 被调用
- 返回 `{ state: 'ready' }`

---

### TC22: UserPromptSubmit → setBusy

**前置条件**：state='ready'

**执行**：`POST /hook { event: 'UserPromptSubmit' }`

**断言**：
- state 变为 'busy'
- 返回 `{ state: 'busy' }`

---

### TC23: Stop → clearDecision + setReady

**前置条件**：state='busy'，decisionPending 非 null

**执行**：`POST /hook { event: 'Stop' }`

**断言**：
- decisionPending 变为 null
- state 变为 'ready'
- captureFromTranscript 被调用

---

### TC24: ready→busy→ready 完整往返

**前置条件**：初始 state='ready'

**执行**：
1. POST /send → state='busy'
2. POST /hook Stop → state='ready'

**断言**：
- 步骤 1 后 GET /status → state='busy'
- 步骤 2 后 GET /status → state='ready'
- 整个流程中没有死锁

---

### TC25: waitReady — 当前 ready 立即返回

**前置条件**：state='ready'

**执行**：`await waitReady(5000)`

**断言**：
- 立即返回 true
- 不在 waiters 中添加回调

---

### TC26: waitReady — busy 等待后返回

**前置条件**：state='busy'

**执行**：
1. `const p = waitReady(10000)`
2. 1s 后调 `setReady()`
3. await p

**断言**：
- p resolve(true)
- 等待约 1s

---

### TC27: waitReady — 超时返回 false

**前置条件**：state='busy'

**执行**：`await waitReady(100)` + fake timers 推进 150ms，无 setReady

**断言**：
- resolve(false)
- waiter 从队列移除

---

### TC28: /hook SessionStart 完整验证

**前置条件**：server 启动后

**执行**：`POST /hook { event: 'SessionStart' }`

**断言**：
- 返回 `{ ok: true, event: 'SessionStart', state: 'ready' }`
- 日志包含 `[hook] SessionStart -> ready`

---

### TC29: /hook UserPromptSubmit 完整验证

**前置条件**：state='ready'

**执行**：`POST /hook { event: 'UserPromptSubmit' }`

**断言**：
- 返回 `{ ok: true, event: 'UserPromptSubmit', state: 'busy' }`

---

### TC30: /hook Stop 完整验证

**前置条件**：decisionPending 存在，state='busy'

**执行**：`POST /hook { event: 'Stop' }`

**断言**：
- decisionPending = null
- state = 'ready'
- 返回包含 `state: 'ready'`

---

### TC31: /hook PreToolUse AskUserQuestion

**前置条件**：decisionPending = null

**执行**：
```json
POST /hook {
  "event": "PreToolUse",
  "tool_name": "AskUserQuestion",
  "tool_input": {
    "questions": [{
      "question": "选择方案",
      "multiSelect": false,
      "options": [{ "label": "A" }, { "label": "B" }]
    }]
  }
}
```

**断言**：
- decisionPending.source = 'AskUserQuestion'
- decisionPending.question = '选择方案'
- decisionPending.options = ['A', 'B']
- decisionPending.type = 'choice'

---

### TC32: /hook PostToolUse AskUserQuestion

**前置条件**：decisionPending 存在且 source='AskUserQuestion'

**执行**：`POST /hook { "event": "PostToolUse", "tool_name": "AskUserQuestion", "tool_response": { "answer": "A方案" } }`

**断言**：
- decisionPending.answer = 'A方案'
- decisionPending.answered = true

---

### TC33: dashboard.html 文件存在性

**前置条件**：项目目录

**执行**：`fs.existsSync('src/server/dashboard.html')`

**断言**：
- 返回 true
- 文件大小 > 0

---

### TC34: dashboard.html 关键 DOM 元素

**前置条件**：读取 HTML 文件内容

**执行**：解析 HTML，检查关键元素

**断言**：
- 存在 `id="projectName"`（项目名）
- 存在 `id="currentPhase"`（当前阶段）
- 存在 `id="progress"`（进度 N/M）
- 存在 `id="phaseChain"`（阶段链）
- 存在 `id="taskList"`（任务列表）
- 存在 `id="output"`（实时输出）
- 存在 `id="connStatus"`（连接状态）
- 存在 `id="errorBar"`（错误提示）

---

### TC35: PHASES 数组

**前置条件**：读取 HTML 中 script 部分

**执行**：提取 PHASES 常量

**断言**：
- `PHASES = ['PLAN', 'DESIGN', 'CODE', 'DEV', 'REVIEW', 'TEST', 'COMMIT', 'FINISH']`
- 共 8 个元素

---

### TC36: canon 函数逻辑

**前置条件**：提取 canon 函数

**执行**：
- `canon('CODE')`
- `canon('DEBUG')`
- `canon('DOCS')`
- `canon('PLAN')`

**断言**：
- `'CODE' → 'DEV'`
- `'DEBUG' → 'DEV'`
- `'DOCS' → 'DEV'`
- `'PLAN' → 'PLAN'`（不改）

---

### TC37: refresh 行为

**前置条件**：模拟前端环境

**执行**：分析 refresh() 函数

**断言**：
- 调用 `fetch('/awf/state')`
- 成功后调用 `fetch('/status?snapshot=true')`
- 失败时设置 connStatus 为 "离线"
- snapshot 与上次相同时不更新 output
- `setInterval(refresh, 2000)` 每 2 秒执行

---

## Mock 策略

| 模块 | 方式 | 说明 |
|------|------|------|
| server 路由 | 启动真实 HTTP server | 通过 http.request 发送请求，测试实际响应 |
| tmuxlib | `vi.mock` | mock hasSession/sendText/sendEnter/capture，控制 session 存在性 |
| run-logger | `vi.mock` | mock logPrompt/logChoice/captureFromTranscript/resetTranscript |
| fs (dashboard) | 真实文件或 `vi.mock` | 控制 HTML 文件存在性 |
| fake timers | `vi.useFakeTimers` | 控制 waitReady 超时、fallback timer |
