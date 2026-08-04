# awf run — 需求文档

## 功能描述

`awf run` 是 AI Workflow Framework 的执行引擎。它启动 HTTP Session Server + tmux session，遍历 `.awf/state.json` 中所有 pending 任务，逐任务逐阶段驱动 Claude Code 执行，直至全部完成或进入 FINISH 状态。

### 执行流程

```
runCommand
  ├─ 1. 加载 state.json（不存在则退出）
  ├─ 2. 注册 Ctrl-C 清理（tmux kill-session + 释放端口）
  ├─ 3. ensureServer  → 启动 HTTP Session Server（node src/server/server.cjs）
  ├─ 4. ensureSession → 执行 bootstrap.sh 创建 tmux session
  ├─ 5. open dashboard → 浏览器打开 http://localhost:8787
  └─ 6. runLoop       → 主循环
        ├─ findNextTask → 取下一个 pending 且 deps 满足的任务
        ├─ executeTask
        │    ├─ POST /send     → 将 prompt 发往 tmux session
        │    ├─ waitForReady   → 轮询 /status 直到 ready
        │    ├─ waitForTaskDone → 轮询 state 直到 task.status=done
        │    └─ waitForReady   → 等待 auto-continue 完成
        └─ 超时处理
             ├─ 回查 state → 若 done 则正常继续
             └─ 连续 2 次 → 标记 blocked，跳过
```

---

## 核心常量

| 常量 | 值 | 说明 |
|------|------|------|
| `SERVER_PORT` | 8787 | HTTP Session Server 端口 |
| `POLL_INTERVAL` | 2000ms | 状态轮询间隔 |
| `READY_TIMEOUT` | 300000ms (5min) | ready/waitForTaskDone 超时 |

---

## 函数清单

### 导出函数

| 函数 | 说明 |
|------|------|
| `runCommand(task, options)` | 主入口，编排完整执行流程 |

### 任务循环

| 函数 | 说明 |
|------|------|
| `runLoop(projectRoot)` | 主循环：遍历任务、调用 executeTask、处理超时重试 |
| `executeTask(prompt, taskId, projectRoot)` | 单任务：/send → waitForReady → waitForTaskDone → waitForReady |
| `checkTaskDone(taskId, projectRoot)` | 读 state.json 检查任务是否 done |
| `waitForTaskDone(taskId, projectRoot)` | 轮询 state.json 最多 60s，等待任务完成 |

### HTTP 通信

| 函数 | 说明 |
|------|------|
| `httpPost(url, body)` | 原生 `http.request` POST，返回 raw string |
| `httpPostJson(url, body)` | 调用 httpPost + JSON.parse |
| `getStatus()` | GET `/status`，返回状态对象或 false |

### 决策处理

| 函数 | 说明 |
|------|------|
| `handleDecision(d)` | 分发三种决策类型：AskUserQuestion / choice / text |
| `autoSelect(decision)` | 5 秒超时后自动选第一项 |

### 环境管理

| 函数 | 说明 |
|------|------|
| `ensureServer(paths, projectRoot)` | kill 旧进程 → spawn node server → 轮询最多 30 次等待就绪 |
| `ensureSession(paths, projectRoot)` | kill 旧 session → 执行 bootstrap.sh |
| `checkServer()` | GET /status 检查是否 ready |
| `waitForReady()` | 轮询 /status，处理 decisionPending，最多 5 分钟 |
| `doCleanup()` | 清理 tmux session + 释放 8787 端口 |

---

## HTTP API 交互

| 端点 | 方法 | 调用位置 | 说明 |
|------|------|---------|------|
| `/status` | GET | getStatus, checkServer, waitForReady | 返回 `{ state, decisionPending }` |
| `/send` | POST | executeTask | `{ text: prompt }`，发送到 tmux session |
| `/respond` | POST | handleDecision | `{ value }`，回应 AI 提问 |

---

## 状态机感知

`waitForReady` 通过轮询 `/status` 感知 Session Server 状态转换：

| status.state | 含义 | 行为 |
|-------------|------|------|
| `ready` | CC 空闲 | 返回，继续下一步 |
| `busy` | CC 处理中 | 继续轮询 |
| `decisionPending` | AI 需要决策 | 调用 handleDecision 后继续轮询 |

---

## 超时与重试策略

| 场景 | 行为 |
|------|------|
| `/send` 失败 | 返回 `'timeout'`，不阻塞流程 |
| `executeTask` 超时（5min） | catch 后回查 state，若 done 则返回 `'ok'` |
| 回查 state 仍未 done | 返回 `'timeout'` |
| 超时后重读 state 发现 done | `consecutiveTimeouts` 归零，正常继续 |
| 连续 2 次超时 | 标记 blocked，`consecutiveTimeouts` 归零 |

---

## 依赖

| 模块 | 用途 |
|------|------|
| `node:child_process` (`spawn`, `execSync`) | 启动 server、bootstrap、清理 tmux/端口 |
| `node:http` | HTTP 请求到 Session Server |
| `node:readline` | 交互式决策输入（choice/text） |
| `./paths.js` (`getPaths`) | 获取 server 路径、bootstrap 路径、projectRoot |
| `./state.js` (`loadState`, `findNextTask`) | 读取任务列表、查找下一任务 |
| `./auto-selector.js` (`autoSelect`) | AskUserQuestion 自动选择 |
| `process.env.CC_SESSION` | tmux session 名称（默认 `cc`） |
