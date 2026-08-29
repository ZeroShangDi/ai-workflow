# CC Hooks 模块 — 需求文档

> 源码文件：`plugin/core/hooks/hooks.json`（由 `plugin/config.json` 的 `hooks` 字段经 `scripts/render-config.mjs` 渲染生成，`__PORT__` → 实际端口）+ `src/server/server.cjs` 的 `/hook` 路由

---

## 架构概述

CC Hooks 是 Claude Code 的生命周期钩子系统。当特定事件发生时，CC 自动执行配置的 shell 命令，通知 Session Server 进行状态转换。

```
┌─ 主会话（mainSessionId 隔离，唯一驱动 ready/busy 闩锁）
│
│   SessionStart                   → setReady() + resetTranscript()（记录首个 session_id 为 mainSessionId）
│   UserPromptSubmit               → setBusy()（仅主会话）
│   PreToolUse (AskUserQuestion)   → setDecision()（M5 决策上抛）
│   PostToolUse (AskUserQuestion)  → 更新 answer + answered
│   Stop                           → clearDecision() + setReady() + captureFromTranscript()（仅主会话）
│
│   触发方式均为：curl POST /hook?event=<Event> + stdin @-
│
└──────────────────────────────────────────────────────────────────────────
┌─ 子 Agent（mainSessionId 隔离，只观测、不驱动闩锁）
│
│   SubagentStart   → agents 记录 running + 写 subagent-events.jsonl
│   SubagentStop    → 解析 last_assistant_message：
│                       NEEDS_INPUT → 写 subagent-needs-input.jsonl（不落账，任务保持等待）
│                       RESULT      → settleSubagent 落账写 state；失败写 subagent-failed.jsonl
│
│   触发方式均为：curl POST /hook?event=<Event> + stdin @-
```

---

## 1. hooks 配置结构

### 7 个 Hook 事件

| Hook | matcher | 触发时机 | curl 方式 | 说明 |
|------|---------|---------|-----------|------|
| `SessionStart` | 无 | CC 会话启动 | POST query `?event=SessionStart` + stdin `@-` | 记录 mainSessionId + 转为 ready |
| `UserPromptSubmit` | 无 | 用户提交 prompt | POST query `?event=UserPromptSubmit` + stdin `@-` | 主会话 → 转为 busy |
| `Stop` | 无 | CC 响应完成 | POST query `?event=Stop` + stdin `@-` | 主会话 → 转为 ready + 抓取 transcript |
| `SubagentStart` | 无 | 子 Agent 启动 | POST query `?event=SubagentStart` + stdin `@-` | 子 Agent 生命周期观测（不驱动闩锁） |
| `SubagentStop` | 无 | 子 Agent 结束 | POST query `?event=SubagentStop` + stdin `@-` | 解析 NEEDS_INPUT / RESULT → 落账 |
| `PreToolUse` | `AskUserQuestion` | tool 执行前 | POST query `?event=PreToolUse` + stdin `@-` | M5 决策上抛信号 → setDecision |
| `PostToolUse` | 无 | tool 执行后 | POST query `?event=PostToolUse` + stdin `@-` | AskUserQuestion 的 answer 回写 |

> 唯一配置源是 `plugin/config.json` 的 `hooks` 字段；`plugin/core/hooks/hooks.json` 由 `render-config.mjs` 渲染产物（`__PORT__` → 端口字面量，默认 `8787`），两者事件数 / matcher / curl 方式保持一致。

### Hook 模板结构

每个 hook 遵循 Claude Code hooks 配置规范（`plugin/config.json` → 渲染后 `plugin/core/hooks/hooks.json`）：

```jsonc
{
  "hooks": {
    "EventName": [
      {
        "matcher": "ToolName",     // 可选，过滤特定 tool（仅 PreToolUse 使用）
        "hooks": [
          {
            "type": "command",
            "command": "curl ..."
          }
        ]
      }
    ]
  }
}
```

---

## 2. 各 Hook 详解

### SessionStart

```bash
sh -c 'curl -s -m 2 -X POST "http://127.0.0.1:__PORT__/hook?event=SessionStart" \
  -H "content-type: application/json" -d @- >/dev/null 2>&1; exit 0'
```

- 无 `matcher`，每次会话启动都触发
- payload 透传 `session_id`：server 将首个会话记录为 `mainSessionId`（主会话隔离依据）
- `sh -c '...; exit 0'` 确保 curl 失败时 CC 不报错

### UserPromptSubmit

```bash
sh -c 'curl -s -m 2 -X POST "http://127.0.0.1:__PORT__/hook?event=UserPromptSubmit" \
  -H "content-type: application/json" -d @- >/dev/null 2>&1; exit 0'
```

- 无 `matcher`
- 仅主会话翻转闩锁为 busy；子 Agent 的 prompt 不翻转（子 Agent 完成走 SubagentStop，不触发主 Stop，引用计数会悬挂）

### Stop

```bash
sh -c 'curl -s -m 2 -X POST "http://127.0.0.1:__PORT__/hook?event=Stop" \
  -H "content-type: application/json" -d @- >/dev/null 2>&1; exit 0'
```

- 无 `matcher`，`-d @-` 从 stdin 读取 CC 传入的 JSON body
- 仅主会话：clearDecision + setReady + captureFromTranscript

### SubagentStart

```bash
sh -c 'curl -s -m 2 -X POST "http://127.0.0.1:__PORT__/hook?event=SubagentStart" \
  -H "content-type: application/json" -d @- >/dev/null 2>&1; exit 0'
```

- 无 `matcher`
- 只观测，不驱动主闩锁：`agents` 记录 `running` + 追加写 `.awf/logs/subagent-events.jsonl`

### SubagentStop

```bash
sh -c 'curl -s -m 2 -X POST "http://127.0.0.1:__PORT__/hook?event=SubagentStop" \
  -H "content-type: application/json" -d @- >/dev/null 2>&1; exit 0'
```

- 无 `matcher`
- **落账关键**：解析 `last_assistant_message` 的固定格式
  - `NEEDS_INPUT: {json}` → 写 `.awf/logs/subagent-needs-input.jsonl`（不落账，任务保持等待；CLI 暂停补位、主 Agent 原生 AskUserQuestion 问用户）
  - `RESULT: {json}` → `settleSubagent` 写 state（`task.status` + `exec.result/files/commits`），加 `.awf/state.lock` 防并发
  - 无有效 RESULT / 落账失败 → 写 `.awf/logs/subagent-failed.jsonl`（CLI 据此补发 SendMessage 恢复子 Agent 补齐 RESULT）

### PreToolUse

```bash
sh -c 'curl -s -m 2 -X POST "http://127.0.0.1:__PORT__/hook?event=PreToolUse" \
  -H "content-type: application/json" -d @- >/dev/null 2>&1; exit 0'
```

- `matcher: "AskUserQuestion"` — 只在调用 AskUserQuestion tool 时触发
- **M5 决策上抛信号**：主 Agent 提问时通知 server，从 `tool_input.questions` 构造 `decisionPending`（type: choice/multiSelect，source: AskUserQuestion）
- `sh -c '...; exit 0'` — 确保 curl 失败时 tool 执行不被阻断（PreToolUse 允许继续执行）
- stdin (`@-`) 包含 tool_name 和 tool_input

### PostToolUse

```bash
curl -s -m 2 -X POST "http://127.0.0.1:__PORT__/hook?event=PostToolUse" \
  -H 'content-type: application/json' -d @- >/dev/null 2>&1 || true
```

- 无 `matcher`，所有 tool 执行后都触发（server 端过滤 AskUserQuestion）
- **AskUserQuestion 的 answer 回写**：从 `tool_response` 提取 answer（string / answers / answer），更新 `decisionPending` 为 `answered: true`（兜底：PreToolUse 未拦截成功时的原生 UI 回答）
- 使用 `|| true`（非 `sh -c '...; exit 0'`）——与 hooks.json 中 PostToolUse 保持一致

---

## 3. curl 参数统一说明

| 参数 | 含义 |
|------|------|
| `-s` | silent 模式，不输出进度 |
| `-m 2` | 最大超时 2 秒 |
| `-X POST` | POST 方法 |
| `-d @-` | 从 stdin 读取 body |
| `>/dev/null 2>&1` | 丢弃所有输出 |
| `\|\| true` | curl 失败不报错（PostToolUse） |
| `sh -c '...; exit 0'` | 包一层 shell，命令整体恒返回 0，确保 CC 继续（其余 6 个事件） |

---

## 4. `__PORT__` 占位符

- `__PORT__` 写在 `plugin/config.json` 的 `hooks` 命令里作为占位符
- `scripts/render-config.mjs` 渲染时用 `replaceAll('__PORT__', String(port))` 替换为实际端口（默认 `8787`），生成 `plugin/core/hooks/hooks.json`
- `bootstrap.sh` 不做任何渲染——插件 / hooks / MCP 由 `.claude/settings.json` 注册加载

---

## 5. /hook 路由（server.cjs）

### 处理逻辑

```
POST /hook
  ├─ event = body.event || query ?event=
  ├─ 主会话隔离：isMainSession = !mainSessionId || !body.session_id || body.session_id === mainSessionId
  │   （mainSessionId 未记录或 payload 无 session_id 时向后兼容，全接受）
  ├─ switch(event):
  │    ├─ 'SessionStart'       → 记录 mainSessionId（首个 session_id）+ setReady() + resetTranscript()
  │    ├─ 'UserPromptSubmit'   → if isMainSession: setBusy()
  │    ├─ 'Stop'               → if isMainSession: clearDecision() + setReady() + captureFromTranscript()
  │    ├─ 'SubagentStart'      → agents.set(key, running) + 写 subagent-events.jsonl（不驱动闩锁）
  │    ├─ 'SubagentStop'       → agents 标记 stopped + 写日志
  │    │                        → 解析 NEEDS_INPUT → 写 subagent-needs-input.jsonl（不落账）
  │    │                        → else 解析 RESULT → settleSubagent 写 state；失败 → subagent-failed.jsonl
  │    ├─ 'PreToolUse'         → if tool_name === AskUserQuestion: setDecision()
  │    └─ 'PostToolUse'        → if tool_name === AskUserQuestion: 更新 decision.answer
  └─ return { ok: true, event, state }
```

### 状态转换表

| event | state 变化 | decisionPending 变化 | 附加操作 |
|-------|-----------|---------------------|---------|
| SessionStart | → ready | 不变 | 记录 mainSessionId + resetTranscript |
| UserPromptSubmit（主会话） | → busy | 不变 | — |
| Stop（主会话） | → ready | → null | captureFromTranscript |
| SubagentStart | 不变 | 不变 | agents 观测 + 事件日志 |
| SubagentStop | 不变 | 不变 | NEEDS_INPUT / RESULT 解析落账（写 state 或日志） |
| PreToolUse (AskUserQuestion) | 不变 | → setDecision | — |
| PostToolUse (AskUserQuestion) | 不变 | 更新 answer | — |
| 其他 event / 非主会话 | 不变 | 不变 | 仅日志输出 |

---

## 6. 依赖

| 模块 | 用途 |
|------|------|
| Claude Code Hook 系统 | 生命周期事件触发 |
| `curl` | 系统命令，发送 HTTP 通知 |
| `plugin/config.json` | ★ 唯一配置源（hooks 字段，含 `__PORT__` 占位符） |
| `scripts/render-config.mjs` | 渲染 `plugin/core/hooks/hooks.json`（`__PORT__` → 端口字面量） |
| Session Server (`server.cjs`) | 接收 /hook 请求，驱动状态机 + 子 Agent 落账 |
| `.claude/settings.json` | 插件 / hooks / MCP 注册加载（awf init 本地注入 / 全局 claude plugin install） |
