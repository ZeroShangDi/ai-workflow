# 单次会话调用（oneshot） — 测试用例

> 对应功能文档：`docs/features/oneshot.md`
> 源码：`src/adapters/oneshot.cjs` + `plugin/core/mcp/awf-oneshot/server.cjs`
> 测试文件：`tests/unit/oneshot-adapter.test.js`（端口）、`tests/integration/awf-oneshot.test.js`（MCP 本地 spawn）、`tests/integration/awf-oneshot-server.test.js`（MCP→server）、`tests/unit/cc-adapters-smoke.test.js` / `tests/unit/ports-contract.test.js`（端口契约）

## 测试场景总览

### oneshot 端口（`oneshot-adapter.test.js`）— 4 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 1 | `claudePArgs`：`-p` + 额外 args + prompt | 参数验证 |
| 2 | `spawnClaudeP`：ok=true 收集 stdout/stderr；NO_COLOR + safe args | 正常 |
| 3 | `spawnClaudeP`：error/非零 → ok=false | 异常 |
| 4 | `runOneShot`：ok→text trimmed；非 ok→stderr 优先否则 exited | 正常/异常 |

### awf-oneshot MCP（`awf-oneshot.test.js`，本地 spawn）— 11 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 5 | initialize 握手 | 协议 |
| 6 | tools/list 返回 1 个 tool | 协议 |
| 7 | 正常执行 → ok + stdout（trim） | 正常 |
| 8 | 指定 cwd 参数（不传→process.cwd()） | 正常 |
| 9 | 非零退出码 → ok=false（resolve 而非 reject） | 异常 |
| 10 | error 事件（ENOENT）→ ok=false | 异常 |
| 11 | 5 分钟超时 → timeout=300000，close code≠0 | 异常 |
| 12 | 空 prompt → 校验失败，不 spawn | 边界 |
| 13 | env 含 NO_COLOR=1 且继承 process.env | 边界 |
| 14 | 未知 tool name → error | 异常 |
| 15 | `spawnClaude` 参数验证（cmd/args/stdio/timeout/env） | 参数 |

### awf-oneshot 经 server（`awf-oneshot-server.test.js`）— 1 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 16 | AWF_BASE 提供 → 走 server `/oneshot`（不本地 spawn） | 集成 |

### 端口契约（`cc-adapters-smoke.test.js` / `ports-contract.test.js`）— 相关断言

| # | 场景 | 类别 |
|---|------|------|
| 17 | 工厂绑定的 oneshot 是真实实现（`claudePArgs('hi')` → `['-p','hi']`） | 契约 |
| 18 | 契约声明的 oneshot 方法在端口对象上真实存在 | 契约 |
| 19 | 注入 spawn 的 `runOneShot` 返回 `{ok:true, text}` | 冒烟 |

---

## 详细测试用例

### TC1: `claudePArgs` 参数构造

**前置条件**：无
**执行**：`claudePArgs('p', { args: ['--safe-mode', '--no-session-persistence'] })` / `claudePArgs('p')`
**断言**：`['-p','--safe-mode','--no-session-persistence','p']` / `['-p','p']`

### TC2: `spawnClaudeP` ok 路径

**前置条件**：注入 `fakeSpawnOf({ code:0, stdout:'  hi  ', stderr:'warn' })`
**执行**：`spawnClaudeP({ prompt:'x', args:['--safe-mode'], spawn })`
**断言**：`r.ok===true`、`r.stdout==='  hi  '`、`r.code===0`；spawn 收到的 args `['-p','--safe-mode','x']`

### TC3: `spawnClaudeP` error / 非零

**前置条件**：`fakeSpawnOf({ code:null, error:'boom' })` 与 `{ code:1, stderr:'oops' }`
**执行**：`spawnClaudeP({ prompt:'x', spawn })`
**断言**：error → `{ok:false, error:'boom'}`；非零 → `ok:false`、`code:1`

### TC4: `runOneShot` 两分支

**前置条件**：`fakeSpawnOf({ code:0, stdout:'  hi  ' })` / `{code:1,stderr:'oops'}` / `{code:2}`
**执行**：`runOneShot({ prompt:'x', spawn })`
**断言**：`{ok:true, text:'hi'}`；error `'oops'`；无 stderr 时 `error` 含 `'claude -p exited 2'`

### TC5-TC6: MCP 协议（initialize / tools/list）

**前置条件**：import MCP server；`callRpc` 打桩 `process.stdout.write`
**执行**：`initialize` / `tools/list`
**断言**：`protocolVersion '2024-11-05'`、`capabilities {tools:{}}`、`serverInfo.name 'awf-oneshot-mcp'`；tools 长度 1、name `awf_oneshot`、`required ['prompt']`、properties 含 `prompt`/`cwd`

### TC7: 正常执行 → ok + stdout（trim）

**前置条件**：`global.__CC_SPAWN__` 注入 mock spawn；behavior `{stdout:'Hello World\n', closeCode:0}`
**执行**：`tools/call({ name:'awf_oneshot', arguments:{ prompt:'say hello' } })`
**断言**：`{ok:true, text:'Hello World'}`；`calls[0].cmd==='claude'`、`calls[0].args===['-p','say hello']`

### TC8: cwd 参数

**执行**：`awf_oneshot({ prompt:'ls', cwd:'/tmp' })` / 不传 cwd
**断言**：`options.cwd==='/tmp'` / `options.cwd===process.cwd()`

### TC9: 非零退出码

**前置条件**：`{stdout:'Error: something\n', closeCode:1}`
**断言**：`ok:false`、`error:'claude -p exited 1'`、`text:'Error: something'`（resolve 不 reject）

### TC10: error 事件（ENOENT）

**前置条件**：`{error: new Error('spawn claude ENOENT')}`
**断言**：`{ok:false, error:'spawn claude ENOENT'}`

### TC11: 5 分钟超时

**前置条件**：`{stdout:'', closeCode:null}`（SIGTERM 后 close null）
**断言**：`calls[0].options.timeout===300000`、`ok:false`、`error:'claude -p exited null'`

### TC12: 空 prompt → 不 spawn

**执行**：`awf_oneshot({})`
**断言**：`{ok:false, error:'prompt is required'}`、`mockSpawn.calls` 为空

### TC13: NO_COLOR + 继承 env

**前置条件**：`process.env.CC_TEST_MARKER='marker-value'`
**断言**：`options.env.NO_COLOR==='1'`、`options.env.CC_TEST_MARKER==='marker-value'`

### TC14: 未知 tool name

**断言**：`{ok:false, error:'unknown tool: unknown_tool'}`

### TC15: `spawnClaude` 参数验证

**执行**：`mod.spawnClaude('test prompt', '/custom/cwd')`
**断言**：`cmd 'claude'`、`args ['-p','test prompt']`、`cwd '/custom/cwd'`、`stdio ['pipe','pipe','pipe']`、`timeout 300000`、`env.NO_COLOR '1'`

### TC16: 经 server `/oneshot`

**前置条件**：mock HTTP server（记录 `hits`），`process.env.AWF_BASE=base`
**执行**：`awf_oneshot({ prompt:'你好' })`
**断言**：`parsed.ok===true`、`parsed.text==='server-oneshot-ok'`（来自 server 非本地 spawn）、`hits[0].url==='/oneshot'`、`hits[0].body.prompt==='你好'`

### TC17-TC19: 端口契约 / 冒烟

**断言**：`createCcAdapters().oneshot.claudePArgs('hi')` 为 `['-p','hi']`；契约声明的 `runOneShot`/`spawnClaudeP`/`claudePArgs` 在端口对象上均为 function；注入 spawn 的 `runOneShot` 返回 `{ok:true, text:'hi'}`

---

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| `child_process.spawn`（端口） | 注入 `spawn` 参数 | `fakeSpawnOf` 返回可驱动 `close`/`error`/`stdout.data` 的 EventEmitter |
| `child_process.spawn`（MCP） | 注入 `global.__CC_SPAWN__` | MCP 为原生 CJS，`vi.mock` 拦截不到，用显式注入钩子 |
| HTTP（MCP→server） | 启动真实 mock `http` server | 记录请求 url/body，返回 canned JSON |
| `AWF_BASE` | `process.env` 设置/`vi.stubEnv` | 决定档 1（server）或档 2/3（本地 spawn）|
| JSON-RPC 传输 | 直接调 `handlers` / `mod.spawnClaude` | 绕过 stdio；`handleMessage` 用 `process.stdout.write` 打桩 |
| `process.cwd()` | 不 mock | 用真实 cwd，或经 `cwd` 参数覆盖 |
