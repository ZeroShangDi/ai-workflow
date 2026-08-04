# CC Hooks 模块 — 需求文档

> 源码文件：`src/server/hooks/settings.json` + `src/server/server.cjs` 的 `/hook` 路由

---

## 架构概述

CC Hooks 是 Claude Code 的生命周期钩子系统。当特定事件发生时，CC 自动执行配置的 shell 命令，通知 Session Server 进行状态转换。

```
Claude Code 生命周期              Session Server
     │                                │
     │  SessionStart                   │
     │  ──curl POST /hook────────────►│  setReady()
     │                                │  resetTranscript()
     │                                │
     │  UserPromptSubmit               │
     │  ──curl POST /hook────────────►│  setBusy()
     │                                │
     │  PreToolUse (AskUserQuestion)   │
     │  ──curl + stdin JSON──────────►│  setDecision()
     │                                │
     │  PostToolUse (AskUserQuestion)  │
     │  ──curl + stdin JSON──────────►│  更新 answer + answered
     │                                │
     │  Stop                          │
     │  ──curl POST /hook────────────►│  clearDecision()
     │                                │  setReady()
     │                                │  captureFromTranscript()
```

---

## 1. settings.json 结构

### 5 个 Hook 事件

| Hook | 触发时机 | curl 方式 | 说明 |
|------|---------|-----------|------|
| `SessionStart` | CC 会话启动 | POST body `{"event":"SessionStart"}` | 通知 server 转为 ready |
| `UserPromptSubmit` | 用户提交 prompt | POST body `{"event":"UserPromptSubmit"}` | 通知 server 转为 busy |
| `Stop` | CC 响应完成 | POST query `?event=Stop` + stdin `@-` | 通知 server 转为 ready |
| `PreToolUse` | tool 执行前 | POST query `?event=PreToolUse` + stdin `@-` | 捕获 AskUserQuestion 参数 |
| `PostToolUse` | tool 执行后 | POST query `?event=PostToolUse` + stdin `@-` | 捕获 AskUserQuestion 响应 |

### Hook 模板结构

每个 hook 遵循 Claude Code settings.json 规范：

```jsonc
{
  "hooks": {
    "EventName": [
      {
        "matcher": "ToolName",     // 可选，过滤特定 tool
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
curl -s -m 2 -X POST http://127.0.0.1:__PORT__/hook \
  -H 'content-type: application/json' \
  -d '{"event":"SessionStart"}' >/dev/null 2>&1 || true
```

- 无 `matcher`，每次会话启动都触发
- `|| true` 确保 server 未就绪时 CC 不报错

### UserPromptSubmit

```bash
curl -s -m 2 -X POST http://127.0.0.1:__PORT__/hook \
  -H 'content-type: application/json' \
  -d '{"event":"UserPromptSubmit"}' >/dev/null 2>&1 || true
```

- 用户每次提交 prompt 时触发
- body 直接硬编码 event 字段

### Stop

```bash
curl -s -m 2 -X POST "http://127.0.0.1:__PORT__/hook?event=Stop" \
  -H 'content-type: application/json' -d @- >/dev/null 2>&1 || true
```

- `-d @-` 从 stdin 读取 CC 传入的 JSON body
- event 同时通过 query string 和可能的 body 传递（server 优先读 `body.event`，fallback `searchParams.get('event')`）

### PreToolUse

```bash
sh -c 'curl -s -m 2 -X POST "http://127.0.0.1:__PORT__/hook?event=PreToolUse" \
  -H "content-type: application/json" -d @- >/dev/null 2>&1; exit 0'
```

- `matcher: "AskUserQuestion"` — 只在 AI 调用 AskUserQuestion tool 时触发
- `|| true` 替换为 `; exit 0` — 确保 curl 失败时 CC tool 执行不被阻断（PreToolUse 允许继续执行）
- stdin (`@-`) 包含 tool_name 和 tool_input

### PostToolUse

```bash
curl -s -m 2 -X POST "http://127.0.0.1:__PORT__/hook?event=PostToolUse" \
  -H 'content-type: application/json' -d @- >/dev/null 2>&1 || true
```

- 无 `matcher`，所有 tool 执行后都触发（server 端过滤 AskUserQuestion）
- stdin 包含 tool_name 和 tool_response

---

## 3. curl 参数统一说明

| 参数 | 含义 |
|------|------|
| `-s` | silent 模式，不输出进度 |
| `-m 2` | 最大超时 2 秒 |
| `-X POST` | POST 方法 |
| `-d` | 请求 body |
| `-d @-` | 从 stdin 读取 body |
| `>/dev/null 2>&1` | 丢弃所有输出 |
| `\|\| true` | curl 失败不报错 |
| `; exit 0` | 同 `\|\|true`，确保 CC 继续 |

---

## 4. `__PORT__` 占位符

- `__PORT__` 在 `bootstrap.sh` 渲染时被替换为实际端口号（默认 `8787`）
- 存储在 `src/server/hooks/settings.json` 中作为模板

---

## 5. /hook 路由（server.cjs）

### 处理逻辑

```
POST /hook
  ├─ event = body.event || query ?event=
  ├─ switch(event):
  │    ├─ 'SessionStart'       → setReady() + resetTranscript()
  │    ├─ 'UserPromptSubmit'   → setBusy()
  │    ├─ 'Stop'               → clearDecision() + setReady() + captureFromTranscript()
  │    ├─ 'PreToolUse'         → if AskUserQuestion: setDecision()
  │    └─ 'PostToolUse'        → if AskUserQuestion: update decision.answer
  └─ return { ok: true, event, state }
```

### 状态转换表

| event | state 变化 | decisionPending 变化 | 附加操作 |
|-------|-----------|---------------------|---------|
| SessionStart | → ready | 不变 | resetTranscript |
| UserPromptSubmit | → busy | 不变 | — |
| Stop | → ready | → null | captureFromTranscript |
| PreToolUse (AskUserQuestion) | 不变 | → setDecision | — |
| PostToolUse (AskUserQuestion) | 不变 | 更新 answer | — |
| 其他 event | 不变 | 不变 | 仅日志输出 |

---

## 6. 依赖

| 模块 | 用途 |
|------|------|
| Claude Code Hook 系统 | 生命周期事件触发 |
| `curl` | 系统命令，发送 HTTP 通知 |
| Session Server (`server.cjs`) | 接收 /hook 请求，驱动状态机 |
| `bootstrap.sh` | 渲染 `__PORT__` 占位符 |
