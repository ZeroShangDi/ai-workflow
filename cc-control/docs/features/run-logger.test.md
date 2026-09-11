# Run Logger 模块 — 测试用例

> 对应功能文档：`docs/features/run-logger.md`
> 源码：`src/server/run-logger.cjs`
> 测试文件：`tests/unit/run-logger.test.js`

## 测试场景总览

| # | 场景 | 类别 |
|---|------|------|
| 1 | 正常初始化：目录 / 路径 / agents 子目录 / 头部 | 正常 |
| 2 | `projectRoot` 为空字符串 → enabled=false | 初始化 |
| 3 | `projectRoot` 为 null → enabled=false | 初始化 |
| 4 | state.json 不存在 → enabled=false | 初始化 |
| 5 | state.json 无 version → enabled=false | 初始化 |
| 6 | state.json 非法 JSON → enabled=false | 初始化 |
| 7 | logPrompt 格式（含 60 ─ 分隔线 + 提示词标签） | 格式 |
| 8 | logResponse 格式（无分隔线） | 格式 |
| 9 | logChoice 格式（Q/A） | 格式 |
| 10 | enabled=false 时写入被跳过 | 边界 |
| 11 | 写入异常不抛出（经 AppendFileStore 的 fs.appendFileSync） | 异常 |
| 12 | 主 transcript 增量捕获：只追加新增、不重复 | 正常 |
| 13 | 无新内容 → 跳过 | 正常 |
| 14 | transcript 文件不存在 → 不抛 | 正常 |
| 15 | 非 assistant 行 → 跳过 | 正常 |
| 16 | assistant 多 text block 拼接 | 格式 |
| 17 | 日志头格式（逐行） | 格式 |
| 18 | 版本号来自 state.json（目录名 + 头部） | 数据源 |
| 19 | slug 路径解析（transcript 在 slug 目录中被找到） | 边界 |
| 20 | sessionStartTime 过滤旧文件 | 边界 |
| 21 | 子 Agent transcript → 可读 log（含文件名净化） | 正常 |

> 注：测试文件用 `vi.spyOn(os, 'homedir')` 指向临时 `fake-home`，并各自创建 `.awf/state.json`。

## 详细测试用例

### TC1: 正常初始化

**前置条件**：`projectRoot` 为临时目录，`.awf/state.json` 为 `{"version":"0.1.0"}`

**执行**：`new RunLogger(tmpDir)`

**断言**：
- `logger.enabled === true`
- `logger.dir` 匹配 `.awf/logs/0.1.0-YYYY-MM-DDTHH-mm-ss$`
- `logger.path` 匹配 `.awf/logs/0.1.0-YYYY-MM-DDTHH-mm-ss/main.log$`
- `.awf/logs/` 与 `{runDir}/agents/` 目录存在
- `main.log` 含 `=== AWF Run Log ===`、`version: 0.1.0`、`started: `、`project: {tmpDir}`

### TC2 / TC3: root 为空串 / null

**执行**：`new RunLogger('')` / `new RunLogger(null)`

**断言**：`enabled === false`、`path === null`，不建目录（构造器 `if (!projectRoot) return`）。

### TC4–TC6: state.json 异常

**前置条件**：分别 ① 文件不存在 ② `{"mode":"idle"}` ③ `{broken`

**执行**：`new RunLogger(tmpDir)`

**断言**：`enabled === false`（`_readVersion` 返回 null，`_init` 提前 `return`），且不抛异常。

### TC7: logPrompt 格式

**执行**：`logger.logPrompt('请实现功能 X')`

**断言**：含 `─`.repeat(60)、`/\[\d{2}:\d{2}:\d{2}\] 提示词/`、`请实现功能 X`。

### TC8: logResponse 格式

**执行**：`logger.logResponse('已完成功能 X')`

**断言**：含 `/\[\d{2}:\d{2}:\d{2}\] 回答/`、`已完成功能 X`；头部之后的正文**不含** 60 个 `─`。

### TC9: logChoice 格式

**执行**：`logger.logChoice('选择方案?', 'A方案')`

**断言**：含 `/\[\d{2}:\d{2}:\d{2}\]/`、`Q: 选择方案?`、`A: A方案`。

### TC10: enabled=false 时写入被跳过

**执行**：`new RunLogger(null)` 后调用 `logPrompt/logResponse/logChoice/captureFromTranscript`

**断言**：均不抛，`enabled === false`。

### TC11: 写入异常不抛出

**前置条件**：`vi.spyOn(fs, 'appendFileSync')` 抛 `EACCES`、`console.error` 被 spy

**执行**：`logger.logPrompt('test')`

**断言**：不抛；`console.error` 收到含 `[run-logger] write error` 的字符串。

> 说明：`_append` 经 `_main.appendRawSync`（AppendFileStore），后者内部仍调用 `fs.appendFileSync`，故 mock 该函数可命中 catch 分支。

### TC12: 增量捕获

**执行**：写入一行 assistant `hello` → `captureFromTranscript()`；再追加 `world` → 再捕获。

**断言**：两次都含 `回答`；`hello` 只出现一次（`match(/hello/g)` 长度 1）。

### TC13: 无新内容 → 跳过

**断言**：第二次 `captureFromTranscript()` 后 `main.log` 内容不变。

### TC14: transcript 不存在 → 不抛

**执行**：无 fake-home 目录时 `captureFromTranscript()`

**断言**：`expect(() => ...).not.toThrow()`。

### TC15: 非 assistant 行跳过

**前置条件**：只写一行 `type:'user'` 内容 `USER TEXT`

**断言**：`main.log` 不含 `USER TEXT`。

### TC16: 多 text block 拼接

**前置条件**：assistant content = `[{text:'a'},{text:'b'}]`

**断言**：`main.log` 含 `ab`（join 无分隔符）。

### TC17: 日志头格式

**前置条件**：state.json version = `0.2.0`

**断言**：逐行 `lines[0]==='=== AWF Run Log ==='`、`lines[1]==='version: 0.2.0'`、`lines[2]` 匹配 `/^started: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/`、`lines[3]==='project: {tmpDir}'`、`lines[4]===''`。

### TC18: 版本号来自 state.json

**前置条件**：version = `1.0.0`

**断言**：`logger.path` 匹配 `/1\.0\.0-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\/main\.log$/`，头部含 `version: 1.0.0`。

> 修订：旧文档此处写作「文件名 = `1.0.0.log`」，与代码不符——实际是 `1.0.0-{ts}/main.log`。

### TC19: slug 路径解析

**前置条件**：transcript 写在 `{fake-home}/.claude/projects/{tmpDir.replace(/\//g,'-')}/session.jsonl`

**断言**：`captureFromTranscript()` 后 `main.log` 含写入文本（证明 slug 目录定位生效）。

### TC20: sessionStartTime 过滤

**前置条件**：transcript 文件 `utimesSync` 设为过去时间；`resetTranscript()` 把会话起点设为「现在」

**执行**：`captureFromTranscript()`

**断言**：`main.log` 不含旧文本（旧文件被过滤）。

### TC21: 子 Agent transcript 渲染

**前置条件**：`agent.jsonl` 含一行 assistant `subagent transcript`

**执行**：`logger.captureSubagentTranscript({ agent_transcript_path: agentSource }, 'T1', 'agent/one')`

**断言**：
- 生成 `{runDir}/agents/T1--agent_one.log`（`/` 被净化为 `_`）
- 含 `=== AWF Subagent Log ===`、`task: T1`、`[--:--:--] 回答`、`subagent transcript`
- `main.jsonl` 不存在（原始 jsonl 不落入 run 目录）

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| 临时目录 | `fs.mkdtempSync` | 每个 TC 独立；`afterEach` 递归删除 |
| `os.homedir()` | `vi.spyOn(...).mockReturnValue(fakeHome)` | 控制 transcript 查找目录（`makeLogger` 辅助） |
| `fs.appendFileSync` | `vi.spyOn` 抛错 | 验证 `_append` catch 分支（TC11） |
| `console.error` | `vi.spyOn` 静默 | 断言错误信息 |
| state.json | 真实临时文件 | 每例写入不同 version |
| 时间戳 | 正则 `/\[\d{2}:\d{2}:\d{2}\]/` | 不 mock Date，只验格式 |
| transcript 文件 | 真实写入 `.jsonl` | `assistantLine()` 辅助构造 assistant 行 |
