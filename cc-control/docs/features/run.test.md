# awf run — 测试用例文档

> 对应需求文档：`docs/features/run.md`
> 源码文件：`src/cli/run.js`
> 测试文件：`tests/unit/run.test.js`

---

## 测试场景总览

| # | 场景 | 类别 |
|---|------|------|
| 1 | state.json 不存在 → 退出 | 入口 |
| 2 | state.json 正常加载 → 进入主流程 | 入口 |
| 3 | ensureServer 启动成功 | 环境管理 |
| 4 | ensureServer 启动超时 → 抛出异常 | 环境管理 |
| 5 | ensureSession 执行 bootstrap | 环境管理 |
| 6 | Ctrl-C / SIGTERM 触发清理 | 环境管理 |
| 7 | 遍历所有 pending 任务 → FINISH | 任务循环 |
| 8 | 跳过 blocked 状态任务 | 任务循环 |
| 9 | 跳过 deps 未满足任务 | 任务循环 |
| 10 | 无 pending 任务时 break | 任务循环 |
| 11 | /send 成功 → waitForReady → done | 单任务执行 |
| 12 | /send 返回非 ok → 返回 timeout | 单任务执行 |
| 13 | executeTask 正常完成链路 | 单任务执行 |
| 14 | waitForTaskDone 60s 内检测到 done | 单任务执行 |
| 15 | waitForTaskDone 60s 后未 done → 返回 false | 单任务执行 |
| 16 | 连续 2 次超时 → 标记 blocked | 超时重试 |
| 17 | 超时后回查 state 发现 done → 正常继续 | 超时重试 |
| 18 | httpPost 正常 POST | HTTP 通信 |
| 19 | httpPost 连接拒绝 | HTTP 通信 |
| 20 | httpPostJson 正常/非法 JSON | HTTP 通信 |
| 21 | getStatus 返回 ready | HTTP 通信 |
| 22 | getStatus 连接失败返回 false | HTTP 通信 |
| 23 | getStatus 超时 2s | HTTP 通信 |
| 24 | handleDecision: AskUserQuestion 单选 | 决策处理 |
| 25 | handleDecision: AskUserQuestion 多选 | 决策处理 |
| 26 | handleDecision: AskUserQuestion 已回答 | 决策处理 |
| 27 | handleDecision: choice 类型 | 决策处理 |
| 28 | handleDecision: text 类型 | 决策处理 |
| 29 | waitForReady: decisionPending 处理 | 状态轮询 |

---

## 详细测试用例

### TC1: state.json 不存在 → 退出

**前置条件**：`loadState` 返回 null

**执行**：`runCommand(undefined, {})`

**断言**：
- 输出错误提示 "未找到 .awf/state.json，请先执行 awf plan"
- `process.exit(1)` 被调用
- 不执行 ensureServer / ensureSession / runLoop

---

### TC2: state.json 正常加载 → 进入主流程

**前置条件**：state 包含 1 个 pending 任务，`currentState: 'IDLE'`

**执行**：`runCommand(undefined, {})`

**断言**：
- `loadState` 被调用
- `ensureServer` 被调用
- `ensureSession` 被调用
- `open` dashboard 被 spawn
- `runLoop` 被调用
- finally 块中 `doCleanup` 被调用

---

### TC3: ensureServer 启动成功

**前置条件**：8787 端口可用，server 进程正常启动，`/status` 在第 3 次轮询时返回 ready

**执行**：`ensureServer(paths, projectRoot)`

**断言**：
- `execSync` 被调用清理 8787 端口
- `sleep(300)` 等待端口释放
- `spawn('node', [paths.tmuxServer], ...)` 被调用，env 包含 `CC_PORT` 和 `CC_PROJECT`
- 轮询 `/status` 最多 30 次，每次间隔 500ms
- 日志输出 ok: "已启动"

---

### TC4: ensureServer 启动超时 → 抛出异常

**前置条件**：server 启动后 `/status` 30 次轮询均未返回 ready

**执行**：`ensureServer(paths, projectRoot)`

**断言**：
- 30 次轮询全部完成
- 抛出 `Error('tmux-http 启动超时')`

---

### TC5: ensureSession 执行 bootstrap

**前置条件**：tmux 已安装，bootstrap.sh 可执行

**执行**：`ensureSession(paths, projectRoot)`

**断言**：
- `execSync('tmux kill-session -t cc')` 被调用（清理旧 session）
- `execSync('bash ...bootstrap.sh', ...)` 被调用，env 包含 `CC_WORKDIR`
- 日志输出 ok: "cc → {projectRoot}"

---

### TC6: Ctrl-C / SIGTERM 触发清理

**前置条件**：runCommand 运行中

**执行**：触发 `process.emit('SIGINT')` 或 `process.emit('SIGTERM')`

**断言**：
- `execSync('tmux kill-session -t cc')` 被调用
- `execSync` 释放 8787 端口
- `console.log` 输出 "服务已关闭"
- `process.exit(0)` 被调用
- 二次触发不重复执行（`cleaned` 标记）

---

### TC7: 遍历所有 pending 任务 → FINISH

**前置条件**：state 有 2 个 pending 任务 T1、T2，currentState 非 FINISH

**执行**：`runLoop(projectRoot)`

**断言**：
- T1 被 `findNextTask` 返回 → `executeTask` 被调用
- T2 被 `findNextTask` 返回 → `executeTask` 被调用
- state 重读后 `currentState === 'FINISH'` 时退出循环
- 输出 "工作流结束"

---

### TC8: 跳过 blocked 状态任务

**前置条件**：state 有 T1(status=done)、T2(status=blocked)、T3(status=pending)

**执行**：`findNextTask(currentState)`

**断言**：
- `findNextTask` 跳过 T2（status 不是 pending）
- 返回 T3

---

### TC9: 跳过 deps 未满足任务

**前置条件**：T1(status=pending)、T2(status=pending, deps=['T1'])

**执行**：`findNextTask(currentState)`

**断言**：
- T1 被返回（无 deps 或 deps 满足）
- T2 被跳过（dep T1 为 pending，非 done）

---

### TC10: 无 pending 任务时 break

**前置条件**：state 所有任务 status=done，currentState 非 FINISH

**执行**：`runLoop(projectRoot)`

**断言**：
- `findNextTask` 返回 null
- `break` 退出循环
- 输出 "工作流结束"

---

### TC11: /send 成功 → waitForReady → done

**前置条件**：`/send` 返回 `{ ok: true }`，`waitForReady` 正常返回，任务在 state.json 中标记 done

**执行**：`executeTask(prompt, 'T1', projectRoot)`

**断言**：
- `httpPostJson('/send', { text: prompt })` 被调用
- `waitForReady` 被调用 2 次（任务前后各一次）
- `waitForTaskDone` 被调用
- 返回 `'ok'`
- 输出 "done"

---

### TC12: /send 返回非 ok → 返回 timeout

**前置条件**：`/send` 返回 `{ ok: false, error: 'session busy' }`

**执行**：`executeTask(prompt, 'T1', projectRoot)`

**断言**：
- 日志输出 error: "/send 失败: session busy"
- 返回 `'timeout'`
- `waitForReady` 不被调用

---

### TC13: executeTask 正常完成链路

**前置条件**：所有 HTTP 请求正常，task 执行完成

**执行**：`executeTask('prompt text', 'T1', projectRoot)`

**断言**：
1. `POST /send` 发送 prompt
2. `waitForReady` 等待 CC 就绪
3. `waitForTaskDone` 轮询 state 等 done（60s 内）
4. `waitForReady` 等待 auto-continue
5. 返回 `'ok'`

---

### TC14: waitForTaskDone 60s 内检测到 done

**前置条件**：state 中 T1 status 初始为 active，第 5 次轮询时变为 done

**执行**：`waitForTaskDone('T1', projectRoot)`

**断言**：
- 轮询 `loadState` 约 5 次
- 返回 `true`

---

### TC15: waitForTaskDone 60s 后未 done → 返回 false

**前置条件**：state 中 T1 status 始终为 active

**执行**：`waitForTaskDone('T1', projectRoot)`

**断言**：
- 轮询持续 60s
- 返回 `false`
- executeTask 中 `logStep('', 'warn', ...)` 输出未 done 警告

---

### TC16: 连续 2 次超时 → 标记 blocked

**前置条件**：executeTask 连续 2 次返回 `'timeout'`，state 回查后任务仍为 pending

**执行**：runLoop 中两次超时

**断言**：
- `consecutiveTimeouts` 累加到 2
- 日志输出 error: "连续 2 次超时，跳过任务 T1（需人工介入）"
- `consecutiveTimeouts` 被重置为 0
- 不阻塞后续任务

---

### TC17: 超时后回查 state 发现 done → 正常继续

**前置条件**：executeTask 超时，但 `checkTaskDone` 发现 task status 已为 done

**执行**：`executeTask` 的 catch 分支

**断言**：
- `checkTaskDone` 返回 true
- 日志输出 warn: "超时但任务 T1 已完成（Stop hook 未触发）"
- 返回 `'ok'`
- `consecutiveTimeouts` 被重置为 0

---

### TC18: httpPost 正常 POST

**前置条件**：HTTP server 正常运行

**执行**：`httpPost('http://127.0.0.1:8787/test', { key: 'val' })`

**断言**：
- 请求方法为 POST
- Content-Type 为 application/json
- body 为 `JSON.stringify({ key: 'val' })`
- 返回响应字符串

---

### TC19: httpPost 连接拒绝

**前置条件**：8787 端口无服务监听

**执行**：`httpPost('http://127.0.0.1:8787/send', { text: 'hi' })`

**断言**：
- `req.on('error', ...)` 触发
- Promise reject

---

### TC20: httpPostJson 正常/非法 JSON

**前置条件**：正常场景返回 `'{"ok":true}'`，非法场景返回 `'not json'`

**执行**：`httpPostJson(url, body)`

**断言**：
- 合法 JSON 时返回解析后的对象
- 非法 JSON 时返回 null（不抛异常）

---

### TC21: getStatus 返回 ready

**前置条件**：server 在 8787 端口返回 `{ state: 'ready' }`

**执行**：`getStatus()`

**断言**：
- GET 请求到 `http://127.0.0.1:8787/status`
- 返回 `{ state: 'ready' }`

---

### TC22: getStatus 连接失败返回 false

**前置条件**：8787 端口无服务

**执行**：`getStatus()`

**断言**：
- `req.on('error')` 触发
- 返回 `false`（不抛异常）

---

### TC23: getStatus 超时 2s

**前置条件**：server 响应时间超过 2s

**执行**：`getStatus()`

**断言**：
- `req.setTimeout(2000)` 触发
- `req.destroy()` 被调用
- 返回 `false`

---

### TC24: handleDecision: AskUserQuestion 单选

**前置条件**：decision 对象 `{ source: 'AskUserQuestion', question: '选择方案', options: ['A', 'B'], multiSelect: false, answered: false }`

**执行**：`handleDecision(decision)`

**断言**：
- 输出问题文本和选项列表
- `autoSelect` 被调用
- autoSelect 返回 `{ index: 1 }`
- `POST /respond` 被调用，body `{ value: '1' }`

---

### TC25: handleDecision: AskUserQuestion 多选

**前置条件**：decision 对象 `{ source: 'AskUserQuestion', question: '选择多个', options: ['X', 'Y'], multiSelect: true }`

**执行**：`handleDecision(decision)`

**断言**：
- 输出 "(多选)" 提示
- `autoSelect` 返回 `{ multiSelect: true, selected: [0] }`
- `POST /respond` 被调用，body `{ value: '0' }`（join(',')）

---

### TC26: handleDecision: AskUserQuestion 已回答

**前置条件**：decision `answered: true`，问题之前已处理过

**执行**：`handleDecision({ source: 'AskUserQuestion', answered: true, question: '选择方案', answer: 'A' })`

**断言**：
- `seenAnswers` 已包含该问题，不重复输出
- `autoSelect` 不被调用
- 直接返回

---

### TC27: handleDecision: choice 类型

**前置条件**：decision 对象 `{ type: 'choice', question: '选择一个', options: ['opt1', 'opt2'] }`

**执行**：`handleDecision(decision)` + 模拟用户输入 `'1'`

**断言**：
- 输出问题文本和 2 个选项
- readline 等待用户输入
- 用户输入 `'1'` 后选择 `opt1`
- `POST /respond` 被调用，body `{ value: 'opt1' }`

---

### TC28: handleDecision: text 类型

**前置条件**：decision 对象 `{ type: 'text', question: '请输入名称' }`

**执行**：`handleDecision(decision)` + 模拟用户输入 `'myname'`

**断言**：
- 输出问题文本
- readline 等待用户输入
- `POST /respond` 被调用，body `{ value: 'myname' }`

---

### TC29: waitForReady: decisionPending 处理

**前置条件**：getStatus 第一次返回 `{ state: 'busy' }`，第二次返回 `{ decisionPending: {...}, state: 'busy' }`，第三次返回 `{ state: 'ready' }`

**执行**：`waitForReady()`

**断言**：
- 第一次轮询：state=busy，继续轮询
- 第二次轮询：detects decisionPending → `handleDecision` 被调用
- 第三次轮询：state=ready → 返回
- 同一 decision 不重复处理（key 去重）

---

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| `node:child_process.spawn` | `vi.mock` | 控制 server 启动和 bootstrap 执行 |
| `node:child_process.execSync` | `vi.mock` | 控制 `command -v`、`tmux kill-session`、`lsof` 等同步命令 |
| `node:http` | `vi.mock` + 可控响应 | 模拟所有 HTTP 端点（/status, /send, /respond） |
| `./paths.js` | `vi.mock` | 返回固定路径 |
| `./state.js` | `vi.mock` | `loadState` 返回预制 state，控制任务完成状态变化 |
| `../lib/session/client.js`（autoSelect） | `vi.mock` | 返回固定选择结果 |
| `node:readline` | `vi.mock` | 模拟用户输入，避免阻塞 |
