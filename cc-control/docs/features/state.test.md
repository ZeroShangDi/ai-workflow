# State 管理模块 — 测试用例文档

> 对应需求文档：`docs/features/state.md`
> 源码文件：`src/cli/state.js` + `src/mcp/awf-state/server.cjs`
> 测试文件：`tests/unit/state.test.js` + `tests/integration/awf-state.test.js`

---

## 测试场景总览

### CLI 侧 (state.js) — 10 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 1 | loadState: 正常读取 | 正常 |
| 2 | loadState: 文件不存在返回 null | 正常 |
| 3 | loadState: 非法 JSON 返回 null | 正常 |
| 4 | saveState: 正常写入（含目录创建） | 正常 |
| 5 | findNextTask: 返回首个 pending 无 deps 任务 | 正常 |
| 6 | findNextTask: deps 未满足时跳过 | 依赖 |
| 7 | findNextTask: deps 全满足时返回 | 依赖 |
| 8 | findNextTask: 全部 done 返回 null | 边界 |
| 9 | findNextTask: tasks 在根级 | 边界 |
| 10 | isMilestoneDone: 全 done vs 部分 pending | 边界 |

### MCP 侧 (server.cjs) — 22 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 11 | awf_read_state 正常 | 正常 |
| 12 | awf_task_status: 正常更新 | 正常 |
| 13 | awf_task_status: id 不存在 | 异常 |
| 14 | awf_task_result: 写入 result + files | 正常 |
| 15 | awf_task_commit: 追加 commit 记录 | 正常 |
| 16 | awf_task_create: 正常创建 | 正常 |
| 17 | awf_task_create: id 重复 | 异常 |
| 18 | awf_task_update: 部分字段更新 | 正常 |
| 19 | awf_task_delete: 正常删除 | 正常 |
| 20 | awf_plan_configure: 配置所有元数据 | 正常 |
| 21 | awf_wbs_create/update/delete 正常链路 | 正常 |
| 22 | awf_wbs_create: id 重复 | 异常 |
| 23 | awf_phase: 正常设置 | 正常 |
| 24 | awf_mode: 正常设置 | 正常 |
| 25 | awf_version: 正常设置 | 正常 |
| 26 | awf_milestone_create/update/delete 正常链路 | 正常 |
| 27 | JSON-RPC initialize 协议握手 | 协议 |
| 28 | JSON-RPC tools/list 返回 17 个 tools | 协议 |
| 29 | 未知 tool name → error | 异常 |
| 30 | 未知 method → -32601 | 协议 |
| 31 | state.json 不存在时 readState 抛异常 | 异常 |
| 32 | tasks 在根级：getTasks 取 tasks / 空 | 边界 |

---

## 详细测试用例

### TC1: loadState — 正常读取

**前置条件**：`.awf/state.json` 存在，内容为合法 JSON

**执行**：`loadState(tempDir)`

**断言**：
- 返回解析后的对象
- 包含 `mode`、`version`、`tasks` 等字段

---

### TC2: loadState — 文件不存在返回 null

**前置条件**：`.awf/state.json` 不存在

**执行**：`loadState(tempDir)`

**断言**：
- 返回 `null`
- 不抛出异常

---

### TC3: loadState — 非法 JSON 返回 null

**前置条件**：`.awf/state.json` 内容为 `{invalid json`

**执行**：`loadState(tempDir)`

**断言**：
- 返回 `null`
- `JSON.parse` 异常被 catch

---

### TC4: saveState — 正常写入

**前置条件**：`.awf/` 目录不存在

**执行**：`saveState(tempDir, { mode: 'idle', version: '0.1.0' })`

**断言**：
- `.awf/` 目录被创建
- `state.json` 被写入
- `lastUpdated` 字段被自动添加（当前 ISO 时间戳）
- 内容为格式化 JSON（2 空格缩进）

---

### TC5: findNextTask — 返回首个 pending 无 deps 任务

**前置条件**：tasks = [{id:'T1', status:'done'}, {id:'T2', status:'pending', deps:[]}, {id:'T3', status:'pending'}]

**执行**：`findNextTask(state)`

**断言**：
- 返回 T2（首个 pending）
- 不返回 T1（done）
- T3 排在 T2 后面，不被返回

---

### TC6: findNextTask — deps 未满足时跳过

**前置条件**：tasks = [{id:'T1', status:'pending'}, {id:'T2', status:'pending', deps:['T1']}]

**执行**：`findNextTask(state)`

**断言**：
- 返回 T1（无 deps）
- T2 被跳过（dep T1 不是 done）

---

### TC7: findNextTask — deps 全满足时返回

**前置条件**：tasks = [{id:'T1', status:'done'}, {id:'T2', status:'pending', deps:['T1']}]

**执行**：`findNextTask(state)`

**断言**：
- 返回 T2（dep T1 已完成）

---

### TC8: findNextTask — 全部 done 返回 null

**前置条件**：tasks = [{id:'T1', status:'done'}, {id:'T2', status:'done'}]

**执行**：`findNextTask(state)`

**断言**：
- 返回 `null`

---

### TC9: findNextTask — tasks 在根级

**前置条件 A**：`state.tasks = [{id:'T1', status:'pending'}]`

**执行 A**：返回 T1

**前置条件 B**：无 `state.tasks`

**执行 B**：返回 `null`

---

### TC10: isMilestoneDone

**前置条件 A**：所有 tasks status=done，tasks.length=3

**执行 A**：返回 true

**前置条件 B**：部分 done，部分 pending

**执行 B**：返回 false

**前置条件 C**：tasks 为空数组

**执行 C**：返回 false（length=0 条件）

---

### TC11: awf_read_state 正常

**前置条件**：state.json 存在且合法

**执行**：`tools/call({ name: 'awf_read_state', arguments: {} })`

**断言**：
- 返回 textResult 包含完整 state 对象
- state 不被修改

---

### TC12: awf_task_status — 正常更新

**前置条件**：state 有 T1 status=pending

**执行**：`awf_task_status({ id: 'T1', status: 'active' })`

**断言**：
- `state.tasks[0].status` 变为 `'active'`
- `lastUpdated` 更新
- 返回 `{ ok: true, tool: 'awf_task_status' }`

---

### TC13: awf_task_status — id 不存在

**前置条件**：state 无 T99

**执行**：`awf_task_status({ id: 'T99', status: 'active' })`

**断言**：
- 返回 `{ ok: false, error: 'task T99 not found' }`
- state 不变

---

### TC14: awf_task_result — 写入 result + files

**前置条件**：T1 已存在

**执行**：`awf_task_result({ id: 'T1', result: '完成', files: ['a.js', 'b.js'] })`

**断言**：
- `T1.exec.result` = `'完成'`
- `T1.exec.files` = `['a.js', 'b.js']`

---

### TC15: awf_task_commit — 追加 commit 记录

**前置条件**：T1 已存在，无 commits

**执行**：`awf_task_commit({ id: 'T1', hash: 'abc1234', message: 'feat: add x' })`

**断言**：
- `T1.commits` = `[{ hash: 'abc1234', message: 'feat: add x' }]`
- 再次调用：追加第二条记录

---

### TC16: awf_task_create — 正常创建

**前置条件**：tasks 中无 T3

**执行**：`awf_task_create({ id: 'T3', title: '新任务', prompt: '做某事' })`

**断言**：
- `tasks` 新增 T3，status='pending'，deps=[]
- 返回 `{ ok: true, tool: 'awf_task_create' }`

---

### TC17: awf_task_create — id 重复

**前置条件**：T1 已存在

**执行**：`awf_task_create({ id: 'T1', title: '重复', prompt: '...' })`

**断言**：
- 返回 `{ ok: false, error: 'task T1 already exists' }`
- state 不变

---

### TC18: awf_task_update — 部分字段更新

**前置条件**：T1 已存在，title='old', prompt='old'

**执行**：`awf_task_update({ id: 'T1', title: 'new title' })`

**断言**：
- `T1.title` = `'new title'`
- `T1.prompt` 保持 `'old'`（未传不更新）

---

### TC19: awf_task_delete — 正常删除

**前置条件**：tasks = [T1, T2, T3]

**执行**：`awf_task_delete({ id: 'T2' })`

**断言**：
- tasks 变为 [T1, T3]
- 返回 `{ ok: true }`

---

### TC20: awf_plan_configure — 配置元数据

**前置条件**：state.plan 不存在或为空

**执行**：`awf_plan_configure({ summary: '摘要', hasUI: true, inScope: ['A'], outOfScope: ['B'], acceptanceCriteria: ['C1'] })`

**断言**：
- `state.plan.summary` = `'摘要'`
- `state.plan.hasUI` = `true`
- `state.plan.inScope` = `['A']`
- `state.plan.outOfScope` = `['B']`
- `state.plan.acceptanceCriteria` = `['C1']`

---

### TC21: awf_wbs_create/update/delete 正常链路

**前置条件**：wbs 为空

**执行**：
1. `awf_wbs_create({ id: 'W1', name: '模块1', desc: '...' })` → ok
2. `awf_wbs_update({ id: 'W1', name: '模块1-改' })` → name 变更
3. `awf_wbs_delete({ id: 'W1' })` → wbs 空

**断言**：每步都返回 ok，state 正确变更

---

### TC22: awf_wbs_create — id 重复

**前置条件**：wbs 中已有 W1

**执行**：`awf_wbs_create({ id: 'W1', name: '重复' })`

**断言**：
- 返回 `{ ok: false, error: 'wbs W1 already exists' }`

---

### TC23: awf_phase — 正常设置

**前置条件**：state.currentState = 'IDLE'

**执行**：`awf_phase({ phase: 'CODE' })`

**断言**：
- `state.currentState` = `'CODE'`
- 返回 ok

---

### TC24: awf_mode — 正常设置

**前置条件**：state.mode = 'idle'

**执行**：`awf_mode({ mode: 'run' })`

**断言**：
- `state.mode` = `'run'`

---

### TC25: awf_version — 正常设置

**前置条件**：state.version = '0.1.0'

**执行**：`awf_version({ version: '0.2.0' })`

**断言**：
- `state.version` = `'0.2.0'`

---

### TC26: awf_milestone_create/update/delete 正常链路

**前置条件**：milestones 为空

**执行**：
1. `awf_milestone_create({ id: 'M1', desc: '里程碑1', tasks: ['T1'] })` → ok, status='active'
2. `awf_milestone_update({ id: 'M1', status: 'done' })` → ok
3. `awf_milestone_delete({ id: 'M1' })` → ok

**断言**：每步正确变更

---

### TC27: JSON-RPC initialize 协议握手

**前置条件**：server 启动

**执行**：发送 `{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }`

**断言**：
- 返回 `protocolVersion: '2024-11-05'`
- 返回 `capabilities: { tools: {} }`
- 返回 `serverInfo: { name: 'awf-state-mcp', version: '1.0.0' }`

---

### TC28: JSON-RPC tools/list

**前置条件**：initialize 完成

**执行**：发送 `{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }`

**断言**：
- 返回 `tools` 数组，包含 17 个 tool
- 每个 tool 有 `name`, `description`, `inputSchema`

---

### TC29: 未知 tool name → error

**前置条件**：state 正常

**执行**：`tools/call({ name: 'awf_nonexistent', arguments: {} })`

**断言**：
- 返回 `{ ok: false, error: 'unknown tool: awf_nonexistent' }`

---

### TC30: 未知 method → -32601

**前置条件**：server 运行中

**执行**：发送 `{ jsonrpc: '2.0', id: 9, method: 'unknown/method', params: {} }`

**断言**：
- 返回 `error: { code: -32601, message: 'method not found: unknown/method' }`

---

### TC31: state.json 不存在时 readState 抛异常

**前置条件**：`.awf/state.json` 不存在

**执行**：`awf_task_status({ id: 'T1', status: 'done' })`

**断言**：
- `readState()` 抛异常 → catch 返回 `{ ok: false, error: 'ENOENT: ...' }`

---

### TC32: tasks 在根级：getTasks 取 tasks / 空

**前置条件 A**：`state = { tasks: [{id:'T2'}] }`

**执行**：`awf_task_status({ id: 'T2', status: 'done' })`

**断言**：
- 找到 T2 在根级 tasks 中，status 变为 done

**前置条件 B**：`state = {}`（无 tasks）

**执行**：`awf_task_create(...)`

**断言**：
- `ensureTasks()` 创建根级 `state.tasks = []`
- 任务写入根级 tasks

---

## Mock 策略

| 模块 | 方式 | 说明 |
|------|------|------|
| CLI: `node:fs` | 真实 fs + 临时目录 | `fs.mkdtempSync()` 创建隔离环境 |
| MCP: `node:fs` | `vi.mock('fs')` 或真实临时文件 | 控制 state.json 内容 |
| MCP: stdin/stdout | 直接调用 `handlers` 对象 | 绕过 JSON-RPC 传输层，测试 handler 逻辑 |
| MCP 集成 | spawn 子进程 + stdio | 测试完整协议交互 |
