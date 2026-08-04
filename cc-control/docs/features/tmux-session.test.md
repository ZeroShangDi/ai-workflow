# tmux & Session 管理模块 — 测试用例文档

> 对应需求文档：`docs/features/tmux-session.md`
> 源码文件：`src/server/tmux.cjs` + `src/mcp/awf-session/server.cjs`
> 测试文件：`tests/unit/tmux.test.js` + `tests/integration/awf-session.test.js`

---

## 测试场景总览

### tmux.cjs — 8 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 1 | hasSession: 存在 → true | 正常 |
| 2 | hasSession: 不存在 → false | 正常 |
| 3 | sendText: 正确拼装 args | 参数验证 |
| 4 | sendEnter: 正确拼装 args | 参数验证 |
| 5 | capture: 正确拼装 args | 参数验证 |
| 6 | tmux 函数: 异常传播 | 异常 |
| 7 | SESSION 默认值 | 边界 |
| 8 | CC_SESSION 环境变量 | 边界 |

### awf-session MCP — 12 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 9 | awf_session_status 正常 | 正常 |
| 10 | awf_capture_pane 正常 | 正常 |
| 11 | awf_await_choice 正常 | 正常 |
| 12 | awf_await_input 正常 | 正常 |
| 13 | awf_await_choice: args 引用 bug | Bug |
| 14 | awf_await_input: args 引用 bug | Bug |
| 15 | httpGet: Server 可达 | HTTP |
| 16 | httpGet: 连接拒绝 → error | HTTP |
| 17 | httpGet: 超时 3s | HTTP |
| 18 | httpPost: 正常 | HTTP |
| 19 | capturePane: execSync 异常 → 不抛 | 异常 |
| 20 | 未知 tool name → error | 异常 |

### JSON-RPC 协议 — 3 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 21 | initialize | 协议 |
| 22 | tools/list 返回 4 个 tools | 协议 |
| 23 | 未知 method → -32601 | 协议 |

---

## 详细测试用例

### TC1: hasSession — 存在 → true

**前置条件**：`execFileSync('tmux', ['has-session', '-t', 'cc'])` 正常返回

**执行**：`hasSession()`

**断言**：
- 返回 `true`
- `tmux(['has-session', '-t', 'cc'])` 被调用

---

### TC2: hasSession — 不存在 → false

**前置条件**：`execFileSync` 抛出异常（session 不存在）

**执行**：`hasSession()`

**断言**：
- 返回 `false`（catch 后不抛）
- 函数正常返回

---

### TC3: sendText — 正确拼装 args

**前置条件**：mock `execFileSync`

**执行**：`sendText('hello world')`

**断言**：
- `execFileSync('tmux', ['send-keys', '-t', 'cc', '-l', 'hello world'], { encoding: 'utf8' })` 被调用
- `-l` 确保 literal 模式（不解释 tmux 快捷键）

---

### TC4: sendEnter — 正确拼装 args

**前置条件**：mock `execFileSync`

**执行**：`sendEnter()`

**断言**：
- `execFileSync('tmux', ['send-keys', '-t', 'cc', 'Enter'], { encoding: 'utf8' })` 被调用

---

### TC5: capture — 正确拼装 args

**前置条件**：mock `execFileSync`

**执行**：`capture()`

**断言**：
- `execFileSync('tmux', ['capture-pane', '-t', 'cc', '-p'], { encoding: 'utf8' })` 被调用
- 返回 execFileSync 的 stdout

---

### TC6: tmux 函数 — 异常传播

**前置条件**：`execFileSync` 抛出（非 hasSession 场景）

**执行**：`sendText('...')`（execFileSync 抛异常）

**断言**：
- 异常直接向上传播（sendText 不 catch）
- 调用方需自行处理

---

### TC7: SESSION 默认值

**前置条件**：`process.env.CC_SESSION` 未设置

**执行**：require tmux.cjs

**断言**：
- `SESSION = 'cc'`
- `hasSession()` 使用 `-t cc`
- `sendText/sendEnter/capture` 均使用 `-t cc`

---

### TC8: CC_SESSION 环境变量

**前置条件**：`process.env.CC_SESSION = 'my-session'`

**执行**：require tmux.cjs

**断言**：
- `SESSION = 'my-session'`
- 所有 tmux 命令参数使用 `-t my-session`

---

### TC9: awf_session_status 正常

**前置条件**：HTTP server 返回 `{ state: 'ready', session: true }`，capturePane 返回 `"pane text..."`

**执行**：`tools/call({ name: 'awf_session_status', arguments: {} })`

**断言**：
- `httpGet('/status')` 被调用
- 返回的 text 中包含 `"state": "ready"` 和 `"pane": "pane text..."`
- pane 截取前 500 字符

---

### TC10: awf_capture_pane 正常

**前置条件**：`execSync('tmux capture-pane -t "cc" -p', ...)` 返回完整文本

**执行**：`tools/call({ name: 'awf_capture_pane', arguments: {} })`

**断言**：
- 返回 textResult 包含完整 pane 文本
- 不经过 HTTP（直接调 execSync）

---

### TC11: awf_await_choice 正常

**前置条件**：args 正确解构，HTTP server 返回 `{ ok: true }`

**执行**：`tools/call({ name: 'awf_await_choice', arguments: { question: '选择?', options: ['A', 'B'] } })`

**断言**：
- `httpPost('/choice', ...)` 被调用
- 请求 body 包含 `{"question":"选择?","options":["A","B"]}`
- 返回 `{ ok: true }`

---

### TC12: awf_await_input 正常

**前置条件**：args 正确解构，HTTP server 返回 `{ ok: true }`

**执行**：`tools/call({ name: 'awf_await_input', arguments: { question: '输入?' } })`

**断言**：
- `httpPost('/ask', ...)` 被调用
- 请求 body 包含 `{"question":"输入?"}`
- 返回 `{ ok: true }`

---

### TC13: args 引用 Bug — awf_await_choice

**前置条件**：`params = { name: 'awf_await_choice', arguments: { question: '选择?' } }`

**执行**：`tools/call(params)`（当前代码：`const { name } = params`，args 未解构）

**断言**：
- `args` 为 `undefined`
- `logStderr` 尝试访问 `args.question` → `TypeError: Cannot read properties of undefined`
- 或 `question: undefined` 发送到 HTTP server → /choice 返回 400（question 非 string）

**修复**：添加 `const { arguments: args } = params || {};`

---

### TC14: args 引用 Bug — awf_await_input

**前置条件**：同上，args 未解构

**执行**：`tools/call({ name: 'awf_await_input', arguments: { question: '输入?' } })`

**断言**：
- 与 TC13 同根因
- 修复后恢复正常

---

### TC15: httpGet — Server 可达

**前置条件**：Session Server 在 8787 端口响应

**执行**：`await httpGet('/status')`

**断言**：
- 返回解析后的 JSON 对象
- 包含 `state` 字段

---

### TC16: httpGet — 连接拒绝

**前置条件**：8787 端口无服务

**执行**：`await httpGet('/status')`

**断言**：
- `req.on('error')` 触发
- 返回 `{ ok: false, error: 'connect ECONNREFUSED ...' }`
- 不抛异常

---

### TC17: httpGet — 超时 3s

**前置条件**：Server 不响应

**执行**：`await httpGet('/status')` + fake timers 推进 3500ms

**断言**：
- `req.setTimeout(3000)` 触发
- `req.destroy()` 被调用
- 返回 `{ ok: false, error: 'timeout' }`

---

### TC18: httpPost — 正常

**前置条件**：Server 在 8787 端口响应

**执行**：`await httpPost('/choice', JSON.stringify({ question: 'Q', options: ['A'] }))`

**断言**：
- Content-Type 为 `application/json`
- Content-Length 正确
- 返回解析后的 JSON 响应

---

### TC19: capturePane — execSync 异常不抛

**前置条件**：`execSync('tmux ...')` 抛出异常（如 session 不存在）

**执行**：`capturePane()`

**断言**：
- 不抛异常
- 返回 `"(capture failed: ...)"`
- 调用方不会因 pane capture 失败而中断

---

### TC20: 未知 tool name → error

**前置条件**：无

**执行**：`tools/call({ name: 'unknown_tool' })`

**断言**：
- 返回 `{ ok: false, error: 'unknown tool: unknown_tool' }`

---

### TC21: JSON-RPC initialize

**前置条件**：server 启动

**执行**：发送 `{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }`

**断言**：
- 返回 `protocolVersion: '2024-11-05'`
- `capabilities: { tools: {} }`
- `serverInfo.name: 'awf-session-mcp'`

---

### TC22: tools/list 返回 4 个 tools

**前置条件**：initialize 完成

**执行**：发送 `{ jsonrpc: '2.0', id: 2, method: 'tools/list' }`

**断言**：
- 返回 4 个 tool：
  - `awf_session_status`
  - `awf_capture_pane`
  - `awf_await_choice`
  - `awf_await_input`
- 每个 tool 包含 `name`, `description`, `inputSchema`

---

### TC23: 未知 method → -32601

**前置条件**：server 运行中

**执行**：发送 `{ jsonrpc: '2.0', id: 9, method: 'unknown/method' }`

**断言**：
- 返回 `error: { code: -32601, message: 'method not found: unknown/method' }`

---

## Mock 策略

| 模块 | 方式 | 说明 |
|------|------|------|
| tmux.cjs: `execFileSync` | `vi.mock('child_process')` | 控制返回值/异常、验证 args |
| awf-session: `execSync` | `vi.mock('child_process')` | 控制 capturePane 返回 |
| awf-session: `httpGet/httpPost` | 直接 mock 或启动测试 server | 控制 HTTP 响应 |
| awf-session: stdin/stdout | 直接调用 handlers 对象 | 绕过 JSON-RPC 传输层测试 handler 逻辑 |
| 环境变量 | `vi.stubEnv` / 直接设置 | 测试 CC_SESSION 和 AWF_BASE |
