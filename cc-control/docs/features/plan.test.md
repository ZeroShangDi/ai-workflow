# awf plan — 测试用例文档

> 对应需求文档：`docs/features/plan.md`
> 源码文件：`src/cli/plan.js`
> 测试文件：`tests/unit/plan.test.js`

---

## 测试场景总览

| # | 场景 | 类别 |
|---|------|------|
| 1 | 有 description 正常执行 | 正常流程 |
| 2 | 无 description 默认 prompt | 正常流程 |
| 3 | --resume 恢复流程 | 正常流程 |
| 4 | spawn 正常退出 code=0 | 进程生命周期 |
| 5 | spawn 正常退出 code=null | 进程生命周期 |
| 6 | spawn 异常退出 code≠0 | 错误处理 |
| 7 | spawn error 事件（claude 未安装） | 错误处理 |
| 8 | state.json 版本号写入 | state 操作 |
| 9 | state.json 不存在时 loadState 返回 null | state 操作 |
| 10 | prompt 参数验证：有/无/resume 三种分支 | 参数分支 |
| 11 | spawn args 验证 | 参数传递 |

---

## 详细测试用例

### TC1: 有 description 正常执行

**前置条件**：`description = "搭建测试基础设施"`，`--resume` 为 false，`.awf/state.json` 存在

**执行**：`planCommand("搭建测试基础设施", { resume: false })`

**断言**：
- `promptVersion(cwd)` 被调用一次
- `loadState(cwd)` 被调用一次
- `saveState` 被调用，state.version 被设置为所选版本号
- `logger.info` 输出 "版本: …"
- `spawn` 被调用，args 为 `['--settings', ..., '--dangerously-skip-permissions', '/ai-workflow-code:w-plan 搭建测试基础设施']`
- `stdio` 为 `'inherit'`，`cwd` 为 `process.cwd()`
- spawn 的 proc 监听 `close` 和 `error` 事件
- code=0 时 `logger.success('规划会话结束')` 被调用

---

### TC2: 无 description 默认 prompt

**前置条件**：`description` 为 undefined 或空字符串，`--resume` 为 false

**执行**：`planCommand(undefined, { resume: false })`

**断言**：
- spawn prompt 为 `/ai-workflow-code:w-plan 请开始需求规划`
- 其余流程同 TC1

---

### TC3: --resume 恢复流程

**前置条件**：`description = "任意文本"`（被忽略），`--resume` 为 true

**执行**：`planCommand("任意文本", { resume: true })`

**断言**：
- `--resume` 优先于 `description`：spawn prompt 为 `/ai-workflow-code:w-plan --resume 请恢复上次规划会话，继续对齐需求`
- `promptVersion` 和 `saveState` 仍正常执行

---

### TC4: spawn 正常退出 code=0

**前置条件**：spawn 返回的 proc 触发 `close` 事件，code=0

**执行**：`planCommand(...)` 并触发 close(0)

**断言**：
- Promise resolve
- `logger.success('规划会话结束')` 被调用
- 不抛出异常

---

### TC5: spawn 正常退出 code=null

**前置条件**：spawn 返回的 proc 触发 `close` 事件，code=null（信号终止但正常）

**执行**：`planCommand(...)` 并触发 close(null)

**断言**：
- Promise resolve（因为 `code === 0 || code === null`）
- `logger.success` 被调用

---

### TC6: spawn 异常退出 code≠0

**前置条件**：spawn 返回的 proc 触发 `close` 事件，code=1

**执行**：`planCommand(...)` 并触发 close(1)

**断言**：
- Promise reject，错误消息为 `"claude 异常退出，code: 1"`
- `logger.success` 不被调用

---

### TC7: spawn error 事件（claude 未安装）

**前置条件**：`spawn('claude', ...)` 触发 `error` 事件（ENOENT——claude 不在 PATH 中）

**执行**：`planCommand(...)` 并触发 error(new Error('spawn claude ENOENT'))

**断言**：
- Promise reject，错误消息包含 `"无法启动 claude: spawn claude ENOENT"`
- `close` 事件不再触发后续逻辑

---

### TC8: state.json 版本号写入

**前置条件**：`.awf/state.json` 存在，version 为 `"0.1.0"`，用户选择版本 `"0.2.0"`

**执行**：`planCommand(...)`

**断言**：
- `loadState` 返回原 state 对象
- `saveState` 被调用，state.version 更新为 `"0.2.0"`
- `state.lastUpdated` 被更新为当前 ISO 时间戳

---

### TC9: state.json 不存在时 loadState 返回 null

**前置条件**：`.awf/state.json` 不存在

**执行**：`loadState(cwd)`

**断言**：
- 返回 `null`（不抛出异常）
- `planCommand` 中 `loadState(cwd) || {}` 降级为空对象
- `saveState` 创建 `.awf/` 目录和 `state.json`

---

### TC10: prompt 参数三种分支验证

**前置条件**：无需 mock 文件系统，仅验证分支逻辑

**执行**：分别传入 `("需求", {})`、`(undefined, {})`、`("任意", { resume: true })`

**断言**：

| 输入 | 预期 prompt |
|------|------------|
| `("需求", {})` | `/ai-workflow-code:w-plan 需求` |
| `(undefined, {})` | `/ai-workflow-code:w-plan 请开始需求规划` |
| `("任意", { resume: true })` | `/ai-workflow-code:w-plan --resume 请恢复上次规划会话，继续对齐需求` |

---

### TC11: spawn args 验证

**前置条件**：完整 mock `spawn`、`promptVersion`、`loadState`、`saveState`

**执行**：`planCommand("test", { resume: false })`

**断言**：
- `spawn` 第一个参数为 `'claude'`
- `spawn` 第二个参数（args 数组）包含：
  - `'--settings'` + `paths.ccSettings`
  - `'--dangerously-skip-permissions'`
  - prompt 字符串
- `spawn` 第三个参数（options）包含：
  - `stdio: 'inherit'`
  - `cwd: process.cwd()`

---

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| `node:child_process.spawn` | `vi.mock` + 可控 proc 对象 | 控制 close/error 事件触发，验证 args |
| `./paths.js` | `vi.mock` | 返回固定配置路径 |
| `./logger.js` | `vi.mock` | 静默输出 + 记录调用参数用于断言 |
| `./version-prompt.js` | `vi.mock` | 返回固定版本号 `"0.1.0"` |
| `./state.js` | `vi.mock` | `loadState` 返回预设对象，`saveState` 记录调用 |
