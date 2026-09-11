# CC Hooks 模块 — 功能文档

> 源码：`plugin/core/hooks/hooks.json`（渲染产物）+ `plugin/config.json`（hooks 段，唯一源）+ `plugin/core/hooks/gateway.cjs`（转发网关）+ `scripts/render-config.mjs`（渲染器）+ `src/server/server.cjs`（`/hook` 路由）+ `src/server/hook-adapter.cjs`（hook→领域事件接缝）
> 测试：`tests/unit/hooks.test.js` / `tests/unit/gateway.test.js` / `tests/unit/hook-adapter.test.js` / `tests/integration/decision.test.js`（`/hook` 路由）

---

## 功能描述

CC Hooks 是 Claude Code 的生命周期钩子。事件发生时 Claude Code 自动执行注册命令，把事件经 Session Server 的 `/hook` 路由转成**状态机转换**（ready/busy 闩锁）、**子 Agent 落账**与**决策闸门**动作。

- 共 **7 个 hook**：`SessionStart` / `UserPromptSubmit` / `Stop`（3 个状态）+ `SubagentStart` / `SubagentStop`（子 Agent 生命周期与落账）+ `PreToolUse` / `PostToolUse`（工具前后，当前仅用于 `AskUserQuestion`）。
- **全部 7 个 hook 统一走 `gateway.cjs`**（同一命令行 `node "<CLAUDE_PLUGIN_ROOT>/hooks/gateway.cjs" <port>`）——不再区分「裸 curl」与「网关转发」（v0.2.0 单 server 多项目改造后统一）。
- `gateway.cjs` 只做转发 + 透传：把 server 响应里**顶层 `ccOutput`** 原样打到 stdout（Claude Code 作为 hook 输出消费）；无 `ccOutput` 则无输出、`exit 0`。

---

## 执行流程

### 1. hook 注册与命令（7 个）

`plugin/core/hooks/hooks.json` 的实际注册（端口已由渲染器填成字面量，此处为示例口径）：

| Hook | matcher | 触发时机 | 命令 | 说明 |
|------|---------|---------|------|------|
| `SessionStart` | 无 | CC 会话启动 | `node …/gateway.cjs <port>` | 记录 `mainSessionId` + 打开新 run 元数据 + 转 ready |
| `UserPromptSubmit` | 无 | 用户提交 prompt | 同上 | 主会话 → 转 busy |
| `Stop` | 无 | CC 响应完成 | 同上 | 主会话 → 决策闸门 `handleStop`（可能返回 `ccOutput` block）+ 转 ready + 抓 transcript |
| `SubagentStart` | 无 | 子 Agent 启动 | 同上 | 记录 agents running + 写 run 元数据 + `subagent-events.jsonl`（不驱动闩锁） |
| `SubagentStop` | 无 | 子 Agent 结束 | 同上 | 解析 `NEEDS_INPUT` / `RESULT` → 落账（写 state）或写日志 |
| `PreToolUse` | `AskUserQuestion` | 工具执行前 | 同上 | 决策闸门 `handleAskUserQuestion`（可能返回 `ccOutput` deny / capture） |
| `PostToolUse` | 无 | 工具执行后 | 同上 | `AskUserQuestion` 的 answer 回写（server 端按 `tool_name` 过滤） |

- 只有 `PreToolUse` 带 `matcher: "AskUserQuestion"`；其余 6 个无 matcher。
- 每个 hook 的 `hooks[0].type` 恒为 `"command"`。

### 2. 端口渲染链路（`__PORT__` → 字面量）

```
plugin/config.json
  ├─ port: 8787
  └─ hooks: { … command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/gateway.cjs" __PORT__' … }   ← 占位符
        │
        ▼  scripts/render-config.mjs（npm run build 时运行）
  plugin/core/hooks/hooks.json     ← __PORT__ 被 replaceAll 成 "8787"（JSON 字面量端口）
```

- `render-config.mjs`：`renderHooksFile(hooks, port)` 用 `JSON.stringify(...).replaceAll('__PORT__', String(port))` 生成 hooks.json。
- **只渲染进引擎插件目录**（`config.engineDir`，缺省 `core`）：`resolvePluginAssets`（`src/lib/plugin-config.js`）让引擎插件在自身无声明时回落顶层 `config.hooks`；其余插件不给引擎运行时资产。此举避免双插件各自注册 Stop 造成竞态。
- 端口来源优先级：`config.json` 的 `port`（渲染默认）；`gateway.cjs` 运行期用 `argv[2]`，`CC_PORT` 仅兜底（测试/手工调用）。gateway.cjs 不再内嵌 8787 默认值。

### 3. gateway 转发协议（`plugin/core/hooks/gateway.cjs`）

```
stdin(CC hook JSON payload)
  → 解析 hook_event_name（缺失 → 直接 exit 0）
  → POST http://127.0.0.1:<port>/hook?event=<name>[&sid=<CC_SID>][&p=<CC_PROJECT>]
        · 端口 = argv[2] | CC_PORT | 0
        · sid 由 bootstrap 注入的 CC_SID 透传（T1-070，server 按 sid 路由到独立 run 槽）
        · p   由 bootstrap 注入的 CC_PROJECT 透传（单 server 多项目 → 路由到项目上下文）
  → 响应含顶层非空 ccOutput → stdout 写 JSON.stringify(ccOutput)
  → 否则无 stdout、exit 0
```

- 超时 `TIMEOUT_MS = 2500ms`；网络/解析异常一律静默 `exit 0`（hook 不误报、不阻断）。
- 需要读 server 回包（`ccOutput`）的场景才真正依赖 stdout：`Stop`（决策 block）、`PreToolUse`（决策 deny）。

### 4. `/hook` 路由（`src/server/server.cjs`）

```
POST /hook
  ├─ body = readJson(req) || {}          // 非法 JSON → {}，优雅降级
  ├─ event = body.event || query ?event=
  ├─ hookSid = query ?sid
  │    └─ 有 sid → handleSidHook(pcx, sid, event, body)   // 按 sid 路由到该项目内独立 run 槽（T1-071）
  │          SessionStart     → slot.setReady()
  │          UserPromptSubmit → slot.setBusy()
  │          Stop             → 若 !decisionEnabled 则 slot.clearDecision(); slot.setReady()
  │          PreToolUse(AskUserQuestion) → 若 !decisionEnabled 则 slot.setDecision(捕获)
  │          返回 { ok, event, state, sid }
  └─ 无 sid → 项目单槽主路径：
       SessionStart       → 诊断隔离判断 / 新 session 重置 run 日志与元数据 / 记录 mainSessionId
                            + sessionSeq++ + updateRunMeta + setReady + logger.resetTranscript()
       UserPromptSubmit   → isMainSession(body) 时 setBusy
       Stop               → isMainSession(body) 时 handleStop(pcx, body)，有回包则 ccOutput=out.ccOutput
       SubagentStart      → logSubagentEvent + agents.set(running) + updateRunMeta.subagents（外部 session 跳过）
       SubagentStop       → logSubagentEvent + agents 标 stopped + updateRunMeta.subagents
                            + parseSubagentNeedsInput → logSubagentNeedsInput（不落账）
                            | 否则 parseSubagentResult → settleSubagent（写 state；失败写 subagent-failed.jsonl）
       PreToolUse + AskUserQuestion  → handleAskUserQuestion(pcx, body)，有回包则 ccOutput
       PostToolUse + AskUserQuestion → 从 tool_response 提取 answer → 更新 decisionPending(answer/answered)
       返回 { ok, event, state[, ccOutput] }
```

- **主会话隔离**：`isMainSession(pcx, body) = !mainSessionId || !body.session_id || body.session_id === mainSessionId`（未记录或 payload 无 `session_id` 时向后兼容全接受）。子 Agent 的 `UserPromptSubmit` / `Stop` 不翻转主闩锁（子 Agent 走 `SubagentStop`）。
- **`event` 兼容两处**：优先 `body.event`，回落 query `?event=`（gateway 走 query）。

### 5. 状态机如何被驱动（ready/busy 来源）

| event | state 变化 | decisionPending / decisionGate | 附加操作 |
|-------|-----------|-------------------------------|---------|
| `SessionStart` | → **ready** | 不变 | 记录 mainSessionId + `sessionSeq++` + 重置/更新 run 元数据 + resetTranscript |
| `UserPromptSubmit`（主会话） | → **busy** | 不变 | — |
| `Stop`（主会话） | → **ready** | gate 关：清 decisionPending；gate 开：走决策闸门三分支（见 `decision-system.md`） | captureFromTranscript |
| `SubagentStart` | 不变 | 不变 | agents running + run 元数据 + `subagent-events.jsonl` |
| `SubagentStop` | 不变 | 不变 | NEEDS_INPUT / RESULT 解析落账（写 state 或日志） |
| `PreToolUse(AskUserQuestion)` | 不变 | gate 关：setDecision 捕获；gate 开：deny / 禁再问 | — |
| `PostToolUse(AskUserQuestion)` | 不变 | 更新 decisionPending.answer/answered | — |
| 其他 event / 非主会话 | 不变 | 不变 | 仅日志 |

- **ready/busy 唯一来源**：`setReady` / `setBusy`（`server.cjs`）。就绪等待方 `waitReady(timeout)` 由 `setReady` 唤醒全部 waiters。
- 本地 slash 命令（`/clear` 等）不产生 `Stop` hook，故 `sendLocalCmd` 用 `LOCAL_CMD_FALLBACK_MS` 兜底回 ready。

### 6. `hook → 领域事件` 接缝（`src/server/hook-adapter.cjs`）

`translateHook(payload)` 把 claude hook payload 译为领域事件（供事件总线消费），映射锚点在 `src/lib/events.cjs` 的 `HOOK_EVENT_MAP`：

| hook_event_name | 领域事件 | payload 锚点 |
|---|---|---|
| `SessionStart` | `run.started` | — |
| `Stop` | `run.stopped` | — |
| `SubagentStart` | `agent.started` | `agentId`（`agent_transcript_path` \|\| `session_id`） |
| `SubagentStop` | `agent.stopped` | `agentId`、`taskId` |
| `UserPromptSubmit` | `run.phase` | `phase:'BUSY'` |
| `PreToolUse` / `PostToolUse` / 未知 | —（不产出） | — |

- 适配器由 `createHookAdapter({ emit })` 提供 `.hook(payload, { runId })`；cc 细节字段（`CC_FIELDS`，如 `session_id`/`agent_id`/`stop_hook_active`/`tool_name`/`tool_input`/`last_assistant_message`）经 `pickCc` 收口进事件 `payload.cc`。
- **现状说明**：该接缝已在 `src/adapters/ports.cjs` 的 `hook` 端口装配，但 `server.cjs` 的 `/hook` 仍按事件直接分流（未改走事件总线）；完整提取（agent id、子 Agent RESULT 等）归 W1-046。本模块保持最小可扩展。

---

## 核心常量 / 配置

| 常量 / 键 | 值 | 说明 |
|---|---|---|
| `port` | `8787` | `plugin/config.json` 顶层端口；渲染进 hooks.json 命令 argv |
| hook 命令 | `node "${CLAUDE_PLUGIN_ROOT}/hooks/gateway.cjs" <port>` | 7 个 hook 统一命令形态（`__PORT__` 渲染为字面量） |
| `PRE` matcher | `"AskUserQuestion"` | 仅 `PreToolUse` 有 matcher |
| gateway 超时 | `2500ms` | `gateway.cjs` `TIMEOUT_MS` |
| `CC_SID` | env | bootstrap 注入；gateway 透传 `&sid=`（run 槽路由） |
| `CC_PROJECT` | env | bootstrap 注入；gateway 透传 `&p=`（多项目路由） |
| `ENTER_DELAY_MS` | `200ms`（`CC_ENTER_DELAY_MS`） | `submit` 中 sendText→sendEnter 间隔 |
| `LOCAL_CMD_FALLBACK_MS` | `1500ms`（`CC_LOCAL_CMD_MS`） | 本地 slash 命令兜底回 ready |
| `READY_TIMEOUT_MS` | `120000ms`（`CC_READY_TIMEOUT_MS`） | `waitReady` 缺省超时 |
| `subagent-events.jsonl` | `.awf/logs/…` | 子 Agent 事件原始落盘（`pcx.subagentEventPath`） |

---

## 函数清单

| 函数 | 说明 | 位置 |
|---|---|---|
| `main()` | gateway：读 stdin → POST `/hook` → 透传 `ccOutput` 到 stdout | `plugin/core/hooks/gateway.cjs` |
| `readStdin()` / `postToServer(event, body)` | stdin 收集 / 带 `sid`+`p` 的 POST 封装 | `plugin/core/hooks/gateway.cjs` |
| `renderHooksFile(hooks, port)` / `renderHooksObject` | `__PORT__` → 端口字面量 | `scripts/render-config.mjs` |
| `resolvePluginAssets(plugin, …)` | 引擎插件回落顶层 hooks/mcpServers；仅引擎落运行时资产 | `src/lib/plugin-config.js` |
| `/hook` 路由（无 sid 主路径） | 按 event 分流（状态/子 Agent/决策） | `src/server/server.cjs` |
| `handleSidHook(pcx, sid, event, body, res)` | 带 sid 的 hook → 独立 run 槽 | `src/server/server.cjs` |
| `setReady(pcx)` / `setBusy(pcx)` / `waitReady(pcx, t)` | ready/busy 闩锁 + 唤醒 waiters | `src/server/server.cjs` |
| `isMainSession(pcx, body)` | 主会话隔离判定 | `src/server/server.cjs` |
| `parseSubagentResult` / `parseSubagentNeedsInput` | 解析子 Agent `RESULT` / `NEEDS_INPUT` | `src/lib/extract.cjs`（经 `server.cjs` 包装） |
| `settleSubagent(pcx, body)` | 子 Agent RESULT 落账（state 写锁 + 字段合并） | `src/server/server.cjs` |
| `logSubagentEvent/NeedsInput/Failure` | 子 Agent 事件/决策/失败日志追加 | `src/server/server.cjs` |
| `translateHook(payload)` / `createHookAdapter` | hook payload → 领域事件（接缝，见 §6） | `src/server/hook-adapter.cjs` |

---

## 接口 / 依赖

| 模块 | 用途 |
|------|------|
| Claude Code Hook 系统 | 生命周期事件触发（含 `stop_hook_active`、`tool_name` 等 payload 字段） |
| `node "${CLAUDE_PLUGIN_ROOT}/hooks/gateway.cjs" <port>` | 唯一命令形态，转发并透传 `ccOutput` |
| `plugin/config.json` | ★ 唯一配置源（`port` / `hooks` 段，含 `__PORT__` 占位） |
| `scripts/render-config.mjs` | 渲染 `plugin/core/hooks/hooks.json`（`__PORT__` → 字面量端口，仅引擎插件） |
| Session Server (`server.cjs`) | 接收 `/hook`，驱动状态机 + 子 Agent 落账 + 决策闸门 |
| `src/server/decision-gate.cjs` / `src/server/decision.cjs` | 决策闸门规则与 Result 解析（见 `docs/features/decision-system.md`） |
| `.claude/settings.json` | 插件 / hooks / MCP 注册加载（`awf init` 本地注入 / 全局 `claude plugin install`） |

---

## 验收标准

- [ ] `plugin/config.json` 含 7 个 hook 键，且 7 个 hook 命令均指向 `gateway.cjs`（无 `curl`）。
- [ ] `PreToolUse` 的 `matcher === "AskUserQuestion"`；其余 6 个 hook 无 matcher。
- [ ] `__PORT__` 占位符存在于 config.json（≥5 处），渲染后 hooks.json 端口为字面量。
- [ ] `SessionStart` → ready + resetTranscript；`UserPromptSubmit`（主会话）→ busy；`Stop`（主会话）→ ready + captureTranscript（+ 可选 `ccOutput`）。
- [ ] 带 `sid` 的 hook 路由到独立 run 槽，不带 `sid` 走项目单槽主路径。
- [ ] `SubagentStop` 解析 `NEEDS_INPUT`（不落账）/ `RESULT`（`settleSubagent` 写 state）双分支正确。
- [ ] gateway 输出协议：响应含 `ccOutput` → stdout 恰为 `JSON.stringify(ccOutput)`；否则无输出、exit 0；异常静默 exit 0。
- [ ] 非主会话 / 未知 event / 空 body / 非 JSON body 均不改变状态、返回 200。
