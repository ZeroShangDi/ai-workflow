# tmux & Session 管理模块 — 需求文档

> 源码文件：`src/server/tmux.cjs` + `plugin/core/mcp/awf-session/server.cjs`

---

## 架构概述

```
┌──────────────────────────────────────────────────┐
│                    tmux session                   │
│  ┌─────────────┐                                 │
│  │ Claude Code │  ← sendText + sendEnter         │
│  │   (AI)      │  ← capture (read pane)           │
│  └──────┬──────┘                                 │
│         │ MCP tools                               │
│  ┌──────┴──────────────────────────────────┐     │
│  │  awf-session MCP Server (stdio)          │     │
│  │  ├─ awf_session_status → GET /status     │     │
│  │  ├─ awf_capture_pane  → execSync tmux   │     │
│  │  ├─ awf_await_choice  → POST /choice    │     │
│  │  └─ awf_await_input   → POST /ask       │     │
│  └──────────────────────────────────────────┘     │
└──────────────────────────────────────────────────┘
         │                    │
    execSync tmux        HTTP (127.0.0.1:8787)
         │                    │
  ┌──────┴──────┐    ┌───────┴───────┐
  │  tmux.cjs   │    │ Session Server │
  │  (server)   │    │  (server.cjs)  │
  └─────────────┘    └───────────────┘
```

两层 tmux 操作：

| 层 | 文件 | 方式 | 用途 |
|-----|------|------|------|
| Server 侧 | `tmux.cjs` | `execFileSync('tmux', ...)` | HTTP server 向 tmux 发指令 |
| MCP 侧 | `awf-session/server.cjs` | `execSync('tmux', ...)` + HTTP | AI 通过 MCP 观测 session 状态 |

---

## 1. tmux.cjs

### 设计

- CommonJS 模块（`require`）
- 单例：SESSION 名由 `CC_SESSION` 环境变量或默认 `cc` 决定
- 所有 tmux 命令通过 `execFileSync` 同步执行（避免竞态）

### 函数

| 函数 | 实现 | 返回值 | 说明 |
|------|------|--------|------|
| `tmux(args)` | `execFileSync('tmux', args, { encoding: 'utf8' })` | string | 内部封装，直接 throw on error |
| `hasSession()` | `tmux(['has-session', '-t', SESSION])` | boolean | try/catch，异常返回 false |
| `sendText(text)` | `tmux(['send-keys', '-t', SESSION, '-l', text])` | string | `-l` 表示 literal（不解释 tmux 快捷键） |
| `sendEnter()` | `tmux(['send-keys', '-t', SESSION, 'Enter'])` | string | 按回车提交当前输入 |
| `capture()` | `tmux(['capture-pane', '-t', SESSION, '-p'])` | string | `-p` 输出到 stdout |

### 导出

```js
module.exports = { SESSION, hasSession, sendText, sendEnter, capture };
```

---

## 2. awf-session MCP Server

### 运行时

- CommonJS（`require`）
- stdio JSON-RPC 协议（同 awf-state）
- 通过 HTTP 与 Session Server (8787) 通信
- 通过 `execSync` 直接调 tmux 命令

### 配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `AWF_BASE` | `http://127.0.0.1:8787` | Session Server 地址 |
| `CC_SESSION` | `cc` | tmux session 名称 |

### HTTP 客户端

| 函数 | 方法 | 说明 |
|------|------|------|
| `httpGet(path)` | GET | 3s 超时，返回解析后的 JSON 或 raw string |
| `httpPost(path, body)` | POST | 3s 超时，body 为已序列化的 JSON 字符串 |

两个函数都有 error → `{ ok: false, error: ... }` 的统一降级。

### capturePane()

内部使用 `execSync` 直接调 tmux（不经过 HTTP），3s 超时，失败返回 `"(capture failed: ...)"` — 从**不抛异常**。

---

## 3. 四个 MCP Tools

### awf_session_status

```
HTTP GET /status → 返回 { state, session, decisionPending }
+ 附加 pane 前 500 字符作为 preview
```

### awf_capture_pane

```
execSync('tmux capture-pane -t "cc" -p') → 返回完整文本
```

### awf_await_choice

```
logStderr → POST /choice { question, options, context }
→ 返回 HTTP 响应（CLI 处理后回传 /respond）
```

### awf_await_input

```
logStderr → POST /ask { question, context }
→ 返回 HTTP 响应
```

---

## 4. HTTP 依赖

| 端点 | 调用方 | 用途 |
|------|--------|------|
| `GET /status` | awf_session_status | 查询 ready/busy 状态 |
| `POST /choice` | awf_await_choice | 向 CLI 发起选择题请求 |
| `POST /ask` | awf_await_input | 向 CLI 发起文本输入请求 |

---

## 5. 已知 Bug: args 未解构

`server.cjs` 第 128 行：

```js
const { name } = params || {};
// 缺少: const { arguments: args } = params || {};
```

导致 `awf_await_choice` 和 `awf_await_input` 中引用的 `args` 为 `undefined`。函数内部：

```js
logStderr(`await_choice: ${args.question}`);  // TypeError
// ...
question: args.question  // undefined
```

**影响**：两个 await tools 完全不可用。

**对比 awf-state/server.cjs**（正确实现）：
```js
const { name, arguments: args } = params || {};
```

---

## 6. 依赖

### tmux.cjs

| 模块 | 用途 |
|------|------|
| `child_process.execFileSync` | 同步执行 tmux 命令 |
| `process.env.CC_SESSION` | session 名称 |

### awf-session/server.cjs

| 模块 | 用途 |
|------|------|
| `node:http` | HTTP 请求到 Session Server |
| `child_process.execSync` | capturePane 直接调 tmux |
| `process.env.AWF_BASE` | Session Server 地址 |
| `process.env.CC_SESSION` | tmux session 名称 |
