# awf run — 需求文档

## 功能描述

`awf run` 是 AI Workflow Framework 的执行引擎。它启动 HTTP Session Server + tmux session，读取 `.awf/state.json` 中所有 pending 任务，按 `loadRunConfig` 分两条路径驱动 Claude Code 执行：

- **单 agent（默认，`run.agents.max === 1`）** → `runLoop`（`src/cli/run.js`）：逐任务逐阶段串行执行，直至全部完成或进入 FINISH 状态。
- **多 agent（`run.agents.max > 1`）** → `runBatchLoop`（`src/cli/run-batch.js`）：CLI 拥有调度权，滑动窗口 + 就绪池 + 四级配额 + plannedFiles 冲突过滤，后台并行派生子 Agent 执行。

### 执行流程

```
runCommand
  ├─ 1. 加载 state.json（不存在则退出）
  ├─ 2. 注册 Ctrl-C 清理（tmux kill-session + 释放端口）
  ├─ 3. startSession
  │    ├─ installProjectMcp → 确保项目级 .mcp.json（MCP 工具可用的必要条件）
  │    ├─ ensureServer     → 启动 HTTP Session Server（node src/server/server.cjs）
  │    ├─ writeRunSettings → 写 .awf/run-settings.json（crossSessionInbound: accept + statusLine）
  │    └─ ensureSession    → 执行 bootstrap.sh 创建 tmux session
  ├─ 4. open dashboard → 浏览器打开 http://localhost:8787
  └─ 5. 分流（loadRunConfig 读 .awf/config.json 的 run.agents）
       ├─ run.agents.max > 1 → runBatchLoop（src/cli/run-batch.js，滑动窗口）
       └─ 否则               → runLoop（原阶段链，src/cli/run.js）
```

单 agent `runLoop` 阶段链：

```
runLoop
  ├─ findNextTask → 取下一个 pending 且 deps 满足的任务
  ├─ maybeCompactContext → 任务前上下文压缩检查（两层：CLI 实测过滤 / AI 判断）
  ├─ executeTask
  │    ├─ POST /send     → 将 prompt 发往 tmux session
  │    ├─ waitForReady   → 轮询 /status 直到 ready（期间处理决策）
  │    └─ settleTask     → 收尾协商：任务未 done 则补发 wrapup/settle 追问，最多 MAX_SETTLE_ROUNDS 轮
  └─ 超时处理
       ├─ 回查 state → 若 done 则正常继续
       └─ 连续 2 次 → 标记 blocked，跳过
```

多 agent `runBatchLoop` 滑动窗口调度：

```
runBatchLoop
  ├─ dispatcher（send / sendRaw）
  │    └─ subagentDispatch → 生成「派生后台子 Agent 执行 task」指令 → POST /send 注入主会话
  ├─ runScheduler（src/cli/scheduler.js）
  │    ├─ 就绪池（peekReadyTasks：pending 且 deps done）
  │    ├─ 补位循环：pickFromPool → 配额 + plannedFiles 冲突 + 独占/保守串行过滤 → 派发
  │    ├─ waitAnyDone → 轮询 state 等至少一个运行中任务完成（容忍延迟）
  │    │    ├─ 落账失败补发（subagent-failed.jsonl → SendMessage 恢复，上限 RESEND_MAX）
  │    │    └─ 决策上抛检测（subagent-needs-input.jsonl → 标记挂起，暂停补位）
  │    └─ 池刷新：落账后重读 state，把新就绪任务加入池 + 重算 scope
  └─ backupState → .awf/versions/
```

---

## 核心常量

| 常量 | 值 | 说明 | 来源 |
|------|------|------|------|
| `SERVER_PORT` | 8787 | HTTP Session Server 端口 | `src/lib/session/client.js` |
| `POLL_INTERVAL` | 2000ms | 单 agent ready 轮询间隔 | `src/lib/session/client.js` |
| `READY_TIMEOUT` | 300000ms (5min) | ready / waitForTaskDone 超时 | `src/lib/session/client.js` |
| `DEFAULT_TIMEOUT_MS` | 5000ms | AskUserQuestion 自动选择等待 | `src/lib/session/client.js` |
| `MAX_SETTLE_ROUNDS` | 3 | 单 agent 收尾协商追问最大轮数 | `src/cli/run.js` |
| `POLL_MS` | 2000ms | 多 agent 完成感知轮询间隔 | `src/cli/run-batch.js` |
| `WAIT_TIMEOUT_MS` | 900000ms (15min) | 多 agent 单轮等待上限，超时中断暴露问题 | `src/cli/run-batch.js` |
| `RESEND_MAX` | 2 | 单个子 Agent 落账失败补发上限 | `src/cli/run-batch.js` |

---

## 函数清单

### 导出函数

| 函数 | 说明 |
|------|------|
| `runCommand(task, options)` | 主入口，启动环境后按 `loadRunConfig` 单/多 agent 分流 |

### 环境管理（run.js）

| 函数 | 说明 |
|------|------|
| `startSession({serverScript, bootstrapScript, projectRoot, workDir, sessionName})` | 组装环境：installProjectMcp → ensureServer → writeRunSettings → ensureSession |
| `ensureServer(serverScript, projectRoot, workDir)` | kill 旧进程 → spawn node server → 轮询最多 30 次等待就绪 |
| `ensureSession(bootstrapScript, workDir, sessionName)` | kill 旧 session → 执行 bootstrap.sh |
| `writeRunSettings(workDir, pkgRoot)` | 写 `.awf/run-settings.json`：`crossSessionInbound: accept` + statusLine（实测上下文占用写 `.awf/context/usage.json`） |

### 任务循环（单 agent，run.js）

| 函数 | 说明 |
|------|------|
| `runLoop(projectRoot)` | 主循环：遍历任务、调用 executeTask、处理超时重试 |
| `executeTask(prompt, taskId, projectRoot)` | 单任务：/send → waitForReady → settleTask |
| `settleTask(taskId, projectRoot)` | 收尾协商：未 done 补发 wrapup/settle 追问，最多 `MAX_SETTLE_ROUNDS` 轮 |
| `sendPrompt(text)` | 发送 prompt 并等待 ready；超时忽略 |
| `checkTaskDone(taskId, projectRoot)` | 读 state.json 检查任务是否 done |
| `getTaskStatus(taskId, projectRoot)` | 读指定任务 status（pending/active/done/blocked） |
| `markTaskBlocked(taskId, projectRoot)` | 编排器仲裁：标记 blocked（使 findNextTask 跳过） |
| `maybeCompactContext(taskPrompt, taskIndex, projectRoot)` | 任务前上下文压缩检查：CLI 实测过滤 → AI 判断 → 压缩（/clear + 快照注入） |

### 滑动窗口调度（多 agent，run-batch.js + scheduler.js）

| 函数 | 文件 | 说明 |
|------|------|------|
| `runBatchLoop(projectRoot, cfg)` | run-batch.js | 滑动窗口执行入口（max>1 时由 runCommand 动态 import） |
| `makeWaitAnyDone(projectRoot, dispatcher)` | run-batch.js | 完成感知：轮询 state + 落账补发 + 决策上抛挂起；返回 `waitAnyDone` 函数 |
| `runScheduler({projectRoot, cfg, dispatcher, waitAnyDone, onTaskComplete})` | scheduler.js | 滑动窗口主循环：补位 → 等待完成 → 释放 → 池刷新 |
| `makeQuota(cfg)` | scheduler.js | 归一化四级配额（硬上限，缺省 1） |
| `makeRunning()` | scheduler.js | 运行中集合：占用/配额判断/释放，按功能/模块计数 |
| `pickFromPool(pool, running, quota, scope)` | scheduler.js | 从池取第一个满足「配额 + 文件冲突 + 独占/保守串行」约束的任务 |
| `filesConflictWithRunning(task, running)` | scheduler.js | 任务 plannedFiles 与运行中集合冲突判定 |

### HTTP 通信

| 函数 | 说明 |
|------|------|
| `httpPost(url, body)` | 原生 `http.request` POST，返回 raw string |
| `httpPostJson(url, body)` | 调用 httpPost + JSON.parse |
| `getStatus()` | GET `/status`，返回状态对象或 false |
| `sendCmd(cmd)` | POST `/cmd`，发送 slash command |
| `getContextReady()` | GET `/context-ready`，一次性消费上下文就绪标记 |

### 决策处理

| 函数 | 说明 |
|------|------|
| `handleDecision(d)` | 分发三种决策类型：AskUserQuestion（自动选 5s 默认第一项）/ choice（readline）/ text（readline） |
| `autoSelect(decision)` | 5 秒超时后自动选第一项 |

---

## 滑动窗口调度（多 agent）

CLI 拥有调度权（`src/cli/scheduler.js`），与单 agent `runLoop` 完全隔离——仅 `run.agents.max > 1` 时由 `runCommand` 动态 import 加载。

### 就绪池

`peekReadyTasks(state)`（`src/lib/state.js`）返回所有就绪任务：`status === 'pending'` 且 deps 全部 done，保持 state 原始顺序。池子按实际就绪任务填充，不足不凑满。

### 四级配额

`makeQuota(cfg)` 从 `.awf/config.json` 的 `run.agents` 归一化（非法/缺省回落 1）：

| 配额 | 含义 |
|------|------|
| `max` | 总并发子 Agent 数 |
| `maxModules` | 同时活跃模块数 |
| `maxPerModule` | 每模块并发任务数 |
| `maxPerFeature` | 每功能并发任务数 |

**配额语义：硬上限，非目标**——池子按实际就绪任务填充，不足不凑满。

### 作用域归属

`buildScopeIndex(tasks)`（`src/lib/state.js`）构建 `taskId → { featureId, moduleId }`：
- review gate 的 deps 内任务归该功能（`featureId` = review gate id）
- test gate 的 deps 内任务归该模块（`moduleId` = test gate id）
- doc gate（deps=全部任务）不参与，避免污染模块归属

### plannedFiles 冲突过滤

- `filesConflict(a, b)`（`src/lib/state.js`）：两个路径精确相同，或一方是另一方的目录前缀（`src/util/` vs `src/util/math.js`）。
- `filesConflictWithRunning`（scheduler.js）：任务的 plannedFiles 与运行中所有任务 plannedFiles 展平比对，冲突则不并行。

### 独占 / 保守串行

- **独占任务**：`EXCLUSIVE_KINDS = new Set(['doc', 'commit'])`（`src/lib/state.js`）——不与任何任务并行；运行中有独占任务时禁止派发任何其他任务。
- **保守串行**：缺失 plannedFiles 且非 `review` 的任务无法判定冲突面，仅在无其他运行中时单独派发；`review` 只读审查天然无写冲突，无需文件声明即可并行。

### 补位循环

`runScheduler` 主循环：

```
while (true)
  1. 补位（非挂起时）：pickFromPool 循环派发，直到配额满 / 池无可派 / 文件冲突 / 独占或保守串行阻塞
  2. running.size === 0 → 结束（池空或无可派）
  3. waitAnyDone(running) → 等至少一个完成（容忍延迟，不依赖即时信号）
  4. 释放完成的 running 任务（按 scope 递减 perModule/perFeature/activeModules 计数）
  5. `onTaskComplete(id, task)`：门禁闭环钩子（`src/cli/gate-fix.js`）——阻塞完成时派生修复 / 回退复审（await，须在池刷新前落盘）
  6. 池刷新：重读 state，新就绪任务（依赖链/门禁转换）加入池 + 重算 scope
```

### 门禁闭环（fail → 派生修复 → 复审）

门禁任务（kind=review/test）输出结构化 verdict（`exec.verdict`，见 awf-worker.md / awf-run-review / awf-run-test 技能）：

```
门禁完成（RESULT status=failed + verdict）
  → settleSubagent 落账（status=blocked + exec.verdict）
  → onTaskComplete → handleGateCompletion（gate-fix.js）
      → spawnGateFixTask（state.js）：
          - 派生修复任务 ${id}-F${n}（kind=dev，deps=门禁原deps，plannedFiles=[] 保守串行）
          - 门禁回退 pending，deps 追加修复任务，exec.recheck++
      → saveState → 池刷新自动纳入修复任务
  → 修复 done → 门禁就绪 → 复审 → pass→done / fail→再派生（上限 MAX_RECHECK=3）
```

- 无 verdict 的门禁 blocked 不派生（视为旧协议 / 卡住，需人工介入）。
- 轮次达上限保持 blocked，CLI 告警「需人工介入」。
- 单 agent `runLoop` 同构生效（`src/cli/run.js`）：执行完门禁任务后检测 blocked + verdict 非 pass → 同一 `handleGateCompletion`。

---

## 落账链路（多 agent）

子 Agent 完成由 **SubagentStop hook 驱动**（用户定稿），不依赖主 Agent 收尾：

```
子 Agent 完成
  → 输出固定格式 `RESULT: {json}`（最后一行，json 含 taskId/status/result/files/commits）
  → SubagentStop hook（plugin/core/hooks/hooks.json）→ POST /hook?event=SubagentStop
  → server 解析 last_assistant_message（src/server/server.cjs parseSubagentResult）
  → settleSubagent 原子写 state（awf_task_complete：一次提交 status + exec.result/files + commits）
```

- 落账校验：RESULT taskId 不存在 → **可恢复拒绝**（写失败记录）；指向已完成/已阻塞任务 → **良性拒绝**（`already done/blocked（RESULT taskId 可能错写）`，`recoverable:false`，不写失败记录，防补发循环）。两者均防"假成功"错标已有任务。
- **落账失败**（可恢复）→ 写 `.awf/logs/subagent-failed.jsonl`（含 agentId/reason）→ CLI `resendPending` 补发：SendMessage 恢复该子 Agent，要求重新以 `RESULT: {...}` 输出正确结果，上限 `RESEND_MAX`。
- **未跟踪 SubagentStop**（无 SubagentStart 的幽灵 Stop）→ 跳过，不落账、不写失败记录（否则补发到不存在的 agent，反复等待）。
- **status 终态映射**：`failed`/`fail`（协议允许）落账映射为 `blocked`（调度只认 blocked 为终态）。
- **每 run 清空驱动日志**：server 启动时清空 `subagent-failed.jsonl`/`subagent-needs-input.jsonl`；CLI 起始游标取日志已有最大 ts，双保险防跨 run 残留重放。
- **完成感知**：CLI `waitAnyDone` 轮询 state（`POLL_MS` 间隔，`WAIT_TIMEOUT_MS` 超时中断），检测运行中任务 done/blocked。

---

## 决策上抛（多 agent）

子 Agent 需要决策时不自行猜测：

```
子 Agent 输出 `NEEDS_INPUT: {json}`（最后一行，含 taskId/question/options/context）
  → SubagentStop hook → server 解析（parseSubagentNeedsInput）
  → 写 .awf/logs/subagent-needs-input.jsonl（不落账，任务保持等待）
  → CLI checkNeedsInput 标记 pendingNeeds（暂停补位）
  → 主 Agent 原生 AskUserQuestion（question/options 用子 Agent 给出的，M5）
  → 用户作答 → /respond → 主 Agent 用 SendMessage 恢复该子 Agent 告知答案，让它继续完成
  → 决策解决 → 恢复补位
```

- 等待循环中 CLI 检测 `decisionPending` → `handleDecision` 处理（处理期间阻塞 = 调度器不返回 = 暂停补位）。
- 挂起判定：有待解决 NEEDS_INPUT 且主 Agent 正在 AskUserQuestion → `suspended`，不补位。

---

## HTTP API 交互

| 端点 | 方法 | 调用位置 | 说明 |
|------|------|---------|------|
| `/status` | GET | getStatus, checkServer, waitForReady | 返回 `{ state, decisionPending }` |
| `/send` | POST | executeTask, dispatcher.send | `{ text: prompt }`，发送到 tmux session |
| `/cmd` | POST | sendCmd | `{ cmd }`，发送 slash command |
| `/respond` | POST | handleDecision | `{ value }`，回应 AI 提问 |
| `/hook` | POST | SubagentStop 等 | `{ event, body }`，hooks 事件上报（含子 Agent RESULT/NEEDS_INPUT） |
| `/context-ready` | GET | getContextReady | 一次性消费上下文就绪标记 |

---

## 执行提示词由插件声明

所有执行期提示词由插件声明（`plugin/plugin-code/prompts.json`），CLI 经 `src/lib/plugin-bridge.js`（插件边界唯一模块）只读取模板并填充占位符，不写死插件命令字符串：

| 函数（plugin-bridge.js） | 模板 key | 用途 |
|------|------|------|
| `subagentDispatch({taskId, taskPrompt})` | `subagent-dispatch` | 滑动窗口单任务派发：主 Agent 用插件内置 `ai-workflow-core:awf-worker` 派生后台子 Agent；约束身份化 + 决策上抛时主 Agent AskUserQuestion |
| `taskWrapup(taskId)` | `task-wrapup` | 任务未 done 时补发收尾 prompt（按真实状态收尾，未完成不标 done） |
| `taskSettle(taskId)` | `task-settle` | 收尾追问：完成 / 继续 / 卡住 三选一 |
| `contextCheck(usage)` | `context-check` | 任务前上下文压缩检查（AI 判断，输出 `AWF_CONTEXT_OK` / `AWF_CONTEXT_READY`） |

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
| `/send` 失败 | 单 agent：返回 `'timeout'`，不阻塞流程；多 agent：抛错（派发失败暴露） |
| `executeTask` 超时（5min） | catch 后回查 state，若 done 则返回 `'ok'` |
| 回查 state 仍未 done | 返回 `'timeout'` |
| 超时后重读 state 发现 done | `consecutiveTimeouts` 归零，正常继续 |
| 连续 2 次超时（单 agent） | 标记 blocked，`consecutiveTimeouts` 归零 |
| `settleTask` 多轮追问仍未完成 | 标记 blocked 并跳过（返回 `'stuck'`） |
| 子 Agent 落账失败（多 agent） | 补发要求重出 RESULT，上限 `RESEND_MAX` 次 |
| `waitAnyDone` 单轮等待超时（15min） | 抛错中断，暴露问题 |

---

## 依赖

| 模块 | 用途 |
|------|------|
| `node:child_process` (`spawn`, `execSync`) | 启动 server、bootstrap、清理 tmux/端口 |
| `node:http` | HTTP 请求到 Session Server |
| `node:readline` | 交互式决策输入（choice/text） |
| `./paths.js` (`getPaths`) | 获取 server 路径、bootstrap 路径、projectRoot |
| `./state.js` (`loadState`, `findNextTask`, `peekReadyTasks`, `buildScopeIndex`, `filesConflict`, `EXCLUSIVE_KINDS`, `backupState`) | 任务查询、作用域归属、文件冲突、快照备份 |
| `./run-config.js` (`loadRunConfig`) | 读 `.awf/config.json` 的 `run.agents` 四级配额 |
| `./plugin-bridge.js` (`subagentDispatch`, `taskWrapup`, `taskSettle`, `contextCheck`) | 插件声明提示词读取与占位符填充 |
| `./scheduler.js` (`runScheduler`) | 滑动窗口调度器（纯逻辑） |
| `./run-batch.js` (`runBatchLoop`) | 滑动窗口集成（派发 / 完成感知 / 补发 / 决策挂起） |
| `../lib/session/client.js` (`autoSelect`, `waitForReady`) | AskUserQuestion 自动选择、就绪等待 |
| `./profile.js` (`installProjectMcp`) | 项目级 .mcp.json 幂等合并 |
| `process.env.CC_SESSION` | tmux session 名称（默认 `cc`） |
| `.awf/logs/subagent-failed.jsonl` | 落账失败记录（CLI 据此补发） |
| `.awf/logs/subagent-needs-input.jsonl` | 决策上抛记录（CLI 据此暂停补位） |
