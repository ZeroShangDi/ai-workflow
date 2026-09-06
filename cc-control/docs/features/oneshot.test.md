# 单次会话调用模块 — 测试用例文档

> 对应需求文档：`docs/features/oneshot.md`
> 源码文件：`plugin/core/mcp/awf-oneshot/server.cjs`
> 测试文件：`tests/integration/awf-oneshot.test.js`

---

## 测试场景总览

### MCP 协议 — 2 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 1 | initialize 握手 | 协议 |
| 2 | tools/list 返回 1 个 tool | 协议 |

### awf_oneshot 执行 — 5 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 3 | 正常执行 → ok + stdout | 正常 |
| 4 | 指定 cwd 参数 | 正常 |
| 5 | 非零退出码 → ok=false | 异常 |
| 6 | error 事件（claude 未安装） | 异常 |
| 7 | 5 分钟超时 → SIGTERM | 异常 |

### 边界 — 4 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 8 | 空 prompt → 参数校验失败 | 边界 |
| 9 | stdout 包含 ANSI 颜色（NO_COLOR 验证） | 边界 |
| 10 | 未知 tool name → error | 异常 |
| 11 | spawn 参数验证 | 参数 |

---

## 详细测试用例

### TC1: initialize 握手

**前置条件**：server 启动

**执行**：发送 `{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }`

**断言**：
- `protocolVersion: '2024-11-05'`
- `capabilities: { tools: {} }`
- `serverInfo.name: 'awf-oneshot-mcp'`

---

### TC2: tools/list 返回 1 个 tool

**前置条件**：initialize 完成

**执行**：发送 `{ jsonrpc: '2.0', id: 2, method: 'tools/list' }`

**断言**：
- tools 数组长度为 1
- tool name = `'awf_oneshot'`
- inputSchema.required = `['prompt']`
- inputSchema.properties 包含 `prompt` 和 `cwd`

---

### TC3: 正常执行 → ok + stdout

**前置条件**：mock spawn 返回正常进程，stdout 输出 `"Hello World\n"`，close code=0

**执行**：`tools/call({ name: 'awf_oneshot', arguments: { prompt: 'say hello' } })`

**断言**：
- `spawn('claude', ['-p', 'say hello'], ...)` 被调用
- stdout 累积后 trim = `'Hello World'`
- 返回 `{ ok: true, text: 'Hello World' }`

---

### TC4: 指定 cwd 参数

**前置条件**：mock spawn

**执行**：`tools/call({ name: 'awf_oneshot', arguments: { prompt: 'ls', cwd: '/tmp' } })`

**断言**：
- spawn options 中 `cwd: '/tmp'`
- 不传 cwd 时使用 `process.cwd()`

---

### TC5: 非零退出码 → ok=false

**前置条件**：mock spawn close code=1，stdout 输出 `"Error: ...\n"`

**执行**：`tools/call({ name: 'awf_oneshot', arguments: { prompt: 'bad command' } })`

**断言**：
- 返回 `{ ok: false, error: 'claude -p exited 1', text: 'Error: ...' }`
- 不抛异常（resolve 而非 reject）

---

### TC6: error 事件（claude 未安装）→ ok=false

**前置条件**：mock spawn 触发 error 事件（ENOENT）

**执行**：`tools/call({ name: 'awf_oneshot', arguments: { prompt: 'test' } })`

**断言**：
- `proc.on('error')` 触发
- 返回 `{ ok: false, error: 'spawn claude ENOENT' }`
- 不抛异常

---

### TC7: 5 分钟超时 → SIGTERM → close code≠0

**前置条件**：mock spawn 设置 timeout=300000，超时后进程被 SIGTERM，close code=null 或 143

**执行**：执行 prompt，触发 5 分钟超时

**断言**：
- spawn options 中 `timeout: 300000`（5 分钟）
- 超时后 SIGTERM → close 事件触发
- 返回 `{ ok: false, error: 'claude -p exited {code}' }`

---

### TC8: 空 prompt → 参数校验失败

**前置条件**：`required: ['prompt']` 配置

**执行**：`tools/call({ name: 'awf_oneshot', arguments: {} })`

**断言**：
- MCP 协议层或 handler 应校验 prompt 存在性
- handler 中 `args.prompt` 为 undefined
- `spawn('claude', ['-p', undefined], ...)` 的 prompt 参数为 undefined
- 或由 MCP client 在调用前校验 inputSchema.required

---

### TC9: NO_COLOR 环境变量验证

**前置条件**：mock spawn

**执行**：检查 spawn options 中的 env

**断言**：
- `env` 包含 `NO_COLOR: '1'`
- `env` 使用 `...process.env` 继承当前环境

---

### TC10: 未知 tool name → error

**前置条件**：无

**执行**：`tools/call({ name: 'unknown_tool' })`

**断言**：
- 返回 `{ ok: false, error: 'unknown tool: unknown_tool' }`

---

### TC11: spawn 参数验证

**前置条件**：mock spawn，验证调用参数

**执行**：`spawnClaude('test prompt', '/custom/cwd')`

**断言**：
- 第一个参数：`'claude'`
- 第二个参数：`['-p', 'test prompt']`
- options.cwd：`'/custom/cwd'`
- options.stdio：`['pipe', 'pipe', 'pipe']`
- options.timeout：`300000`
- options.env.NO_COLOR：`'1'`

---

## Mock 策略

| 模块 | 方式 | 说明 |
|------|------|------|
| `child_process.spawn` | `vi.mock` | 返回可控 proc 对象，控制 stdout data/close/error 事件 |
| JSON-RPC 传输 | 直接调用 handlers 对象 | 绕过 stdio，测试 handler 逻辑 |
| process.cwd | 不 mock | 使用真实 cwd，或通过 cwd 参数覆盖 |
