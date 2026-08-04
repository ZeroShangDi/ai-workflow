# 自动决策模块 — 需求文档

> 源码文件：`src/cli/auto-selector.js` + `src/server/server.cjs`（decision 相关路由）

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

---

## 1. auto-selector.js

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

## 5. 依赖

### auto-selector.js

| 模块 | 用途 |
|------|------|
| 无外部依赖 | 纯函数，仅使用 `setTimeout` |

### server.cjs (decision 部分)

| 模块 | 用途 |
|------|------|
| `tmux.cjs` | submit 时 sendText + sendEnter |
| `run-logger.cjs` | logChoice 记录决策 |
| `node:http` | HTTP server |
