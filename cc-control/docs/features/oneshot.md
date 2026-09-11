# 单次会话调用（oneshot） — 功能文档

> 对应 WBS：W3-004（adapters/cc 工具适配收口）
> 源码：`src/adapters/oneshot.cjs`（cc oneshot 端口）+ `plugin/core/mcp/awf-oneshot/server.cjs`（插件 MCP 面）
> 相关：`src/server/server.cjs`（`/oneshot` 端点，装配根）+ `tests/unit/oneshot-adapter.test.js` / `tests/integration/awf-oneshot.test.js` / `tests/integration/awf-oneshot-server.test.js`

## 功能描述

oneshot = 通过 `claude -p` 执行一次性、无状态 LLM 调用，返回 stdout。它有两个面，二者关系是
「端口（实现）」与「插件 MCP（工具入口）」：

1. **cc oneshot 端口**（`src/adapters/oneshot.cjs`）—— 把 `claude -p` 的 spawn 收口到 adapter，
   外部源码零 `claude` 字面（纪律 R-cc）。经 `ports.cjs` 这道门对外（见 `docs/features/adapters.md`）。
2. **插件 MCP `awf-oneshot`**（`plugin/core/mcp/awf-oneshot/server.cjs`）—— 暴露 `awf_oneshot`
   tool 给 tmux 会话里的 Claude Code。它**优先经 server 的 `/oneshot` 端点**（server 内部用 oneshot
   端口 spawn），无 `AWF_BASE` 时才退回本地 spawn。

设计原则：**无状态**（不读写 state.json，不依赖项目上下文）、**自包含**（单 tool）、**超时可控**（5 分钟）。

### 三档回退链（插件 MCP 侧）

`awf-oneshot` MCP 有显式降级路径，按优先级：

| 档 | 触发条件 | 行为 | 位置 |
|----|----------|------|------|
| 1. 经 server | `AWF_BASE` 已设置（装配时注入 `http://127.0.0.1:<port>`） | `POST /oneshot?p=<project>`，server 用 oneshot 端口 spawn | `server.cjs:43-47,133` |
| 2. 经本地 adapter | 无 `AWF_BASE`，且 `require(src/adapters/oneshot.cjs)` 成功 | 调 `oneshotAdapter.spawnClaudeP(...)` 本地 spawn | `server.cjs:90-97` |
| 3. 本地最小实现 | 无 `AWF_BASE`，且**纯插件副本无包 `src/`**（require 抛错 → adapter=null） | `legacySpawnClaude` 直接 `_spawn('claude', ['-p', prompt])` | `server.cjs:11-16,72-88` |

> **降级路径的由来**：`server.cjs:13` 用 `path.join(__dirname, '..','..','..','..','src','adapters','oneshot.cjs')`
> 回取包内实现（`try/catch` 包裹）。这是**有意设计**：插件被纯副本安装（不带 `src/`）时仍能工作。
> 但请注意此文件的两条注释互相打架（审计 F6）：`:10` 写「claude -p 收口到 oneshot adapter… claude 字面
> 不在本 MCP」，而 `:74` 的 `legacySpawnClaude` 恰是 `_spawn('claude', ['-p', prompt])`；`:19` 的注释
> 又承认「缺省（离线/单测）沿用本地 spawn」。**实际行为**：档 3 回退里 `claude` 字面确实在本 MCP。

## 执行流程

### 端口（`src/adapters/oneshot.cjs`）

```
claudePArgs(prompt, { args }) → ['-p', ...args, prompt]
spawnClaudeP({ prompt, cwd, args, env, timeoutMs, stdio, spawn })
  → spawn('claude', claudePArgs(...), { cwd||process.cwd(), stdio, env:{...env, NO_COLOR:'1'}, timeoutMs? })
  → 收集 stdout/stderr → resolve({ ok: code===0, stdout, stderr, code })
                        | resolve({ ok:false, ..., error: err.message })   // error 事件
runOneShot(opts) = spawnClaudeP 的便捷包装
  → ok  → { ok:true, text: stdout.trim() }
  → !ok → { ok:false, error: stderr.trim() || error || `claude -p exited ${code}` }
```

所有路径都走 `resolve`（不 reject），调用方永不接异常。`spawn` 可注入（测试）。

### 插件 MCP（`plugin/core/mcp/awf-oneshot/server.cjs`）

```
MCP 启动 → require src/adapters/oneshot.cjs（成功则 oneshotAdapter 非空；失败置 null）
stdin 逐行 JSON-RPC → handleMessage
  initialize  → protocolVersion '2024-11-05', serverInfo.name 'awf-oneshot-mcp'
  tools/list  → 1 个 tool：awf_oneshot
  tools/call  → name==='awf_oneshot'? 校验 prompt → AWF_BASE ? serverOneShot : spawnClaude
```

## 核心常量 / 配置

| 常量 | 值 | 说明 |
|------|-----|------|
| `NO_COLOR` | `'1'` | spawn env 注入，禁 ANSI 颜色（端口 `spawnClaudeP`） |
| `timeout` | `300000` ms | MCP 本地 spawn 5 分钟超时（`server.cjs:78`）；端口经 `timeoutMs: 300000` 传入（`server.cjs:92`） |
| `prompt 日志截断` | 前 80 字符 | `logStderr(oneshot: ${args.prompt.slice(0,80)}...)`（`server.cjs:132`） |
| `protocolVersion` | `'2024-11-05'` | MCP 握手（`server.cjs:112`） |
| `serverInfo.name` | `'awf-oneshot-mcp'` | `server.cjs:114` |
| `AWF_PROJECT_ROOT` / `CC_PROJECT` | env | `/oneshot` 写类端点的 `?p=<project>` 来源（`server.cjs:23-24`）；缺 `p` server 400 拒绝 |

## 函数清单

| 函数 | 说明 | 位置 |
|------|------|------|
| `claudePArgs(prompt, { args })` | 构造 claude -p 参数（可附加 `--safe-mode` 等） | `src/adapters/oneshot.cjs:15` |
| `spawnClaudeP(opts)` | spawn `claude -p`，返回 `{ ok, stdout, stderr, code, error? }` | `src/adapters/oneshot.cjs:24` |
| `runOneShot(opts)` | 包装为 `{ ok, text }` / `{ ok:false, error }` | `src/adapters/oneshot.cjs:45` |
| `serverOneShot(prompt, cwd)` | 经 server `/oneshot?p=` 调用（档 1） | `plugin/core/mcp/awf-oneshot/server.cjs:43` |
| `spawnClaude(prompt, cwd)` | 档 2/3 分派：adapter 有则用，否则 legacy | `plugin/core/mcp/awf-oneshot/server.cjs:90` |
| `legacySpawnClaude(prompt, cwd)` | 纯插件副本的最小 spawn 实现（档 3） | `plugin/core/mcp/awf-oneshot/server.cjs:72` |
| `handlers['tools/call']` | MCP tool 分发（校验 prompt） | `plugin/core/mcp/awf-oneshot/server.cjs:122` |

## 接口 / 依赖

| 模块 | 用途 |
|------|------|
| `node:child_process.spawn` | 端口 spawn `claude -p`（可注入） |
| `node:http` | MCP 经 server `/oneshot`（档 1） |
| `path.join(__dirname,…)` require | MCP 回取 `src/adapters/oneshot.cjs`（档 2，纯插件副本降级） |
| `src/server/server.cjs` `/oneshot` | server 端点（`server.cjs:1365`），内部用 oneshot 端口（`server.cjs:22,28`；测试注入 `global.__CC_ONESHOT__`） |
| `src/lib/run-diagnosis.cjs` | 诊断用 oneshot（端口**由调用方注入**，lib 不反向依赖 adapters） |
| `src/adapters/ports.cjs` | oneshot 端口对外之门（`PORT_IMPLS.oneshot` README 见 adapters.md） |

## 验收标准

- [ ] `claudePArgs('p', { args:['--safe-mode'] })` === `['-p','--safe-mode','p']`
- [ ] `spawnClaudeP` 注入 spawn：ok 收集 stdout/stderr，error/非零 → `ok:false`
- [ ] `runOneShot`：ok → `{ok:true, text: trimmed}`；非 ok → error 取 stderr 优先，否则 `claude -p exited <code>`
- [ ] MCP `tools/list` 返回 1 个 tool（`awf_oneshot`，required `['prompt']`，含 `cwd`）
- [ ] MCP 空 prompt → `{ok:false, error:'prompt is required'}` 且不 spawn
- [ ] MCP 本地 spawn：`cmd='claude'`、`args=['-p', prompt]`、`stdio=['pipe','pipe','pipe']`、`timeout=300000`、`env.NO_COLOR='1'`
- [ ] `AWF_BASE` 设置时 `awf_oneshot` 走 server `/oneshot`（不本地 spawn）
- [ ] server `/oneshot` 缺 `?p` 时拒绝（单 server 多项目）
