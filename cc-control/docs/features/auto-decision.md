# 自动决策模块（会话决策中继 + 多 agent 上抛）— 功能文档

> 源码文件：`src/lib/session/client.js`（autoSelect / waitForReady）+ `src/cli/run.js`（handleDecision / observeRun 中继）+ `src/server/server.cjs`（`/choice` `/ask` `/respond` `/status` 路由 + `decisionPending` 槽 + needs-input 日志）+ `src/server/batch-transport.cjs`（多 agent 决策挂起/上抛探测，宿主侧） + `src/server/interact.cjs`（决策对象构造/校验）
> 关联：**AI 自决（决策门阀）**见 `docs/features/decision-system.md`；本文件覆盖「人工上抛 / 自动选择」的会话内决策中继链路与多 agent `NEEDS_INPUT` 上抛。

---

## 定位（与决策门阀的分工）

本项目存在两条**应互斥、当前共存**的决策链（见 `.awf/bugs/decision-entry-two-generations.md`、T1-106）：

| 链 | 谁做决定 | 主文档 |
|---|---|---|
| **A. 人工上抛 / 自动选择**（本文件） | 上抛到 CLI/页面，由人拍板（或 CLI `autoSelect` 兜底） | 本文件 |
| **B. AI 自决（决策门阀 / DC）** | AI 基于上下文自决，产出 Decision Result | `docs/features/decision-system.md` |

- 开关 `run.decision.enabled`（缺省 **false**，`src/lib/decision-config.cjs`）：**false = 走本文件链路**（`AskUserQuestion` → `decisionPending` → CLI `handleDecision`/`autoSelect`）；**true = 走决策门阀**（`AskUserQuestion` 被 deny 并转 DC，见 decision-system）。
- **旧入口停用（资产层，2026-09-10）**：`awf_await_choice` / `awf_await_input` 的方案文档 `plugin/core/skills/awf-run-decision/SKILL.md` 已标停用，`awf init` 不再注入相关 `CLAUDE.md` 模板，提示词改输出 `<AWF_DECISION_REQUIRED>`。**代码现状**：MCP 工具、`/choice` `/ask` `/respond` 端点与 CLI 中继仍在（T1-106 互斥化 pending/暂缓），只是当前提示词资产不再驱动它。
- **多 agent `NEEDS_INPUT` 上抛（§5）仍在使用**：子 Agent 是后台执行单元，禁止交互工具，遇真需用户决策时以 `NEEDS_INPUT` 上抛，由主 Agent 原生 `AskUserQuestion` 透传 —— 该路径独立于开关，不属旧入口停用范围。

---

## 架构概述

自动决策模块实现 AI 提问 → CLI 自动回答的闭环，避免人工等待。

```
AI (Claude Code)                  Session Server               CLI (awf run)
     │                                │                          │
     │  PreToolUse: AskUserQuestion   │                          │
     ├───────────────────────────────►│                          │
     │                                │  setDecision(...)        │
     │                                │  decisionPending = {...} │
     │                                │                          │
     │                                │  GET /status             │
     │                                │◄─────────────────────────┤
     │                                │  { decisionPending }     │
     │                                ├─────────────────────────►│
     │                                │                          │  handleDecision()
     │                                │                          │  → autoSelect()
     │                                │                          │  → POST /respond
     │                                │  POST /respond           │
     │                                │◄─────────────────────────┤
     │                                │  submit(value)           │
     │                                │  → tmux sendText+Enter   │
     │                                │                          │
     │  PostToolUse: answered         │                          │
     ├───────────────────────────────►│                          │
     │                                │  setDecision({answered}) │
```

> 上图是**单 agent 自动决策闭环**（主会话 AskUserQuestion → PreToolUse 捕获 → CLI autoSelect 兜底）。
> **多 agent 滑动窗口**的决策上抛链路（NEEDS_INPUT 协议 → server 日志 → CLI 挂起暂停补位 → 主 Agent 透传提问）见 §5。

---

## 1. autoSelect（src/lib/session/client.js）

### 功能描述

纯决策逻辑，5 秒超时后自动选择第一项。不依赖 tmux 或 server。

### 函数

| 函数 | 说明 |
|------|------|
| `autoSelect(decision)` | 接收 decision 对象，5s 后返回选择方案 |

### decision 输入

```js
{
  multiSelect: boolean,    // 是否多选
  options: string[],       // 选项列表
  question: string,        // 问题文本
  header: string | null,   // 可选标题
}
```

### 返回值

| 场景 | 返回值 |
|------|--------|
| 多选 | `{ multiSelect: true, selected: [0], customInput: '' }` |
| 单选 | `{ index: 1, label: options[0] }` |

### 行为

- 等待 5 秒（`DEFAULT_TIMEOUT_MS = 5000`）
- 控制台输出倒计时提示
- 始终选第一项

---

## 2. Server 端 decision 状态机

### 状态字段

```js
let state = 'ready';           // 'ready' | 'busy'
let decisionPending = null;    // null | decision 对象
```

### 状态转换函数

| 函数 | 说明 |
|------|------|
| `setDecision(d)` | 设置 `decisionPending = d` |
| `clearDecision()` | 清空 `decisionPending = null` |
| `setReady()` | state → 'ready'，唤醒所有 waiters |
| `setBusy()` | state → 'busy' |
| `waitReady(timeout)` | 若 ready 立即返回 true，否则返回 Promise 等待唤醒或超时 |

### decision 对象结构

```js
{
  type: 'choice' | 'text' | 'multiSelect',
  question: string,
  options?: string[],       // choice 类型
  multiSelect?: boolean,     // AskUserQuestion
  header?: string,           // AskUserQuestion
  source?: 'AskUserQuestion', // 来源标识
  answer?: string,           // PostToolUse 后填入
  answered?: boolean,        // PostToolUse 后标记
  context?: string,          // 附加上下文
}
```

---

## 3. Server 路由详解

### /hook (POST) — Hook 事件处理

| event | 行为 |
|-------|------|
| `SessionStart` | `setReady()` + `logger.resetTranscript()` |
| `UserPromptSubmit` | `setBusy()` |
| `Stop` | gate 关：`clearDecision()` + `setReady()` + `logger.captureFromTranscript()`（gate 开：走决策门阀，见 decision-system） |
| `PreToolUse` + AskUserQuestion | gate 关：从 `body.tool_input.questions[0]` 提取问题/选项 → `setDecision()`（gate 开：deny 并转 DC） |
| `PostToolUse` + AskUserQuestion | 从 `body.tool_response` 提取 answer → 更新 `decisionPending.answer/answered` |

**PreToolUse 处理细节**：
- 只处理 `tool_name === 'AskUserQuestion'`
- 从 `tool_input.questions[0]` 提取：`question`, `multiSelect`, `options` (取 label)
- 设置 `source: 'AskUserQuestion'`

**PostToolUse 处理细节**：
- 解析 `tool_response` 多种格式：string → 直接使用；`{answers: {...}}` → join values；`{answer: ...}` → 直接用
- 仅当已有 matching `decisionPending` 时更新

### /choice (POST) — AI 通知需要选择

```json
// request
{ "question": "选择方案", "options": ["A", "B"], "context": "可选" }
// 验证: question 必须为非空 string
// 效果: setDecision({ type: 'choice', ... })
```

### /ask (POST) — AI 通知需要自由输入

```json
// request
{ "question": "请输入名称", "context": "可选" }
// 验证: question 必须为非空 string
// 效果: setDecision({ type: 'text', ... })
```

### /respond (POST) — CLI 回应决策

```json
// request
{ "value": "1" }
// 验证: value 必须为非空 string
```

**关键逻辑**：
1. 若 `decisionPending` 存在（AI 正在等待输入）→ **跳过** `waitReady`（否则死锁）
2. 若 `decisionPending` 不存在 → 正常 `waitReady`
3. `setBusy()` → 记录 `logChoice()` → `submit(value)`
4. fallback timer：有 decision 时 5 分钟恢复 ready，无 decision 时 1.5 秒

### /status (GET) — 暴露决策状态

```json
{
  "ok": true,
  "state": "busy",
  "session": true,
  "decisionPending": {
    "type": "choice",
    "question": "...",
    "options": ["A", "B"],
    "source": "AskUserQuestion"
  }
}
```

CLI 轮询此端点，发现 `decisionPending` 非空时调用 `handleDecision`。

---

## 4. 完整链路时序

```
1. AI 调用 AskUserQuestion tool
2. CC fires PreToolUse hook → POST /hook → setDecision(...)
3. CC fires PostToolUse hook → POST /hook → setDecision({answer, answered:true})
4.   (此时 decisionPending.answered=true，但 CC 仍在等待输入)
5. CLI poll GET /status → 发现 decisionPending ≠ null
6. CLI handleDecision → 如果 answered 则跳过（不重复发送）
7.   如果 !answered → autoSelect → POST /respond { value }
8. /respond handler: decisionPending 存在 → 跳过 waitReady → submit(value) → CC 收到
9. CC fires Stop → POST /hook → clearDecision + setReady
```
---

## 5. 多 agent 决策上抛（M5）

多 agent 滑动窗口（`run.agents.max > 1`）下，子 Agent（awf-worker）是后台执行单元，**禁止调用任何交互工具**（AskUserQuestion / awf_await_choice / awf_await_input）。遇真正需用户决策时，用 `NEEDS_INPUT` 输出协议上抛，由主 Agent 原生 AskUserQuestion 透传给用户，用户回答后恢复子 Agent。

> **宿主侧实现（v0.2.0）**：调度权在宿主（`src/server/run-host.cjs` `driveBatch`），派发/等待/挂起由 `src/server/batch-transport.cjs` 的 `dispatch` + `waitAnyDone(running)` 承担；`NEEDS_INPUT` 挂起探测在 `batch-transport.checkNeedsInput`（不再有 `src/cli/run-batch.js`）。

### 5.1 子 Agent 侧 — NEEDS_INPUT 输出协议

`plugin/core/agents/awf-worker.md` 定义子 Agent 输出协议：

- 禁止写 state（只能 `awf_read_state`）；禁止提问（不调 AskUserQuestion / awf_await_choice / awf_await_input）。
- 有歧义按最佳判断执行；真需用户决策时，**最后一行**输出：

```
NEEDS_INPUT: {"taskId": "<任务ID>", "question": "<问题>", "options": ["<选项>"], "context": "<背景>"}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskId` | string | 是 | 派发给该子 Agent 的任务 ID |
| `question` | string | 是 | 待决策问题 |
| `options` | string[] | 否 | 候选选项 |
| `context` | string | 否 | 附加上下文 |

与 RESULT 关键区别：**NEEDS_INPUT 不落账** —— 不写 state，任务状态保持等待；等决策解决后主 Agent 恢复该子 Agent 继续。

### 5.2 Server 侧 — 记录 needs-input 日志

`SubagentStop` hook（server.cjs）：

1. 优先解析 `last_assistant_message` 中的 NEEDS_INPUT（`parseSubagentNeedsInput`，正则 `/NEEDS_INPUT:\s*(\{[\s\S]*\})/`）。
2. 命中 → `logSubagentNeedsInput` 追加 `.awf/logs/subagent-needs-input.jsonl`：

```json
{"ts":"<ISO>","agentId":"<session_id>","taskId":"T2","question":"...","options":["A","B"],"context":null}
```

3. **不**走 `settleSubagent`（不写 state），任务保持原状态 —— 与 RESULT 落账互斥。
4. 未命中 NEEDS_INPUT → 才走 RESULT 落账 / 失败补发（既有逻辑）。

### 5.3 宿主侧 — checkNeedsInput 挂起 + 暂停补位

`src/server/batch-transport.cjs` `waitAnyDone(running)`（宿主 `run-host.driveBatch` 调用）：

- 维护 `lastNeedsTs`（已处理记录游标，`maxTsFromLog(needsPath)` 初始化）+ `pendingNeeds`（Set）。
- `checkNeedsInput()`：读 `needsPath`（`.awf/logs/subagent-needs-input.jsonl`），跳过 `ts <= lastNeedsTs` 的旧记录；新记录有 taskId → `pendingNeeds.add(taskId)`。
- 等待循环每轮：
  1. `decisionPending()` 取当前决策槽；
  2. `dp && !dp.answered` → 主 Agent 正在向用户提问（answered 前）→ 不补位、不计时（`lastChangeAt = now()`），continue；
  3. 推进探测：主会话 busy / 任务状态有变 / 子 Agent 事件有增，任一发生即重置无变化窗口；
  4. 检测 running 中 done/blocked；
  5. `checkNeedsInput()`；`suspended = pendingNeeds.size > 0` → 有未决 NEEDS_INPUT 且无任务结算 → 返回 `{ done, suspended:true }` → 调度器不再派发新任务；
  6. 否则补发失败记录（`resendPending`）→ 无变化超时检查 → sleep。

恢复：AskUserQuestion 结束（用户回答或 autoSelect 兜底）→ `dp.answered`/清空 → 下轮 `suspended` 解除 → 恢复补位。

### 5.4 主 Agent 侧 — AskUserQuestion 透传 + 子 Agent 恢复

1. 主 Agent 看到子 Agent 的 NEEDS_INPUT → 原生 AskUserQuestion 向用户提问。
2. PreToolUse hook 透传：`setDecision({type, multiSelect, question, options, header, source:'AskUserQuestion'})`。
3. 用户回答：
   - 原生 UI 回答 → PostToolUse hook → `dp.answered=true` → CLI 跳过 autoSelect；
   - 兜底：CLI `handleDecision` → `autoSelect`（5s 选第一项）→ `POST /respond`。
4. 主 Agent 拿到回答 → SendMessage 恢复子 Agent（附回答 + 继续指令）。
5. 子 Agent 继续执行 → 最后一行 RESULT → SubagentStop → `settleSubagent` 写 state → CLI 检测 done → 补位。

### 5.5 与单 agent 决策（autoSelect / awf_await_choice）的关系

| 维度 | 单 agent（runLoop） | 多 agent（runBatchLoop） |
|------|--------------------|--------------------------|
| 提问来源 | 主会话 AI 直接提问 | 子 Agent 用 NEEDS_INPUT 协议上抛 |
| 上抛方式 | AskUserQuestion（hook 捕获）或 awf_await_choice / awf_await_input（→ `/choice` `/ask`） | 主 Agent **用原生 AskUserQuestion**（PreToolUse hook 透传），**不用** awf_await_choice |
| Server 记录 | decisionPending（`/hook` PreToolUse 或 `/choice` `/ask` 置位） | decisionPending + `.awf/logs/subagent-needs-input.jsonl` |
| CLI/宿主处理 | CLI `handleDecision` → autoSelect / readline | 宿主 `batch-transport.checkNeedsInput` → `pendingNeeds` → `suspended` 暂停补位；CLI `handleDecision` → autoSelect 兜底 |
| 汇聚点 | decisionPending → `POST /respond` → tmux submit | 同左 |

两条链路最终都收敛到 `decisionPending → POST /respond → submit(value)`；区别在提问来源与宿主侧是否挂起补位。

### 5.6 完整链路时序

```
1. 子 Agent 遇决策 → 最后一行 NEEDS_INPUT → 结束回合（SubagentStop）
2. Server: parseSubagentNeedsInput → logSubagentNeedsInput → .awf/logs/subagent-needs-input.jsonl（不落账）
3. 宿主 batch-transport: checkNeedsInput() → pendingNeeds.add(taskId) → 挂起补位等主 Agent 提问
4. 主 Agent 看到 NEEDS_INPUT → 原生 AskUserQuestion → PreToolUse hook → setDecision(source:'AskUserQuestion')
5. CLI poll /status → dp && !dp.answered
   ├─ 用户原生 UI 回答 → PostToolUse → dp.answered=true → CLI 跳过 autoSelect
   └─ 兜底：handleDecision → autoSelect(5s 选第一项) → POST /respond → submit(value)
6. 主 Agent 提问中（dp && !dp.answered）→ 不补位、不计时；suspended = pendingNeeds.size>0 且有未结算任务 → 调度器暂停派发（决策解决后解除）
7. 主 Agent 拿到回答 → SendMessage 恢复子 Agent（附回答 + 继续指令）
8. 子 Agent 继续 → 最后一行 RESULT → SubagentStop → settleSubagent 写 state → CLI 检测 done → 补位
```

---

## 6. 依赖

### src/lib/session/client.js（autoSelect / waitForReady）

| 模块 | 用途 |
|------|------|
| 无外部依赖 | 纯函数，仅使用 `setTimeout` |

### server.cjs (decision 部分)

| 模块 | 用途 |
|------|------|
| `tmux.cjs` | submit 时 sendText + sendEnter |
| `run-logger.cjs` | logChoice 记录决策 |
| `src/server/interact.cjs` | `/choice` `/ask` 决策对象构造 + 校验（`validateDecisionRequest`） |
| `src/server/batch-transport.cjs` | 多 agent `NEEDS_INPUT` 挂起探测 + 暂停补位（宿主侧） |
| `node:http` | HTTP server |
