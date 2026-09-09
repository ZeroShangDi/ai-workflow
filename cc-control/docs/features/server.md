# 实时面板模块 — 需求文档

> 源码文件：`src/server/server.cjs` + `src/server/dashboard.html`
> 配套：`src/lib/messaging.js`（inbox socket 客户端，CLI 侧派发通道）、`src/server/run-logger.cjs`（运行日志）

---

## 架构概述

HTTP Session Server 是 `awf run` 的核心通信枢纽，承担五个角色：

1. **tmux 桥接** — 接收 CLI 指令，转发到 tmux session（含 inbox socket 派发通道的补充，实测降级 tmux `/send`）
2. **状态机** — 通过 Claude Code Hooks 驱动 ready/busy 状态转换（mainSessionId 隔离，子 agent 不翻转主闩锁）
3. **子 agent 观测与落账** — SubagentStart/Stop hook 登记观测 + 解析 `last_assistant_message` 的 RESULT 写 state.json
4. **决策上抛** — PreToolUse(AskUserQuestion) / 子 Agent NEEDS_INPUT 记录决策挂起，CLI 据此暂停补位
5. **实时面板** — 提供 Web dashboard 展示任务进度和实时输出

```
┌──────────────┐    HTTP     ┌────────────────┐    tmux     ┌──────────────┐
│  CLI (run)   │◄───────────►│ Session Server │◄──────────►│ tmux session │
│  awf run     │ /send /status│  port 8787     │  sendText  │  claude -p   │
│  scheduler   │ /respond ... │ 状态机/落账/决策 │  capture   │  └ 子 agent  │
└──────────────┘             └───────┬────────┘            └──────────────┘
                                     │ POST /hook
                                     ▼
                    ┌─────────────────────────────┐
                    │        Claude Code Hooks     │
                    │ SessionStart / Stop          │
                    │ UserPromptSubmit             │
                    │ SubagentStart / Stop         │
                    │ PreToolUse / PostToolUse     │
                    └──────────────┬──────────────┘
                    ┌──────────────┴──────────────┐
                    │                             │
         ┌──────────┴──────────┐    ┌─────────────┴─────────────┐
         │ SubagentStop 落账   │    │ AskUserQuestion 决策挂起   │
         │ RESULT → write state│    │ setDecision → decisionPending│
         │ .awf/state.json    │    │ CLI 暂停补位 → /respond     │
         └────────────────────┘    └───────────────────────────┘
```

> 派发通道：CLI 首选 inbox socket（`src/lib/messaging.js` `injectText`，NDJSON）向主会话注入派生指令；实测 cross-session messaging 内部开关 `CLAUDE_CODE_HARBOR_KITE` 无效（socket 不绑定）→ 当前降级 tmux `/send` 回合补位（见 §4.3）。

---

## 1. HTTP 路由表

| 方法 | 路径 | 用途 | 关键逻辑 |
|------|------|------|---------|
| GET | `/` | Dashboard HTML | 读 dashboard.html，fallback ui.html |
| GET | `/ui` | UI HTML | 读 ui.html |
| GET | `/awf/state` | 读取 state.json | 直接返回文件内容 |
| GET | `/status` | 查询状态 | 返回 state + session + decisionPending + contextReady + mainSessionId + activeAgents |
| GET | `/context-ready` | 读取快照就绪标记 | 一次性消费后复位（避免重复触发） |
| POST | `/context-ready` | 置位快照就绪标记 | AI 写上下文压缩快照后调用 |
| POST | `/send` | 发送 prompt | waitReady → setBusy → captureTranscript → logPrompt → submit |
| POST | `/cmd` | 发送命令 | waitReady → setBusy → submit → fallback timer |
| POST | `/stop` | 中断运行流 | sendCtrlC → clearDecision → fallback timer |
| POST | `/respond` | 回应决策 | 有 decisionPending 跳过 waitReady → logChoice → submit → fallback timer |
| POST | `/choice` | AI 通知需选择 | setDecision({ type: 'choice' }) |
| POST | `/ask` | AI 通知需输入 | setDecision({ type: 'text' }) |
| POST | `/hook` | CC Hook 回调 | 事件分发 → 状态转换 / 落账 / 决策挂起 |
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
  "decisionPending": null|{...},
  "contextReady": true|false,
  "mainSessionId": "session_id|null",
  "activeAgents": 0
}
```
- `decisionPending`：挂起的决策（`{ type: 'choice'|'text'|'multiSelect', question, options?, context?, source?, answer?, answered? }`），CLI 据此暂停补位
- `contextReady`：上下文压缩快照就绪标记（AI 写快照后置位，CLI 读后一次性消费）
- `mainSessionId`：主 Claude 会话 session_id（SessionStart 透传记录），用于主闩锁隔离
- `activeAgents`：agents registry 中 status=running 的子 agent 数（SubagentStart 登记 / SubagentStop 置 stopped）
- `?snapshot=true` 时附加 `snapshot: tmux capture`

### POST `/context-ready`
- 置位 `contextReady = true`，CLI 读后 `/clear`（GET 消费）

### GET `/context-ready`
- 读取就绪标记，一次性消费后立即复位（避免重复触发）

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

### POST `/stop`
- `!hasSession()` → 503
- `sendCtrlC()`（等价交互式 Ctrl+C）+ `clearDecision()`
- Ctrl+C 中断可能不触发 Stop hook → fallback timer 兜底恢复 ready

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
| `SessionStart` | 记录 mainSessionId（首个）+ setReady + resetTranscript |
| `UserPromptSubmit` | 仅主会话 setBusy（子 agent prompt 不翻转主闩锁，避免引用计数悬挂） |
| `Stop` | 仅主会话 clearDecision + setReady + captureFromTranscript |
| `SubagentStart` | 只观测：agents registry 登记 running + 追加 subagent-events.jsonl |
| `SubagentStop` | 置 stopped + 追加日志；优先解析 NEEDS_INPUT → 写决策挂起记录（不落账，见 §4.2）；否则解析 RESULT → 落账写 state（见 §4.1） |
| `PreToolUse` + AskUserQuestion | setDecision（提取 questions[0]，支持 multiSelect，source: 'AskUserQuestion'） |
| `PostToolUse` + AskUserQuestion | 兜底更新 decision.answer/answered |

- 返回 `{ ok: true, event, state }`

---

## 3. ready/busy 状态机

### 状态定义

```js
let state = 'ready';           // 'ready' | 'busy'
let decisionPending = null;    // null | decision 对象
let waiters = [];              // waitReady 等待队列
let contextReady = false;      // 上下文压缩快照就绪标记
let mainSessionId = null;      // 主 Claude 会话 session_id（主闩锁隔离）
const agents = new Map();      // 子 agent 观测: key(session_id/agent_id) → { sessionId, status, startedAt }
```

### 转换图

```
         SessionStart
         ┌──────────┐
         ▼          │
  ┌──────┴──────┐   │
  │    ready    │───┘
  └──────┬──────┘
         │ UserPromptSubmit（仅主会话）
         │ /send setBusy()
         │ /cmd setBusy()
         │ /respond setBusy()
         ▼
  ┌──────────────┐
  │    busy      │
  └──────┬───────┘
         │ Stop hook（仅主会话）
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
| `isMainSession(body)` | body → bool | mainSessionId 未记录或无 session_id → true（向后兼容）；否则 session_id === mainSessionId |

### 超时常量

| 常量 | 默认值 | 说明 |
|------|--------|------|
| `READY_TIMEOUT_MS` | 120000 (2min) | /send、/cmd waitReady 超时 |
| `ENTER_DELAY_MS` | 200 | sendText 后等待再 sendEnter |
| `LOCAL_CMD_FALLBACK_MS` | 1500 | /cmd 和 /respond(无 decision) fallback |
| `DECISION_FALLBACK_MS` | 300000 (5min) | /respond 有 decision 时的 fallback |

---

## 4. 多 agent 滑动窗口集成

### 4.1 SubagentStop 落账

子 Agent 结束 → SubagentStop hook → server 解析 `last_assistant_message`（= 子 Agent 最终文本，官方明确）的固定格式 RESULT → 写 state.json。

```
子 Agent 结束
  → SubagentStop hook（payload.last_assistant_message）
  → 未跟踪（无 SubagentStart / 幽灵 Stop）→ 仅观测，不落账、不写失败记录
  → 已跟踪 → parseSubagentResult：正则匹配 RESULT:\s*({...}) → JSON
  → settleSubagent：withStateLock 下写 state.json
      task.status       = result.status（failed/fail 映射为 blocked，调度只认 blocked 为终态）
      result.result     → task.exec.result
      result.files      → task.exec.files
      result.commits    → task.commits 追加
  → 可恢复失败 → .awf/logs/subagent-failed.jsonl（CLI 据此补发）
  → 良性失败（already done / state 不可读）→ 不写失败记录、不触发补发
```

**固定格式 RESULT**（status 接受 `done` / `blocked` / `failed`，协议 awf-worker.md 对齐）：

```json
RESULT: {"taskId": "T1", "status": "done", "result": "完成说明", "files": ["..."], "commits": [...]}
```

**防 taskId 错写（拒绝假成功）**：
- RESULT 指向已完成/已阻塞任务（task.status 已是 `done` / `blocked`）→ **良性拒绝**（`recoverable:false`），reason：`task X already done（RESULT taskId 可能错写）`，**不写失败记录**——phantom 先落账 / 重复 Stop 属正常，写失败记录会触发补发循环
- 原因：如 X1 子 Agent 误写成已 done 的 T3，若落账会错标已有任务成"假成功"，真实任务永不落账且不触发补发

**state.lock 文件锁**：`withStateLock`（5s 超时）串行化 state.json 写，避免与 CLI 并发读写冲突。

**失败补发**：`subagent-failed.jsonl` 记录 agentId + reason + resultTaskId；CLI（run-batch）读后 SendMessage 恢复子 Agent 补齐 RESULT（`RESEND_MAX=2`）。
- 每 run 启动（server start / 独立进程）清空 `subagent-failed.jsonl` / `subagent-needs-input.jsonl`，避免跨 run 残留整段重放触发伪补发；`subagent-events.jsonl` 纯观测保留

### 4.2 决策上抛（AskUserQuestion / NEEDS_INPUT）

两条路径，均只**记录挂起**（不落账，任务保持等待），CLI 据此暂停补位直到决策解决：

1. **主 Agent 原生 AskUserQuestion** — PreToolUse hook 拦截（不阻止执行）→ `setDecision`
   - `source: 'AskUserQuestion'`，`multiSelect` 支持（`q.multiSelect` → `type: 'multiSelect'`）
   - PostToolUse hook 兜底：原生 UI 回答后更新 `decision.answer` / `answered`
2. **子 Agent NEEDS_INPUT** — SubagentStop 解析 `NEEDS_INPUT: {taskId, question, options?, context?}` → 写 `.awf/logs/subagent-needs-input.jsonl`（不落账）

**CLI 侧**（run-batch）：
- `/status` 轮询 sees `decisionPending` / needs 记录 → 暂停补位（`pendingNeeds` map 跟踪）
- 用户回应走 `/respond`（有 decisionPending 时跳过 waitReady，避免死锁）
- 决策解决后恢复补位

### 4.3 inbox socket 派发通道

CLI 经 `src/lib/messaging.js` `injectText(socketPath, text)` 向主会话注入派生指令（派生后台子 Agent）。

- **线格式 NDJSON**（`\n` 结尾）：

  ```json
  {"type":"user","message":{"role":"user","content":"<指令文本>"},"priority":"next"}
  ```

- **socket 路径**：bootstrap 以 `--messaging-socket-path $WORKDIR/.awf/messaging.sock` 固定（隐藏 flag），CLI 无需猜
- **前提**：env 去掉 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` / `DISABLE_TELEMETRY` / `DO_NOT_TRACK` / `DISABLE_GROWTHBOOK`（会关闭 cross-session messaging）；主会话配 `crossSessionInbound: "accept"`（bootstrap `--settings .awf/run-settings.json` 注入）
- **注入行为**：`type:"user"` 消息 = 主会话收到一条用户 prompt（等价终端输入）→ 执行"派生后台子 Agent"；mid-turn 在工具间隙读取，不打断运行中的工具
- **实测结论**：cross-session messaging 内部开关 `CLAUDE_CODE_HARBOR_KITE` 实测无效（socket 不绑定）→ **当前降级 tmux 回合补位**（`/send` sendText：主会话每回合派后台子 Agent 后立即结束回合，CLI 感知完成 → 下回合补位）；inbox socket 客户端保留，待 socket 可用

---

## 5. dashboard.html

### 功能

单页 Web 控制台，每 2 秒轮询 `/awf/state` 和 `/status?snapshot=true`，展示：

| 区域 | 数据来源 | 说明 |
|------|---------|------|
| Topbar | state | 项目名 + 当前阶段标签 + 进度 N/M |
| Phase chain | state | 8 个阶段可视化串行链（PLAN→...→FINISH），当前阶段脉冲动画 |
| Task list | state | 左侧列表，图标 ✓/●/○ 区分 done/active/pending，deps 展示 |
| Decision | /status decisionPending | 挂起决策渲染（renderDecision），用户回应走 /respond |
| Output | /status snapshot | 右侧 tmux pane 实时输出，增量更新 |
| Connection | /status | 在线/离线/执行中状态标签 |

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

## 6. 依赖

| 模块 | 用途 |
|------|------|
| `node:http` | HTTP server 创建 |
| `node:fs` | 读 dashboard.html、state.json；落账 / 子 agent 日志 / state.lock 写 |
| `node:path` | 路径拼接、__dirname |
| `./tmux.cjs` | hasSession、sendText、sendEnter、sendCtrlC、capture |
| `./run-logger.cjs` | RunLogger: logPrompt、logChoice、captureFromTranscript、resetTranscript |
| `src/lib/messaging.js` | inbox socket 客户端（CLI 侧配套，注入派生指令；非 server 依赖） |
