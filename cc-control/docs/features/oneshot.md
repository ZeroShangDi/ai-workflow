# 单次会话调用模块 — 需求文档

> 源码文件：`src/mcp/awf-oneshot/server.cjs`

---

## 功能描述

awf-oneshot 是一个 MCP Server，提供通过 `claude -p` 执行一次性无状态 LLM 调用的能力。它通过 stdio JSON-RPC 协议与 Claude Code 通信，将 prompt 转发给子进程 `claude -p`，返回 stdout。

### 设计原则

- **无状态** — 不读取或写入 state.json，不依赖项目上下文
- **自包含** — 单个 tool (`awf_oneshot`)，零外部依赖
- **超时可控** — spawn 5 分钟超时，避免无限等待

---

## 1. MCP 协议

| method | 说明 |
|--------|------|
| `initialize` | 返回 `protocolVersion: '2024-11-05'` |
| `tools/list` | 返回 1 个 tool（awf_oneshot） |
| `tools/call` | 分发到 awf_oneshot handler |
| `notifications/initialized` | 日志记录，无响应 |

---

## 2. awf_oneshot Tool

### 输入

| 参数 | 类型 | Required | 说明 |
|------|------|----------|------|
| `prompt` | string | 是 | 发给 Claude 的 prompt |
| `cwd` | string | 否 | 工作目录，默认 `process.cwd()` |

### 输出

```json
// 成功
{ "ok": true, "text": "claude -p 的 stdout（trim 后）" }

// 失败
{ "ok": false, "error": "错误描述", "text": "部分输出或 null" }
```

---

## 3. spawnClaude 实现

```
spawn('claude', ['-p', prompt], {
  cwd: cwd || process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, NO_COLOR: '1' },
  timeout: 300000,  // 5 分钟
})
```

| 事件 | 处理 |
|------|------|
| `stdout.data` | 累积到 output 字符串 |
| `close` (code=0) | `resolve({ ok: true, text: output.trim() })` |
| `close` (code≠0) | `resolve({ ok: false, error: '...exited {code}', text: output.trim() })` |
| `error` | `resolve({ ok: false, error: err.message })` |

注意：所有路径都走 `resolve`（不 reject），调用方永不抛异常。

---

## 4. 边界处理

| 场景 | 行为 |
|------|------|
| 空 prompt | `required: ['prompt']` → MCP 协议层拦截，返回参数校验错误 |
| claude 未安装 | `error` 事件 → `{ ok: false, error: 'spawn claude ENOENT' }` |
| 5 分钟超时 | spawn `timeout` 触发 SIGTERM → close code≠0 |
| prompts > 80 字符 | logStderr 截断到前 80 字符 `args.prompt.slice(0, 80)` |

---

## 5. 依赖

| 模块 | 用途 |
|------|------|
| `child_process.spawn` | 启动 `claude -p` 子进程 |
| `process.env.NO_COLOR` | 禁用 ANSI 颜色输出 |
