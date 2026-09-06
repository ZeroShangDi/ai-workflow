# CC Hooks 模块 — 测试用例文档

> 对应需求文档：`docs/features/hooks.md`
> 源码文件：`plugin/config.json`（hooks 段，`__PORT__` 占位，render-config.mjs 渲染为 `plugin/core/hooks/hooks.json`）+ `src/server/server.cjs` 的 `/hook` 路由
> 测试文件：`tests/unit/hooks.test.js`

---

## 测试场景总览

### config.json hooks 结构验证 — 5 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 1 | 文件存在且为合法 JSON | 存在性 |
| 2 | 包含 7 个 Hook 事件键 | 结构 |
| 3 | 每个 Hook 的 curl 命令完整性 | 结构 |
| 4 | `__PORT__` 占位符存在 | 模板 |
| 5 | PreToolUse matcher 为 "AskUserQuestion" | 结构 |

### /hook 路由 — 7 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 6 | SessionStart → setReady + resetTranscript | 正常 |
| 7 | UserPromptSubmit → setBusy | 正常 |
| 8 | Stop → clearDecision + setReady + captureTranscript | 正常 |
| 9 | PreToolUse: AskUserQuestion → setDecision | 正常 |
| 10 | PreToolUse: 非 AskUserQuestion → 不影响 | 正常 |
| 11 | PostToolUse: AskUserQuestion → 更新 answer | 正常 |
| 12 | PostToolUse: 非 AskUserQuestion → 不影响 | 正常 |

### 边界条件 — 5 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 13 | 空 body → event 为 undefined | 边界 |
| 14 | 非 JSON body → readJson 返回 null | 边界 |
| 15 | 未知 event → 不改变状态 | 边界 |
| 16 | event 通过 query string 传递（非 body） | 边界 |
| 17 | PreToolUse 无 questions → 不设置 decision | 边界 |

### curl 命令验证 — 4 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 18 | SessionStart curl 命令正确 | 命令 |
| 19 | Stop curl 使用 `-d @-` | 命令 |
| 20 | PreToolUse curl 使用 `sh -c` + `exit 0` | 命令 |
| 21 | 所有 curl 都有 `-m 2` 和 `\|\| true` | 命令 |

---

## 详细测试用例

### TC1: 文件存在且为合法 JSON

**前置条件**：项目目录

**执行**：`JSON.parse(fs.readFileSync('plugin/config.json'))`

**断言**：
- 文件存在
- `JSON.parse` 不抛异常
- 返回对象包含 `hooks` 键

---

### TC2: 包含 7 个 Hook 事件键

**前置条件**：config.json 已解析

**执行**：检查 `Object.keys(config.hooks)`

**断言**：
- 包含 `SessionStart`
- 包含 `UserPromptSubmit`
- 包含 `Stop`
- 包含 `SubagentStart`
- 包含 `SubagentStop`
- 包含 `PreToolUse`
- 包含 `PostToolUse`
- 恰好 7 个键

---

### TC3: 每个 Hook 的 curl 命令完整性

**前置条件**：config.json 已解析

**执行**：遍历 7 个 hook，检查每个 hook 的 command 字符串

**断言**（每个 hook）：
- 包含 `curl`
- 包含 `http://127.0.0.1:__PORT__/hook`
- 包含 `>/dev/null 2>&1`
- 第一个 hooks 数组至少 1 个元素
- 每个 hook 配置的 type 为 `"command"`

---

### TC4: `__PORT__` 占位符存在

**前置条件**：读取原始文件内容

**执行**：检查字符串

**断言**：
- 至少 5 处出现 `__PORT__`（每个 hook 至少 1 次）
- 每次出现都在 curl URL 中

---

### TC5: PreToolUse matcher 为 "AskUserQuestion"

**前置条件**：config.json 已解析

**执行**：检查 `config.hooks.PreToolUse[0].matcher`

**断言**：
- matcher 值为 `"AskUserQuestion"`
- 其他 hook 无 matcher 字段或 matcher 为 undefined（SessionStart/UserPromptSubmit/Stop/PostToolUse）

---

### TC6: /hook SessionStart → setReady + resetTranscript

**前置条件**：state='busy'，mock tmuxlib 和 logger

**执行**：`POST /hook { "event": "SessionStart" }`

**断言**：
- state 变为 'ready'
- `logger.resetTranscript()` 被调用
- waiters（如有）被唤醒
- 返回 `{ ok: true, event: 'SessionStart', state: 'ready' }`

---

### TC7: /hook UserPromptSubmit → setBusy

**前置条件**：state='ready'

**执行**：`POST /hook { "event": "UserPromptSubmit" }`

**断言**：
- state 变为 'busy'
- decisionPending 不变
- 返回 `{ ok: true, event: 'UserPromptSubmit', state: 'busy' }`

---

### TC8: /hook Stop → clearDecision + setReady + captureTranscript

**前置条件**：state='busy'，decisionPending 非 null

**执行**：`POST /hook { "event": "Stop" }`

**断言**：
- decisionPending 变为 null（clearDecision）
- state 变为 'ready'（setReady）
- `logger.captureFromTranscript()` 被调用
- 返回 `{ state: 'ready' }`

---

### TC9: /hook PreToolUse: AskUserQuestion → setDecision

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
- decisionPending.source = `'AskUserQuestion'`
- decisionPending.type = `'choice'`
- decisionPending.question = `'选择方案'`
- decisionPending.options = `['A', 'B']`
- decisionPending.multiSelect = false
- state 不变

---

### TC10: /hook PreToolUse: 非 AskUserQuestion → 不影响

**前置条件**：decisionPending = null

**执行**：`POST /hook { "event": "PreToolUse", "tool_name": "Read", "tool_input": {} }`

**断言**：
- decisionPending 保持 null
- state 不变
- 不报错

---

### TC11: /hook PostToolUse: AskUserQuestion → 更新 answer

**前置条件**：decisionPending = `{ source: 'AskUserQuestion', question: '选择?', ... }`

**执行**：`POST /hook { "event": "PostToolUse", "tool_name": "AskUserQuestion", "tool_response": { "answer": "方案A" } }`

**断言**：
- decisionPending.answer = `'方案A'`
- decisionPending.answered = true
- 原有字段（question 等）保留
- state 不变

---

### TC12: /hook PostToolUse: 非 AskUserQuestion → 不影响

**前置条件**：decisionPending = null

**执行**：`POST /hook { "event": "PostToolUse", "tool_name": "Read", "tool_response": "some text" }`

**断言**：
- decisionPending 保持 null
- 不报错

---

### TC13: 空 body → event 为 undefined

**前置条件**：发送无 body 的 POST

**执行**：`POST /hook`（无 body，无 query）

**断言**：
- `body.event` 为 undefined（readJson 返回 `{}`）
- `searchParams.get('event')` 为 null
- event 为 undefined/null → 不匹配任何 case
- state 不变
- 返回 200（不报错）

---

### TC14: 非 JSON body → readJson 返回 null

**前置条件**：发送非法 JSON body

**执行**：`POST /hook` body = `"not-json"`（Content-Type: application/json）

**断言**：
- `readJson` 返回 null
- `(await readJson(req)) || {}` 降级为 `{}`
- event 为 undefined
- 返回 200（优雅降级）

---

### TC15: 未知 event → 不改变状态

**前置条件**：state='ready'

**执行**：`POST /hook { "event": "UnknownEvent" }`

**断言**：
- state 保持 'ready'
- 不匹配任何已知分支
- 返回 `{ ok: true, event: 'UnknownEvent', state: 'ready' }`

---

### TC16: event 通过 query string 传递

**前置条件**：无 body，event 在 URL 中

**执行**：`POST /hook?event=SessionStart`（无 body 或空 body）

**断言**：
- `searchParams.get('event')` 返回 `'SessionStart'`
- 触发 SessionStart 逻辑：setReady + resetTranscript
- 返回 `{ state: 'ready' }`

---

### TC17: PreToolUse 无 questions → 不设置 decision

**前置条件**：decisionPending = null

**执行**：`POST /hook { "event": "PreToolUse", "tool_name": "AskUserQuestion", "tool_input": { "questions": [] } }`

**断言**：
- `questions.length > 0` 为 false
- setDecision 不被调用
- decisionPending 保持 null

---

### TC18: SessionStart curl 命令格式验证（透传 stdin）

**前置条件**：读取 config.json

**执行**：提取 `config.hooks.SessionStart[0].hooks[0].command`

**断言**：
- 包含 `curl`
- 包含 `-X POST`
- 包含 `?event=SessionStart`
- 包含 `-d @-`（透传原始 payload，server 据此记录 mainSessionId）
- 包含 `sh -c '`
- 以 `; exit 0` 结尾

---

### TC19: Stop curl 使用 `-d @-`

**前置条件**：读取 config.json

**执行**：提取 `config.hooks.Stop[0].hooks[0].command`

**断言**：
- 包含 `-d @-`（透传 session_id，子 agent Stop 不误翻主闩锁）
- event 通过 query string `?event=Stop` 传递
- 包含 `sh -c '` + `; exit 0`

---

### TC20: PreToolUse curl 使用 `sh -c` + `exit 0`

**前置条件**：读取 config.json

**执行**：提取 `config.hooks.PreToolUse[0].hooks[0].command`

**断言**：
- 以 `sh -c '` 开头
- 以 `; exit 0'` 结尾（非 `|| true`）
- 确保 curl 失败时 CC 继续执行 AskUserQuestion tool

---

### TC21: 所有 curl 都有 `-m 2` 和容错

**前置条件**：读取 config.json

**执行**：检查全部 7 个 hook 的 command 字符串

**断言**：
- 每个 command 包含 `-m 2`（2 秒超时）
- 每个 command 包含 `>/dev/null 2>&1`
- 容错统一：透传类（SessionStart/UserPromptSubmit/Stop/SubagentStart/SubagentStop/PreToolUse）以 `; exit 0` 结尾，PostToolUse 以 `|| true` 结尾

---

## Mock 策略

| 模块 | 方式 | 说明 |
|------|------|------|
| config.json | 直接读取文件 | 不用 mock，验证静态结构 |
| /hook 路由 | 启动 HTTP server 或直接测试 handler | mock tmuxlib + logger + state 变量 |
| tmuxlib | `vi.mock` | hasSession 返回 true |
| run-logger | `vi.mock` | 验证 resetTranscript/captureFromTranscript 调用 |
| state 变量 | 直接操作闭包 | 在 server 模块加载前/后设置 state 和 decisionPending |
