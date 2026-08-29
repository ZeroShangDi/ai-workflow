# 自动决策模块 — 测试用例文档

> 对应需求文档：`docs/features/auto-decision.md`
> 源码文件：`src/lib/session/client.js`（autoSelect / waitForReady）+ `src/server/server.cjs`（/hook, /choice, /ask, /respond, /status）
> 测试文件：`tests/unit/auto-selector.test.js` + `tests/integration/decision.test.js`

---

## 测试场景总览

### src/lib/session/client.js（autoSelect / waitForReady）— 4 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 1 | 单选：等待 5s 后返回 index=1 | 正常 |
| 2 | 多选：返回 multiSelect + selected[0] | 正常 |
| 3 | 无 options → label 为空字符串 | 边界 |
| 4 | 超时时间恒为 5s | 边界 |

### decision 状态机 — 6 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 5 | setDecision / clearDecision 正确设置/清空 | 正常 |
| 6 | setReady 唤醒所有 waiters | 正常 |
| 7 | waitReady: 当前 ready → 立即返回 true | 正常 |
| 8 | waitReady: 当前 busy → 等待唤醒后返回 true | 正常 |
| 9 | waitReady: 超时未唤醒 → 返回 false | 边界 |
| 10 | setBusy → state='busy' | 正常 |

### /hook 路由 — 7 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 11 | SessionStart → setReady + resetTranscript | 正常 |
| 12 | UserPromptSubmit → setBusy | 正常 |
| 13 | Stop → clearDecision + setReady + captureTranscript | 正常 |
| 14 | PreToolUse: AskUserQuestion → setDecision | 正常 |
| 15 | PostToolUse: 已回答 → 更新 decision.answer + answered | 正常 |
| 16 | PostToolUse: tool_response 为 string | 格式 |
| 17 | PostToolUse: tool_response 为 {answers:{}} | 格式 |

### /choice /ask /respond 路由 — 8 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 18 | /choice: 正常设置 decision | 正常 |
| 19 | /choice: question 为空 → 400 | 验证 |
| 20 | /ask: 正常设置 decision(type=text) | 正常 |
| 21 | /ask: question 为空 → 400 | 验证 |
| 22 | /respond: 有 decisionPending → 跳过 waitReady | 关键逻辑 |
| 23 | /respond: 无 decisionPending → 正常 waitReady | 关键逻辑 |
| 24 | /respond: value 为空 → clearDecision + 400 | 验证 |
| 25 | /respond: session 不存在 → 503 | 异常 |

### 完整链路 — 3 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 26 | AskUserQuestion 完整闭环 | 集成 |
| 27 | /choice → /respond 闭环 | 集成 |
| 28 | /ask(text) → /respond 闭环 | 集成 |

### 边界 — 3 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 29 | /respond fallback timer: 有 decision → 5min | 边界 |
| 30 | /respond fallback timer: 无 decision → 1.5s | 边界 |
| 31 | /status 返回 decisionPending 字段 | 边界 |

---

## 详细测试用例

### TC1: autoSelect — 单选

**前置条件**：decision = `{ multiSelect: false, options: ['A方案', 'B方案'], question: '选择' }`

**执行**：`await autoSelect(decision)`（使用 fake timers 跳过 5s）

**断言**：
- 等待 5000ms
- 控制台输出 "5s 后默认选第一项..."
- 控制台输出 "自动选择: A方案"
- 返回 `{ index: 1, label: 'A方案' }`

---

### TC2: autoSelect — 多选

**前置条件**：decision = `{ multiSelect: true, options: ['X', 'Y'], question: '多选' }`

**执行**：`await autoSelect(decision)`

**断言**：
- 返回 `{ multiSelect: true, selected: [0], customInput: '' }`
- 控制台输出 "自动选择: X"

---

### TC3: autoSelect — 无 options

**前置条件**：decision = `{ multiSelect: false, options: [], question: '?' }`

**执行**：`await autoSelect(decision)`

**断言**：
- `decision.options[0]` 为 undefined
- label 为 `''`（空字符串）
- 返回 `{ index: 1, label: '' }`
- 不抛异常

---

### TC4: autoSelect — 超时恒为 5s

**前置条件**：任意 decision

**执行**：检查源码 `DEFAULT_TIMEOUT_MS`

**断言**：
- 值为 `5000`
- 不可被外部覆盖（const）

---

### TC5: setDecision / clearDecision

**前置条件**：decisionPending 初始为 null

**执行**：
1. `setDecision({ type: 'choice', question: 'Q' })`
2. 检查 decisionPending
3. `clearDecision()`
4. 检查 decisionPending

**断言**：
- 步骤 2：decisionPending = `{ type: 'choice', question: 'Q' }`
- 步骤 4：decisionPending = null

---

### TC6: setReady 唤醒所有 waiters

**前置条件**：state = 'busy'，有 3 个 waiter 正在 waitReady(10s)

**执行**：`setReady()`

**断言**：
- 所有 3 个 waiter 的 Promise 都 resolve(true)
- waiters 数组被清空
- state = 'ready'

---

### TC7: waitReady — 当前 ready 立即返回

**前置条件**：state = 'ready'

**执行**：`await waitReady(5000)`

**断言**：
- 立即返回 `true`（不等待）
- 不创建 Promise

---

### TC8: waitReady — 当前 busy 等待唤醒

**前置条件**：state = 'busy'

**执行**：
1. `const p = waitReady(10000)`
2. 500ms 后 `setReady()`
3. `await p`

**断言**：
- p 在 setReady 后 resolve(true)
- 实际等待约 500ms（非 10s 超时）

---

### TC9: waitReady — 超时未唤醒

**前置条件**：state = 'busy'，使用 fake timers

**执行**：`await waitReady(1000)` + 推进 1100ms，不调 setReady

**断言**：
- resolve(false)
- waiter 从 waiters 数组中移除

---

### TC10: setBusy

**前置条件**：state = 'ready'

**执行**：`setBusy()`

**断言**：
- state = 'busy'

---

### TC11: /hook SessionStart

**前置条件**：state = 'busy'，server 运行中

**执行**：`POST /hook { event: 'SessionStart' }`

**断言**：
- state 变为 'ready'
- `logger.resetTranscript()` 被调用
- 返回 `{ ok: true, event: 'SessionStart', state: 'ready' }`

---

### TC12: /hook UserPromptSubmit

**前置条件**：state = 'ready'

**执行**：`POST /hook { event: 'UserPromptSubmit' }`

**断言**：
- state 变为 'busy'
- 返回 `{ state: 'busy' }`

---

### TC13: /hook Stop

**前置条件**：state = 'busy'，decisionPending 非 null

**执行**：`POST /hook { event: 'Stop' }`

**断言**：
- decisionPending 变为 null（clearDecision）
- state 变为 'ready'（setReady）
- `logger.captureFromTranscript()` 被调用

---

### TC14: /hook PreToolUse: AskUserQuestion

**前置条件**：server 运行中，decisionPending = null

**执行**：
```json
POST /hook {
  "event": "PreToolUse",
  "tool_name": "AskUserQuestion",
  "tool_input": {
    "questions": [{
      "question": "选择方案",
      "multiSelect": false,
      "options": [{ "label": "方案A" }, { "label": "方案B" }],
      "header": "方案选择"
    }]
  }
}
```

**断言**：
- decisionPending = `{ type: 'choice', multiSelect: false, question: '选择方案', options: ['方案A', '方案B'], header: '方案选择', source: 'AskUserQuestion' }`
- 返回 200

---

### TC15: /hook PostToolUse: 已回答

**前置条件**：decisionPending = `{ type: 'choice', question: '选择方案', source: 'AskUserQuestion', ... }`

**执行**：
```json
POST /hook {
  "event": "PostToolUse",
  "tool_name": "AskUserQuestion",
  "tool_response": { "answer": "方案A" }
}
```

**断言**：
- decisionPending.answer = `'方案A'`
- decisionPending.answered = true
- 原有字段保留（type, question, source 不变）

---

### TC16: PostToolUse — tool_response 为 string

**前置条件**：decisionPending 存在，source='AskUserQuestion'

**执行**：`POST /hook { "event": "PostToolUse", "tool_name": "AskUserQuestion", "tool_response": "直接答案" }`

**断言**：
- `typeof resp === 'string'` → answer = `'直接答案'`

---

### TC17: PostToolUse — tool_response 为 {answers: {}}

**前置条件**：同上

**执行**：`POST /hook { "event": "PostToolUse", "tool_name": "AskUserQuestion", "tool_response": { "answers": { "q1": "A", "q2": "B" } } }`

**断言**：
- answer = `'A, B'`（`Object.values(resp.answers).join(', ')`）

---

### TC18: /choice — 正常设置 decision

**前置条件**：decisionPending = null

**执行**：`POST /choice { "question": "选择方案", "options": ["A", "B"], "context": "ctx" }`

**断言**：
- decisionPending = `{ type: 'choice', question: '选择方案', options: ['A', 'B'], context: 'ctx' }`
- 返回 `{ ok: true, decisionPending }`

---

### TC19: /choice — question 为空 → 400

**前置条件**：无

**执行**：`POST /choice { "options": ["A"] }`（无 question）

**断言**：
- 返回 400
- body 包含 error

---

### TC20: /ask — 正常设置 decision(type=text)

**前置条件**：decisionPending = null

**执行**：`POST /ask { "question": "请输入名称", "context": "可选" }`

**断言**：
- decisionPending = `{ type: 'text', question: '请输入名称', context: '可选' }`
- 不包含 options 字段

---

### TC21: /ask — question 为空 → 400

**前置条件**：无

**执行**：`POST /ask {}`

**断言**：
- 返回 400

---

### TC22: /respond — 有 decisionPending → 跳过 waitReady

**前置条件**：decisionPending 非 null，state = 'busy'

**执行**：`POST /respond { "value": "1" }`

**断言**：
- `waitReady` **不被调用**（因为 `if (!decisionPending)` 为 false）
- 直接 `setBusy()` → `submit('1')`
- `logger.logChoice` 被调用
- fallback timer 设为 300000ms
- 返回 `{ ok: true, sent: '1' }`

---

### TC23: /respond — 无 decisionPending → 正常 waitReady

**前置条件**：decisionPending = null，state = 'ready'

**执行**：`POST /respond { "value": "done" }`

**断言**：
- `waitReady` 被调用
- setBusy → submit('done')
- `logger.logChoice` 不被调用（无 decisionPending）
- fallback timer 设为 LOCAL_CMD_FALLBACK_MS (1500ms)

---

### TC24: /respond — value 为空 → 400

**前置条件**：decisionPending 非 null

**执行**：`POST /respond { "value": "" }`

**断言**：
- `clearDecision()` 被调用
- 返回 400
- submit 不被调用

---

### TC25: /respond — session 不存在 → 503

**前置条件**：decisionPending 非 null，`tmuxlib.hasSession()` 返回 false

**执行**：`POST /respond { "value": "1" }`

**断言**：
- `clearDecision()` 被调用
- 返回 503
- submit 不被调用

---

### TC26: AskUserQuestion 完整闭环（集成测试）

**前置条件**：server 运行中，state = 'ready'

**执行**：
1. `POST /hook` PreToolUse AskUserQuestion → decisionPending 被设置
2. `GET /status` → 返回 decisionPending
3. `POST /respond { "value": "1" }` → submit('1')
4. `POST /hook` Stop → clearDecision + setReady

**断言**：
- 步骤 1：decisionPending.source = 'AskUserQuestion'
- 步骤 2：response.decisionPending 非 null
- 步骤 3：无需 waitReady（跳过死锁），submit 被调用
- 步骤 4：state = 'ready'，decisionPending = null

---

### TC27: /choice → /respond 闭环（集成测试）

**前置条件**：server 运行中

**执行**：
1. `POST /choice { "question": "Q", "options": ["A", "B"] }` → 200
2. `GET /status` → decisionPending.type = 'choice'
3. `POST /respond { "value": "A" }` → 200
4. `GET /status` → decisionPending = null（submit 后 fallback 可能还未清）

**断言**：
- 每步都返回成功
- submit 被调用时参数为 "A"

---

### TC28: /ask(text) → /respond 闭环（集成测试）

**前置条件**：server 运行中

**执行**：
1. `POST /ask { "question": "输入名称" }` → 200
2. `GET /status` → decisionPending.type = 'text'
3. `POST /respond { "value": "myname" }` → 200

**断言**：
- 闭环完成，无异常

---

### TC29: /respond fallback timer: 有 decision → 5min

**前置条件**：decisionPending 非 null

**执行**：`POST /respond { "value": "1" }`，使用 fake timers 推进 301000ms

**断言**：
- 300000ms 后 `state === 'busy'` 时触发
- `clearDecision()` 被调用
- `setReady()` 被调用

---

### TC30: /respond fallback timer: 无 decision → 1.5s

**前置条件**：decisionPending = null

**执行**：`POST /respond { "value": "cmd" }`，使用 fake timers 推进 1600ms

**断言**：
- 1500ms 后若 state 仍 busy → setReady
- clearDecision 不被调用（hadDecision = false）

---

### TC31: /status 返回 decisionPending

**前置条件**：decisionPending = `{ type: 'choice', question: '测试', options: ['A'] }`，state = 'busy'

**执行**：`GET /status`

**断言**：
- response 包含 `decisionPending` 字段
- `decisionPending.question` = `'测试'`
- `decisionPending.options` = `['A']`
- `state` = `'busy'`

---

## Mock 策略

| 模块 | 方式 | 说明 |
|------|------|------|
| autoSelect / waitForReady | `vi.useFakeTimers` | 控制 5 秒超时，加快测试 |
| server 状态机 | 直接操作 setDecision/clearDecision/setReady/setBusy/waitReady | 导出函数进行单元测试 |
| server 路由 | 启动真实 HTTP server 或直接调用 handler | 集成测试用 supertest 风格（http.request） |
| tmuxlib | `vi.mock` | mock hasSession、sendText、sendEnter |
| run-logger | `vi.mock` | mock logChoice、captureFromTranscript、resetTranscript |
