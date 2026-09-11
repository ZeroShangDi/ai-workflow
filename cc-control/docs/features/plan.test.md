# awf plan — 测试用例

> 对应功能文档：docs/features/plan.md
> 源码：`src/cli/plan.js`（+ `src/lib/plugin-bridge.js`、`src/adapters/interactive.cjs`）
> 测试文件：`tests/unit/plan.test.js`

## 测试场景总览

| # | 场景 | 类别 |
|---|------|------|
| 1 | 有 description：委托 adapter 带拼好的 prompt | 正常流程 |
| 2 | 无 description：`plan-default` 分支 | 正常流程 |
| 3 | `--resume`：`plan-resume` 分支 | 正常流程 |
| 4/5 | adapter resolve → `logger.success('规划会话结束')` | 进程生命周期 |
| 6 | adapter reject（code≠0）→ 抛错且不记录 success | 错误处理 |
| 7 | adapter error（claude 未安装）→ 抛错 | 错误处理 |
| 10 | 三种 prompt 分支分别委托 | 参数分支 |
| 11 | 委托 adapter 且传 cwd（claude 字面不在 CLI） | 参数传递 |

## 详细测试用例

### TC1: 有 description 正常执行

**前置条件**：`description = "搭建测试基础设施"`，`resume = false`

**执行**：`planCommand('搭建测试基础设施', { resume: false })`

**断言**：
- `mockLaunch` 收到的 `cwd` 为 `process.cwd()`
- `prompt` 包含 `/ai-workflow-code:w-plan 搭建测试基础设施`
- `logger.success` 被调用，参数为 `'规划会话结束'`

---

### TC2: 无 description 默认 prompt

**前置条件**：`description` 为 undefined，`resume = false`

**执行**：`planCommand(undefined, { resume: false })`

**断言**：`prompt` 包含 `/ai-workflow-code:w-plan 请开始需求规划`

---

### TC3: --resume 恢复流程

**前置条件**：`description = '任意文本'`（被忽略），`resume = true`

**执行**：`planCommand('任意文本', { resume: true })`

**断言**：`prompt` 包含 `--resume`

---

### TC4/5: adapter resolve → success 记录

**前置条件**：`launchDialog` resolve

**执行**：`planCommand('test', { resume: false })`

**断言**：`logger.success` 被调用且参数为 `'规划会话结束'`

---

### TC6: adapter reject（code≠0）→ 抛错

**前置条件**：`launchDialog` reject `new Error('claude 异常退出，code: 1')`

**执行**：`planCommand('test', { resume: false })`

**断言**：Promise reject（消息 `claude 异常退出，code: 1`）；`logger.success` **未**调用

---

### TC7: adapter error（claude 未安装）→ 抛错

**前置条件**：`launchDialog` reject `new Error('无法启动 claude: spawn claude ENOENT')`

**执行**：`planCommand('test', { resume: false })`

**断言**：Promise reject，消息包含 `无法启动 claude: spawn claude ENOENT`

---

### TC10: prompt 三种分支分别委托

**执行**：依次 `('需求描述',{resume:false})` / `(undefined,{resume:false})` / `('任意',{resume:true})`

**断言**：
- `mockLaunch` 调用 3 次
- 三次 prompt 分别含 `/ai-workflow-code:w-plan 需求描述`、`/ai-workflow-code:w-plan 请开始需求规划`、`--resume`

---

### TC11: 委托 adapter 且传 cwd

**执行**：`planCommand('test', { resume: false })`

**断言**：
- `arg.cwd === process.cwd()`；`typeof arg.prompt === 'string'`
- `--settings` / `--dangerously-skip-permissions` 等 claude 字面**不**出现在 CLI（见 interactive adapter）

---

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| `src/lib/ui/log.js` | `vi.mock` | `logger` 记录调用，供断言 |
| `src/lib/plugin-bridge.js` | `vi.mock` | `planEntry` 返回固定三种 prompt 文本（真实模板逻辑见 `plugin-bridge.test.js`） |
| `src/adapters/ports.cjs` | `vi.mock` | `interactive.launchDialog` → `mockLaunch`；接缝抬到端口契约层，谁都不直连 adapter 文件 |

> 说明：`launchDialog` 的真实实现（spawn `claude`、`--settings`/`--dangerously-skip-permissions`、code 判定）在 `src/adapters/interactive.cjs`，其契约由端口测试覆盖。TC1–TC11 只验证 plan 侧的编排与 prompt 分支。
