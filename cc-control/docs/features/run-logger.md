# Run Logger 模块 — 需求文档

> 源码文件：`src/server/run-logger.cjs`

---

## 功能描述

RunLogger 是 `awf run` 的运行日志记录器，在 Session Server 启动时初始化。每次运行创建 `.awf/logs/{version}-{ts}/` 目录，保存主 Agent 与每个子 Agent 的可读 `.log`；Claude 的 JSONL transcript 仅作为转换输入，不会落入运行目录。

---

## 类结构

```
RunLogger
  ├─ constructor(projectRoot)
  │    ├─ _init()
  │    │    ├─ _readVersion()          → 从 state.json 读 version
  │    │    ├─ mkdir .awf/logs/
  │    │    └─ writeFile header        → 4 行头部信息
  │    └─ 未初始化则 enabled=false
  │
  ├─ enabled / path                    → getter
  │
  ├─ logPrompt(text)                   → _write('PROMPT', text)
  ├─ logResponse(text)                 → _write('RESPONSE', text)
  ├─ logChoice(question, answer)       → _append(Q/A 格式)
  │
  ├─ resetTranscript()                 → 重置 sessionStartTime + 文件指针
  ├─ captureFromTranscript()           → 增量读取 JSONL → logResponse
  │
  └─ _findTranscriptFile()             → ~/.claude/projects/{slug}/*.jsonl
```

---

## 1. 初始化

### constructor(projectRoot)

| 条件 | 行为 |
|------|------|
| `projectRoot` 为空 | 跳过初始化，`enabled = false` |
| `_readVersion()` 返回 null | 跳过初始化，`enabled = false` |
| 正常 | 创建 `.awf/logs/`，写入日志头 |

### _readVersion()

1. 读 `.awf/state.json`
2. 返回 `state.version`
3. 失败（文件不存在/非法 JSON/无 version）→ 返回 null

### 日志文件命名

```
{projectRoot}/.awf/logs/{version}-{ts}/
  main.log
  agents/{taskId}--{agentId}.log
```

例：`.awf/logs/0.1.3-2026-08-28T12-15-08/main.log`

### 日志头格式

```
=== AWF Run Log ===
version: 0.1.3
started: 2026-08-04T01:30:00.000Z
project: /path/to/project

```

---

## 2. 日志写入

### logPrompt(text)

```
────────────────────────────────────────────────────────────
[01:30:05] 提示词
{text}

```

- `SEP` = 60 个 `─` + 换行
- 时间戳 `HH:MM:SS` 格式（`slice(11,19)`）

### logResponse(text)

```
[01:30:10] 回答
{text}

```

- 无前缀分隔线

### logChoice(question, answer)

```
[01:30:15]
Q: {question}
A: {answer}

```

- 直接调用 `_append`，不经 `_write`

### _append(content)

- `fs.appendFileSync` 追加写入
- 异常 catch → `console.error`，不向上抛出

---

## 3. Transcript 捕获

### 机制

Claude Code 将对话记录写入 `~/.claude/projects/{slug}/` 目录的 `.jsonl` 文件。RunLogger 通过增量读取这些文件，自动提取 AI 的 assistant 消息写入日志。

### slug 生成

```js
projectRoot.replace(/\//g, '-')
```

例：`/Users/me/project` → `-Users-me-project`

### captureFromTranscript()

```
captureFromTranscript()
  ├─ _findTranscriptFile()
  │    ├─ 扫描 ~/.claude/projects/{slug}/*.jsonl
  │    ├─ 按 mtime 降序排列
  │    ├─ 无文件 → 返回 null
  │    └─ 最新文件 mtime < sessionStartTime → 返回 null（旧 session 文件）
  │
  ├─ 文件变化 → 更新 _transcriptFile + 重置 _transcriptPos=0
  ├─ readFile → 从 _transcriptPos 开始读取新内容
  ├─ 逐行解析 JSONL
  │    └─ entry.type === 'assistant'
  │         └─ 提取 message.content[] 中 type='text' 的 block
  │              └─ logResponse(texts.join(''))
  └─ 更新 _transcriptPos = content.length
```

### resetTranscript()

- 重置 `_sessionStartTime = Date.now()`
- 清空 `_transcriptFile` + `_transcriptPos = 0`

---

## 4. enabled 状态

`enabled` getter 返回 `!!this._logPath`。

当以下情况时 enabled=false（静默跳过所有写入）：
- 未传 projectRoot
- state.json 不存在或无法读取
- state.json 无 version 字段

---

## 5. 依赖

| 模块 | 用途 |
|------|------|
| `node:fs` | readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync |
| `node:path` | join |
| `node:os` | homedir() → `~/.claude/projects/` |
