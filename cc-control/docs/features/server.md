# 实时面板模块 — 需求文档

> 源码文件：`src/server/server.cjs` + `src/server/dashboard.html`

---

## 架构概述

HTTP Session Server 是 `awf run` 的核心通信枢纽，承担三个角色：

1. **tmux 桥接** — 接收 CLI 指令，转发到 tmux session
2. **状态机** — 通过 Claude Code Hooks 驱动 ready/busy 状态转换
3. **实时面板** — 提供 Web dashboard 展示任务进度和实时输出

```
┌─────────────┐     HTTP      ┌──────────────┐    tmux     ┌──────────────┐
│  CLI (run)  │◄─────────────►│ Session Server│◄──────────►│ tmux session │
│  awf run    │  /send /status │  port 8787   │ sendText   │  claude -p   │
│  dashboard  │  /respond ... │  state machine│ capture    │              │
└─────────────┘               └──────────────┘            └──────────────┘
                                     │
                                     │ POST /hook
                              ┌──────┴──────┐
                              │ Claude Code │
                              │   Hooks     │
                              └─────────────┘
```

---

## 1. HTTP 路由表

| 方法 | 路径 | 用途 | 关键逻辑 |
|------|------|------|---------|
| GET | `/` | Dashboard HTML | 读 dashboard.html，fallback ui.html |
| GET | `/ui` | UI HTML | 读 ui.html |
| GET | `/awf/state` | 读取 state.json | 直接返回文件内容 |
| GET | `/status` | 查询状态 | 返回 state + session + decisionPending |
| POST | `/send` | 发送 prompt | waitReady → setBusy → captureTranscript → logPrompt → submit |
| POST | `/cmd` | 发送命令 | waitReady → setBusy → submit → fallback timer |
| POST | `/respond` | 回应决策 | 有 decisionPending 跳过 waitReady → logChoice → submit → fallback timer |
| POST | `/choice` | AI 通知需选择 | setDecision({ type: 'choice' }) |
| POST | `/ask` | AI 通知需输入 | setDecision({ type: 'text' }) |
| POST | `/hook` | CC Hook 回调 | 事件分发 → 状态转换 |
| — | 其他 | 404 | `{ ok: false, error: 'not found' }` |

---

## 2. 路由详解

### GET `/`
- 尝试读 `dashboard.html` → 200 text/html
- 不存在 → 尝试 `ui.html` → 200
- 都不存在 → 500

### GET `/ui`
- 读 `ui.html` → 200 或 500

### GET `/awf/state`
- 读 `{CC_PROJECT}/.awf/state.json`
- 存在 → 200 + raw JSON
- 不存在 → 404

### GET `/status`
```json
{
  "ok": true,
  "state": "ready|busy",
  "session": true|false,
  "decisionPending": null|{...}
}
```
- `?snapshot=true` 时附加 `snapshot: tmux capture`

### POST `/send`
- 验证 `body.text` 非空 string → 400
- `!hasSession()` → 503
- `waitReady(READY_TIMEOUT_MS)` → 超时 → 409
- `captureFromTranscript()` → `logPrompt(text)` → `setBusy()` → `submit(text)`

### POST `/cmd`
- 验证 `body.cmd` 非空 string → 400
- `!hasSession()` → 503
- `waitReady` → 409
- `setBusy()` → `submit(cmd)`
- 1.5s fallback timer：若仍 busy → setReady（local cmd 可能不触发 Stop hook）

### POST `/respond`
- 验证 `body.value` 非空 → 400 + clearDecision
- `!hasSession()` → 503 + clearDecision
- 有 `decisionPending` → 跳过 waitReady（避免死锁）
- 无 `decisionPending` → waitReady
- `logChoice()` → `setBusy()` → `submit(value)`
- fallback timer：有 decision → 5min；无 → 1.5s

### POST `/choice`
- 验证 `body.question` 非空 string → 400
- `setDecision({ type: 'choice', question, options, context })`

### POST `/ask`
- 验证 `body.question` 非空 string → 400
- `setDecision({ type: 'text', question, context })`

### POST `/hook`
- 读取 `body.event` 或 query `?event=`
- 根据 event 分发表：

| event | 动作 |
|-------|------|
| `SessionStart` | setReady + resetTranscript |
| `UserPromptSubmit` | setBusy |
| `Stop` | clearDecision + setReady + captureFromTranscript |
| `PreToolUse` + AskUserQuestion | setDecision（提取 questions[0]） |
| `PostToolUse` + AskUserQuestion | 更新 decision.answer/answered |

- 返回 `{ ok: true, event, state }`

---

## 3. ready/busy 状态机

### 状态定义

```js
let state = 'ready';           // 'ready' | 'busy'
let decisionPending = null;    // null | decision 对象
let waiters = [];              // waitReady 等待队列
```

### 转换图

```
         SessionStart
         ┌──────────┐
         ▼          │
  ┌──────┴──────┐   │
  │    ready    │───┘
  └──────┬──────┘
         │ UserPromptSubmit
         │ /send setBusy()
         │ /cmd setBusy()
         │ /respond setBusy()
         ▼
  ┌──────────────┐
  │    busy      │
  └──────┬───────┘
         │ Stop hook
         │ /cmd fallback timer (1.5s)
         │ /respond fallback timer (5min/1.5s)
         └──────────────► ready
```

### 关键函数

| 函数 | 签名 | 行为 |
|------|------|------|
| `setReady()` | — | state='ready'，遍历 waiters 全部 resolve(true)，清空 waiters |
| `setBusy()` | — | state='busy' |
| `waitReady(timeout)` | ms → Promise\<bool\> | ready 立即返回 true；busy 时 push waiter，等待唤醒或超时 |
| `setDecision(d)` | obj | decisionPending = d |
| `clearDecision()` | — | decisionPending = null |

### 超时常量

| 常量 | 默认值 | 说明 |
|------|--------|------|
| `READY_TIMEOUT_MS` | 120000 (2min) | /send、/cmd waitReady 超时 |
| `ENTER_DELAY_MS` | 200 | sendText 后等待再 sendEnter |
| `LOCAL_CMD_FALLBACK_MS` | 1500 | /cmd 和 /respond(无 decision) fallback |

---

## 4. dashboard.html

### 功能

单页 Web 控制台，每 2 秒轮询 `/awf/state` 和 `/status?snapshot=true`，展示：

| 区域 | 数据来源 | 说明 |
|------|---------|------|
| Topbar | state | 项目名 + 当前阶段标签 + 进度 N/M |
| Phase chain | state | 8 个阶段可视化串行链（PLAN→...→FINISH），当前阶段脉冲动画 |
| Task list | state | 左侧列表，图标 ✓/●/○ 区分 done/active/pending，deps 展示 |
| Output | /status snapshot | 右侧 tmux pane 实时输出，增量更新 |
| Connection | /status | 在线/离线状态标签 |

### 阶段规范

```js
PHASES = ['PLAN', 'DESIGN', 'CODE', 'DEV', 'REVIEW', 'TEST', 'COMMIT', 'FINISH']
// CODE/DEBUG/DOCS 统一 canonise 为 DEV
```

### 样式

- 深色主题，CSS 变量定义
- `.phase-step.current .dot` 使用 `pulse` 动画（1.2s 淡入淡出）
- `.task-item.current` 蓝色半透明背景 + 蓝色边框

---

## 5. 依赖

| 模块 | 用途 |
|------|------|
| `node:http` | HTTP server 创建 |
| `node:fs` | 读 dashboard.html、state.json |
| `node:path` | 路径拼接、__dirname |
| `./tmux.cjs` | hasSession、sendText、sendEnter、capture |
| `./run-logger.cjs` | RunLogger: logPrompt、logChoice、captureFromTranscript、resetTranscript |
