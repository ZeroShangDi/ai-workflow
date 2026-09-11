# Run Logger 模块 — 功能文档

> 对应 WBS：（源码未标注；T1-111 编排运维提示行 / T1-112 server 输出落盘为相邻项）
> 源码：`src/server/run-logger.cjs`

## 功能描述

`RunLogger` 是 `awf run` 的运行日志记录器，随项目上下文构造（`src/server/project-context.cjs:47`，经 `createProjectRegistry` 注入）。每次初始化创建 `.awf/logs/{version}-{ts}/` 目录，保存：

- **主对话日志** `main.log` — 提示词 / 回答 / 选项 / 编排运维提示 / 决策关键事件行；
- **子 Agent 转录** `agents/{taskId}--{agentId}.log` — 由子 Agent 的 `.jsonl` transcript 渲染为人读文本。

Claude 的 JSONL transcript 仅作为**转换输入**，原始文件不落入运行目录（子 Agent 渲染文本除外）。

## 执行流程

```
RunLogger(projectRoot)
  ├─ _init()
  │    ├─ _readVersion()                → 从 .awf/state.json 读 version
  │    ├─ mkdir .awf/logs/ + agents/
  │    ├─ runDir = .awf/logs/{version}-{ts}/
  │    ├─ logPath = {runDir}/main.log
  │    ├─ _main = store.createAppendFileStore({ filePath: logPath })   ← main.log 追加走 store 层
  │    └─ _main.appendRawSync(header)   → 5 行头部
  └─ 未初始化则 enabled=false

写入：
  logPrompt / logResponse / logChoice / logNotice / logDecision
      → _write(...) 或 _append(...) → this._main.appendRawSync(content)

transcript 捕获：
  captureFromTranscript()          → 主会话 .jsonl 增量读 → logResponse
  captureSubagentTranscript(body)  → 子 agent .jsonl 全文渲染 → agents/{taskId}--{agentId}.log
```

## 初始化

`constructor(projectRoot)`（`:12-24`）：

| 条件 | 行为 |
|------|------|
| `projectRoot` 为空 | 跳过初始化，`enabled = false` |
| `_readVersion()` 返回 null | 跳过初始化，`enabled = false` |
| 正常 | 创建 `.awf/logs/{version}-{ts}/agents/`，写日志头 |

`_readVersion()`（`:52-61`）：读 `.awf/state.json` → 返回 `state.version`；文件不存在/非法 JSON/无 version → `null`。

### 目录与文件命名

```
{projectRoot}/.awf/logs/{version}-{ts}/
  main.log
  agents/{taskId}--{agentId}.log
```

- `ts` = `new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)`（如 `2026-08-28T12-15-08`，`:36`）。
- 例：`.awf/logs/0.1.3-2026-08-28T12-15-08/main.log`。
- 子 Agent 文件名对 `taskId`/`agentId` 做 `[^a-zA-Z0-9._-] → _` 净化（`:156-157`）。

### 日志头格式（`:42-49`）

```
=== AWF Run Log ===
version: {state.version}
started: {ISO 时间戳}
project: {projectRoot}

```

（4 行信息 + 1 个空行；经 `appendRawSync` 一次写入。）

## 日志写入

所有文本写入最终都经 `_append` → `this._main.appendRawSync(content)`（`:213-219`）。`_main` 是 `store.createAppendFileStore(...)`（`:40`），其 `appendRawSync` 内部执行 `fs.appendFileSync` 并确保目录存在（`src/lib/store.cjs:136-139`）。异常被 catch → `console.error`，不向上抛。

| 方法 | 格式 | 位置 |
|------|------|------|
| `logPrompt(text)` | `SEP` + `[HH:MM:SS] 提示词\n{text}\n\n` | `:77-79`、`:193-211` |
| `logResponse(text)` | `[HH:MM:SS] 回答\n{text}\n` | `:81-83` |
| `logChoice(question, answer)` | `[HH:MM:SS]\nQ: {q}\nA: {a}\n` | `:85-89` |
| `logNotice(kind, detail)` | `[{ISO}] [NOTICE][{kind}] {detail}\n` | `:95-98` |
| `logDecision({at,decisionId,event,detail})` | `[{at\|ISO}] [DECISION][{event}] {id} {detail}\n` | `:101-106` |

- `SEP` = 60 个 `─` + 换行（`:9`）。
- `logNotice`（T1-111）：编排层运维行（pause 闩锁告警/心跳/放行等），与对话内容分开标注，人读时一眼可辨「这是编排在说话」。
- `logDecision`：决策关键事件行，时间戳与决策存储 `created_at` 对齐，供 Review 页核对。

## Transcript 捕获

### 主会话 `captureFromTranscript()`（`:116-149`）

```
captureFromTranscript()
  ├─ _findTranscriptFile()
  │    ├─ 扫描 ~/.claude/projects/{slug}/*.jsonl（slug = projectRoot.replace(/\//g,'-')）
  │    ├─ 按 mtime 降序，取最新
  │    ├─ 无文件 → null
  │    └─ 最新 mtime < _sessionStartTime → null（旧 session 文件）
  ├─ 文件变化 → 更新 _transcriptFile + _transcriptPos = 0
  ├─ readFile → 从 _transcriptPos 起读增量
  ├─ 逐行 JSONL：entry.type === 'assistant' → 取 message.content[] 中 type='text' 的 block → logResponse(texts.join(''))
  └─ _transcriptPos = content.length
```

`resetTranscript()`（`:110-114`）：重置 `_sessionStartTime = Date.now()`、清空 `_transcriptFile`、`_transcriptPos = 0`（新会话开始时由 server 调用，`:932`）。

### 子 Agent `captureSubagentTranscript(body, taskId, agentId)`（`:152-171`）

- 源文件：`body.agent_transcript_path`；不存在则跳过。
- 渲染：`_renderTranscript(source)` → `extract.renderTranscriptText(...)`（`src/lib/extract.cjs:80-89`），逐行 JSONL 解析为 `[time] role\n...` 人读文本。
- 落盘：经 `storeCore.atomicWriteFileSync` **一次性原子写**（同名重试会覆盖而非追加，保持原语义）；头部 5 行含 `=== AWF Subagent Log ===` / `task` / `agent` / `captured` / 空行。

## 与 `.awf/logs/server.log` 的区别

| 维度 | Run Logger（`main.log` / `agents/*.log`） | Server 输出日志（`server.log`） |
|------|-------------------------------------------|----------------------------------|
| 生产者 | `RunLogger` 类（业务侧显式调用） | 常驻 server 进程的 stdout/stderr（由 CLI spawn 时接管 stdio） |
| 内容 | 提示词/回答/决策行/子 agent 转录（人读） | server 自身 console 输出（启动行、错误、诊断日志等） |
| 位置 | `.awf/logs/{version}-{ts}/main.log` | `.awf/logs/server.log`（相邻，不入 run 子目录） |
| 轮转 | 每个 run 一个新目录（无覆盖） | 单代轮转：超上限时旧文件改名为 `server.log.1`，新文件从空开始 |
| 源码 | `src/server/run-logger.cjs` | `src/lib/server-log.js`（`openServerLog`/`serverLogPath`，`:23-50`） |

`server.log` 单文件上限 `SERVER_LOG_MAX_MB`，默认 5MB，可用 `CC_SERVER_LOG_MAX_MB` 覆盖（`<=0` 不轮转）（`server-log.js:17-20`）；由 `src/cli/run.js:211-214` 与 `src/cli/server.js:24-25` 在 spawn server 时打开。

## 核心常量 / 配置

| 常量 | 值 | 说明 |
|------|----|------|
| `SEP` | 60 个 `─` + `\n` | PROMPT 前分隔线（`:9`） |
| 目录名 | `{version}-{ts}` | `ts` 截断到秒、`:`/`.` → `-`（`:36-37`） |
| 子 Agent 文件名 | `{taskId}--{agentId}.log` | 净化非法字符（`:156-157`） |
| `SERVER_LOG_MAX_MB` | 5（可配） | server.log 轮转阈值（`server-log.js:17-20`） |

## 函数清单

| 函数 | 说明 | 位置 |
|------|------|------|
| `constructor(projectRoot)` | 初始化目录、写头；空 root → enabled=false | `src/server/run-logger.cjs:12-24` |
| `_init()` | 建目录、建 AppendFileStore、写头 | `:28-50` |
| `_readVersion()` | 从 state.json 读 version | `:52-61` |
| `enabled` / `path` / `dir` | getter：是否启用 / main.log 路径 / run 目录 | `:65-75` |
| `logPrompt` / `logResponse` | 写提示词 / 回答 | `:77-83` |
| `logChoice` | 写 Q/A | `:85-89` |
| `logNotice` | 编排运维提示行 | `:95-98` |
| `logDecision` | 决策关键事件行 | `:101-106` |
| `resetTranscript` | 重置会话起点与读取指针 | `:110-114` |
| `captureFromTranscript` | 主会话 transcript 增量导出 | `:116-149` |
| `captureSubagentTranscript` | 子 agent transcript 渲染落盘 | `:152-171` |
| `_findTranscriptFile` | 定位最新（且非旧 session）transcript | `:173-184` |
| `_renderTranscript` | 调 `extract.renderTranscriptText` | `:186-189` |
| `_write` / `_append` | 组格式 / 追加写（经 AppendFileStore） | `:193-219` |

## 接口 / 依赖

| 模块 | 用途 |
|------|------|
| `src/lib/store.cjs` | `createAppendFileStore`（main.log 追加流） |
| `src/lib/store-core.cjs` | `atomicWriteFileSync`（子 agent 转录原子写） |
| `src/lib/extract.cjs` | `renderTranscriptText`（JSONL → 人读文本） |
| `src/server/project-context.cjs` | 构造 RunLogger 并挂到 pcx.logger |
| `src/lib/server-log.js` | server 自身输出落盘（与 run 日志区分的另一条链路） |
| `node:fs` / `node:path` / `node:os` | 文件读写 / 路径拼接 / `homedir()` |

## 验收标准

- [ ] 无 `projectRoot`、state.json 缺失或非法、无 `version` 时 `enabled=false` 且不建目录。
- [ ] 正常初始化生成 `.awf/logs/{version}-{ts}/`（含 `agents/`）与 `main.log`，头部 5 行正确。
- [ ] `logPrompt` 带 60 个 `─` 分隔线与 `[HH:MM:SS] 提示词`；`logResponse` 无分隔线。
- [ ] 主会话 transcript 增量读取：只追加新增内容，不重复；无新内容不写。
- [ ] `_findTranscriptFile` 过滤 mtime 早于会话起点的旧 session 文件。
- [ ] 子 Agent 转录渲染为 `agents/{taskId}--{agentId}.log`，含 `=== AWF Subagent Log ===` 与渲染后的 `[time] role` 文本；原始 `.jsonl` 不落入 run 目录。
- [ ] 写入异常被捕获（`console.error`），不向上抛。
- [ ] 与 `server.log` 路径/轮转语义不同：`server.log` 启动时按 `SERVER_LOG_MAX_MB` 单代轮转，run 日志每 run 新目录。
