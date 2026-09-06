# Run Logger 模块 — 测试用例文档

> 对应需求文档：`docs/features/run-logger.md`
> 源码文件：`src/server/run-logger.cjs`
> 测试文件：`tests/unit/run-logger.test.js`

---

## 测试场景总览

### 初始化 — 6 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 1 | 正常初始化：有 projectRoot + 有效 state.json | 正常 |
| 2 | projectRoot 为空 → enabled=false | 初始化 |
| 3 | projectRoot 为 null → enabled=false | 初始化 |
| 4 | state.json 不存在 → enabled=false | 初始化 |
| 5 | state.json 无 version 字段 → enabled=false | 初始化 |
| 6 | state.json 非法 JSON → enabled=false | 初始化 |

### 日志写入 — 5 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 7 | logPrompt: 格式验证 | 格式 |
| 8 | logResponse: 格式验证 | 格式 |
| 9 | logChoice: 格式验证 | 格式 |
| 10 | enabled=false 时写入被跳过 | 边界 |
| 11 | _append 异常不抛出 | 异常 |

### Transcript 捕获 — 5 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 12 | 增量读取：仅读取新增内容 | 正常 |
| 13 | 无新内容 → 不写入 | 正常 |
| 14 | 文件不存在 → 跳过 | 正常 |
| 15 | 非 assistant 行 → 跳过 | 正常 |
| 16 | assistant 消息含多个 text block | 格式 |

### 边界 — 4 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 17 | 日志头格式验证 | 格式 |
| 18 | 版本号来自 state.json | 数据源 |
| 19 | slug 生成规则 | 边界 |
| 20 | sessionStartTime 过滤旧文件 | 边界 |

---

## 详细测试用例

### TC1: 正常初始化

**前置条件**：projectRoot 为临时目录，`.awf/state.json` 内容为 `{"version":"0.1.0"}`

**执行**：`new RunLogger(tempDir)`

**断言**：
- `logger.enabled` = true
- `logger.path` = `{tempDir}/.awf/logs/0.1.0.log`
- `.awf/logs/` 目录被创建
- 日志文件包含头部 "=== AWF Run Log ==="
- 日志文件包含 `version: 0.1.0`
- 日志文件包含 `started: {ISO时间戳}`
- 日志文件包含 `project: {tempDir}`

---

### TC2: projectRoot 为空字符串 → enabled=false

**前置条件**：无

**执行**：`new RunLogger('')`

**断言**：
- `logger.enabled` = false
- `logger.path` = null
- 不创建任何目录和文件
- `_init()` 不执行（Constructor 中 `if (!projectRoot) return`）

---

### TC3: projectRoot 为 null → enabled=false

**前置条件**：无

**执行**：`new RunLogger(null)`

**断言**：
- `logger.enabled` = false
- 同 TC2

---

### TC4: state.json 不存在 → enabled=false

**前置条件**：projectRoot 有效但 `.awf/state.json` 不存在

**执行**：`new RunLogger(tempDir)`

**断言**：
- `_readVersion()` 抛 ENOENT → catch → 返回 null
- `_init()` 中 `if (!version) return` → 提前退出
- `logger.enabled` = false
- 不创建 .awf/logs/ 目录

---

### TC5: state.json 无 version 字段 → enabled=false

**前置条件**：state.json 内容为 `{"mode":"idle"}`（无 version）

**执行**：`new RunLogger(tempDir)`

**断言**：
- `_readVersion()` 返回 null（`state.version` 为 undefined）
- `logger.enabled` = false

---

### TC6: state.json 非法 JSON → enabled=false

**前置条件**：state.json 内容为 `{broken`

**执行**：`new RunLogger(tempDir)`

**断言**：
- `JSON.parse` 抛出异常 → catch → 返回 null
- `logger.enabled` = false
- 不抛异常

---

### TC7: logPrompt 格式验证

**前置条件**：logger 已正常初始化，日志文件为空

**执行**：`logger.logPrompt('请实现功能 X')`

**断言**：
- 日志文件追加内容包含 60 个 `─` + 换行
- 包含 `[HH:MM:SS] 提示词`
- 包含 `请实现功能 X`
- 时间戳格式为 `HH:MM:SS`（8 个字符）
- 以 `\n\n` 结尾（body 后 + 空行）

---

### TC8: logResponse 格式验证

**前置条件**：logger 正常

**执行**：`logger.logResponse('已完成功能 X')`

**断言**：
- 追加内容包含 `[HH:MM:SS] 回答`
- 包含 `已完成功能 X`
- **不**包含 60 个 `─` 分隔线（只有 PROMPT 类型才有）
- 以 `\n` 结尾

---

### TC9: logChoice 格式验证

**前置条件**：logger 正常

**执行**：`logger.logChoice('选择方案?', 'A方案')`

**断言**：
- 追加内容包含 `[HH:MM:SS]`
- 包含 `Q: 选择方案?`
- 包含 `A: A方案`
- 不包含 "提示词" 或 "回答" 标签

---

### TC10: enabled=false 时写入被跳过

**前置条件**：logger.enabled = false

**执行**：
- `logger.logPrompt('test')`
- `logger.logResponse('test')`
- `logger.logChoice('Q', 'A')`
- `logger.captureFromTranscript()`

**断言**：
- `logPrompt` 中 `_write` 第一行 `if (!this._logPath) return` → 直接返回
- `captureFromTranscript` 中同样 return
- 无文件写入
- 不报错

---

### TC11: _append 异常不抛出

**前置条件**：日志文件所在目录权限只读（或 mock `appendFileSync` 抛异常）

**执行**：`logger.logPrompt('test')`

**断言**：
- `appendFileSync` 抛出 EACCES
- catch 捕获 → `console.error` 输出错误信息
- 不向上抛出异常
- logger 对象保持可用

---

### TC12: transcript 增量读取

**前置条件**：
- JSONL 文件初始内容: `{"type":"assistant","message":{"content":[{"type":"text","text":"响应1"}]}}\n`
- _transcriptPos = 初始内容长度（已读）
- 新增内容: `{"type":"assistant","message":{"content":[{"type":"text","text":"响应2"}]}}\n`

**执行**：`logger.captureFromTranscript()`

**断言**：
- 只读取新增部分（从 _transcriptPos 开始）
- `logResponse('响应2')` 被调用
- `logResponse('响应1')` 不被调用（已读过）
- `_transcriptPos` 更新为新 content.length

---

### TC13: 无新内容 → 不写入

**前置条件**：content.length === _transcriptPos（无可读新内容）

**执行**：`logger.captureFromTranscript()`

**断言**：
- `if (content.length <= this._transcriptPos) return` → 直接返回
- logResponse 不被调用

---

### TC14: transcript 文件不存在 → 跳过

**前置条件**：`~/.claude/projects/{slug}/` 目录不存在或为空

**执行**：`logger.captureFromTranscript()`

**断言**：
- `_findTranscriptFile()` 返回 null
- 函数直接返回，不报错

---

### TC15: 非 assistant 行 → 跳过

**前置条件**：JSONL 新增内容:
```
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"你好"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"你好！"}]}}
```

**执行**：`logger.captureFromTranscript()`

**断言**：
- `type === 'user'` → 跳过
- `type === 'assistant'` → `logResponse('你好！')` 被调用
- 两条记录处理后 _transcriptPos 更新

---

### TC16: assistant 消息含多个 text block

**前置条件**：JSONL 新增:
```json
{"type":"assistant","message":{"content":[
  {"type":"text","text":"第一段"},
  {"type":"tool_use","name":"read","input":{}},
  {"type":"text","text":"第二段"}
]}}
```

**执行**：`logger.captureFromTranscript()`

**断言**：
- 提取 2 个 type='text' 的 block
- `logResponse('第一段第二段')` 被调用（join 无分隔符）
- `tool_use` block 被跳过

---

### TC17: 日志头格式验证

**前置条件**：projectRoot = `/tmp/test`，state.json version = `"0.2.0"`

**执行**：`new RunLogger('/tmp/test')`

**断言**：
- 日志文件前 4 行:
```
=== AWF Run Log ===
version: 0.2.0
started: {ISO时间}
project: /tmp/test
```
- 第 5 行为空行
- header 写入在前，后续内容追加在后

---

### TC18: 版本号来自 state.json

**前置条件**：state.json version = `"1.0.0"`

**执行**：`new RunLogger(tempDir)`

**断言**：
- 日志文件名 = `1.0.0.log`
- 日志头中 `version: 1.0.0`

---

### TC19: slug 生成规则

**前置条件**：projectRoot = `/Users/test/my-project`

**执行**：`_findTranscriptFile()` 内部计算 slug

**断言**：
- `'/Users/test/my-project'.replace(/\//g, '-')` = `-Users-test-my-project`
- 查找目录 = `~/.claude/projects/-Users-test-my-project/`

---

### TC20: sessionStartTime 过滤旧文件

**前置条件**：
- `~/.claude/projects/{slug}/` 有 `2026-08-01.jsonl`（mtime 在 sessionStartTime 之前）
- sessionStartTime = 当前时间

**执行**：`_findTranscriptFile()`

**断言**：
- 找到最新文件但 `mtime < sessionStartTime`
- 返回 null（该文件属于旧 session，不读取）
- `captureFromTranscript()` 不执行读取

---

## Mock 策略

| 模块 | 方式 | 说明 |
|------|------|------|
| `node:fs` | 真实 fs + 临时目录 或 `vi.mock` | 优先使用临时目录进行集成测试 |
| `node:os.homedir()` | `vi.mock` | 返回临时目录，控制 transcript JSONL 文件 |
| state.json | 临时文件 | 每次测试创建不同的 state.json 内容 |
| 时间戳 | 验证格式使用正则 `/\[\d{2}:\d{2}:\d{2}\]/` | 不 mock Date，只验证格式正确性 |
