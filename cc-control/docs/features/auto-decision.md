# 自动决策模块 — 需求文档

> 源码文件：`src/lib/session/client.js`（autoSelect / waitForReady）+ `src/cli/run.js`（handleDecision）+ `src/server/server.cjs`（decision 相关路由 + needs-input 日志）
> 多 agent 决策上抛另涉：`src/cli/run-batch.js`（checkNeedsInput 挂起）+ `plugin/core/agents/awf-worker.md`（NEEDS_INPUT 协议）→ 见 §5

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
| `Stop` | `clearDecision()` + `setReady()` + `logger.captureFromTranscript()` |
| `PreToolUse` + AskUserQuestion | 从 `body.tool_input.questions[0]` 提取问题/选项 → `setDecision()` |
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

### 5.3 CLI 侧 — checkNeedsInput 挂起 + 暂停补位

`src/cli/run-batch.js` `makeWaitAnyDone`：

- 维护 `lastNeedsTs`（已处理记录游标）+ `pendingNeeds`（Map&lt;taskId, true&gt;）。
- `checkNeedsInput()`：读 needs-input.jsonl，跳过 `ts <= lastNeedsTs` 的旧记录；新记录有 taskId → `pendingNeeds.set(taskId, true)`，告警「任务 X 需决策…暂停补位等待主 Agent 提问」。
- 等待循环每轮：
  1. `getStatus()` 取 `decisionPending`；
  2. `dp && !dp.answered` → `handleDecision(dp)` → continue（决策处理期间阻塞调度器 = 暂停补位，处理完恢复）；
  3. 检测 running 中 done/blocked；
  4. `checkNeedsInput()`；
  5. `suspended = pendingNeeds.size > 0 && !!dp && !dp.answered` → 有未决 NEEDS_INPUT 且主 Agent 正 AskUserQuestion → 返回 `{done, suspended}` → 调度器不再派发新任务；
  6. 否则补发失败记录（resendPending）→ 超时检查 → sleep。

恢复：AskUserQuestion 结束（用户回答或 autoSelect 兜底）→ dp.answered / 清空 → 下轮 `suspended` 解除 → 恢复补位。

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
| CLI 处理 | handleDecision → autoSelect / readline | checkNeedsInput → pendingNeeds → suspended 暂停补位；handleDecision → autoSelect 兜底 |
| 汇聚点 | decisionPending → `POST /respond` → tmux submit | 同左 |

两条链路最终都收敛到 `decisionPending → POST /respond → submit(value)`；区别在提问来源与 CLI 侧是否挂起补位。

### 5.6 完整链路时序

```
1. 子 Agent 遇决策 → 最后一行 NEEDS_INPUT → 结束回合（SubagentStop）
2. Server: parseSubagentNeedsInput → logSubagentNeedsInput → .awf/logs/subagent-needs-input.jsonl（不落账）
3. CLI: checkNeedsInput() → pendingNeeds.set(taskId, true) → 告警「暂停补位等待主 Agent 提问」
4. 主 Agent 看到 NEEDS_INPUT → 原生 AskUserQuestion → PreToolUse hook → setDecision(source:'AskUserQuestion')
5. CLI poll /status → dp && !dp.answered
   ├─ 用户原生 UI 回答 → PostToolUse → dp.answered=true → CLI 跳过 autoSelect
   └─ 兜底：handleDecision → autoSelect(5s 选第一项) → POST /respond → submit(value)
6. suspended = pendingNeeds.size>0 && dp && !dp.answered → 调度器暂停派发（决策解决后解除）
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
| `node:http` | HTTP server |
