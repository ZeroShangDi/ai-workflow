# run 域（server 侧编排宿主） — 功能文档

> 对应 WBS：W3-003（server 控制平面分层 + **run 域迁入**）；相关任务：T1-105（宿主基座）/ T1-062（门禁归位）/ T1-071（per-run 槽）/ T1-091（事件订阅）/ T1-108（pause 闩锁）/ T1-111（闩锁放行）
> 源码：`src/server/run-host.cjs`、`run-driver.cjs`、`run-scheduler.js`、`batch-transport.cjs`、`task-channel.cjs`、`gate-fix.js`、`run-slot.cjs`、`project-context.cjs`；`src/lib/state.js`、`src/lib/pause.js`、`src/lib/gate-loop.cjs`

> 范围声明：本文只讲 **server 侧的 run 域**（CLI 提交 run 之前的启动/装配流程见 `docs/features/run.md`）。run 域的输入是「一个已由 CLI 提交的 run」，输出是「state.json 中任务被结算 + 一串 run/task 事件」。

## 功能描述

v0.2.0 把 run 编排（任务选择、阶段推进、多 agent 调度、门禁闭环、收尾归档）从 CLI 进程搬进了常驻 Session Server。承接这份职责的模块集合即 **run 域**：

- **宿主拥有调度权**：进程内宿主 `createRunHost()`（`src/server/run-host.cjs:102`）是唯一调度者。CLI 只做「提交 run → 订阅事件/轮询状态 → 应答 → 收尾」，不再持有编排循环（`src/server/run-host.cjs:5-7`）。
- **单槽常驻**：一个宿主同一时刻只驱动一个 run（`activeRunId` 单写者，`run-host.cjs:127`；重复/并发 submit 返回 409，`run-host.cjs:403-409`）。一个 Session Server 进程内每项目一份宿主（per `ProjectCtx` 的 `runHost` 装配位，`project-context.cjs:124`），多项目互不串（`two-project-smoke.test.js`）。
- **子 Agent 无调度权**：多 agent 下由宿主派发；执行单元 `awf-worker` 禁写 state、禁提问，只回吐最后一行 `RESULT` / `NEEDS_INPUT`（`plugin/core/agents/awf-worker.md:12-14`）。落账由主机侧（`SubagentStop` hook → `settleSubagent`，`server.cjs:113`）原子完成。
- **门禁闭环收敛到同一锚点**：无论单 agent 还是多 agent，`blocked + verdict 非 pass` 都经 `run-driver.gateCompletionHook` → `gate-fix.handleGateCompletion` 派生修复任务（`run-host.cjs:213-221`）。

架构上，宿主自身 **零 import 引擎层逻辑**：state 原语、阶段链、门禁处理器、scheduler、单任务 executor、batch 传输全部经 `createRunHost(opts)` 注入（`run-host.cjs:88-101`；装配方见 `server.cjs:622-681`）。这让宿主可单测（`tests/unit/run-host.test.js`）且不绑定 CLI/插件的具体实现。

## 执行流程

### 1. 装配与提交

```
CLI POST /run/submit {runId?, mode?}
  → bootstrapRunHost(pcx)                        server.cjs:622（惰性单例，失败记录 runHostBootErr 不抛）
      装 stateApi（loadState/saveState/markTaskActive/findNextTask/setWorkflowMode/backupState）
      cfg = loadRunConfig(projectRoot)           run-config.js:36（.awf/config.json 的 run.*）
      scheduler = runScheduler；chain = run-driver.cjs
      gateFix = gate-fix.handleGateCompletion
      executor = defaultSingleExecutor(pcx)      server.cjs:503
      batch    = batchTransportFor(pcx, stateApi) server.cjs:731
    → createRunHost({...}).start()               run-host.cjs:662-672
  → host.submitRun({runId, mode})                run-host.cjs:398
      校验：hostState!=='stopped'、runId 未在 queued/running、无 activeRunId
      createRunRecord（mode = spec.mode || (cfg.agents.max>1 ? 'batch' : 'single')）
      emit run.submitted → activeRunId = runId
      setImmediate(drive(run))  ← 异步推进，submit 立即返回 202 {ok,runId,mode}
```

`mode` 判定：显式 `spec.mode`（CLI `--multi-agent`）优先，否则按 `cfg.agents.max > 1`（`run-host.cjs:138-140, 168-169`）。测试可经全局 `__CC_RUN_HOST_DEPS__` 整体覆盖装配（`server.cjs:625-640`）。

### 2. 驱动（`drive`，`run-host.cjs:336`）

```
emit run.started → setRunStatus(running)
若 state.mode !== 'run' 且有 setWorkflowMode：置 run，记 changedMode=true   run-host.cjs:343-346
  ├─ run.mode === 'batch' → driveBatch(run)   run-host.cjs:304
  └─ 否则                 → driveSingle(run)  run-host.cjs:243
backupState(projectRoot)                        run-host.cjs:352（FINISH 收尾版本归档）
setRunStatus('done') + emit run.stopped
finally：changedMode 时复位 mode=idle；activeRunId=null；stopping=false   run-host.cjs:362-368
异常：setRunStatus('error') + emit run.error + run.stopped
```

run 状态机：`queued → running → done | error | stopped`（`RUN_TRANSITIONS`，`run-host.cjs:34-37`，非法迁移抛错 `assertRunTransition:58`）。

### 3. 单 agent 路径（`driveSingle`，`run-host.cjs:243`）

逐任务顺序推进，直到 `state.currentState === 'FINISH'` 或无就绪任务：

1. 读 state，阶段变化（`s.currentState`）时 emit `run.phase`；`FINISH` 直接 break（`run-host.cjs:250-255`）。
2. `stateApi.findNextTask(s)` 取下一个 pending 且 deps 全 done 的任务（`state.js:83`）；无 → break。
3. 步数保险丝：`steps > MAX_TASK_STEPS(5000)` 抛错，防死循环（`run-host.cjs:258-260`）。
4. **阶段链标注**：`chain.decideChain(task)` 得 `{chain, stages}`，写入 `run.currentChain/currentStage` 快照并随 `task.started` 事件发出（`run-host.cjs:266-280`）。
5. `markTaskActive` 置 active → `executor.runTask({runId, projectRoot, taskId, task, taskIndex, chain})`。
6. executor 返回后 `settleTaskCompletion` 复读真实 state（不信返回快照）：done 发 `task.done`，blocked 发 `task.blocked` 并过门禁锚点（`run-host.cjs:224-240`）。

**阶段链只做「标注」，不做阶段机驱动**：宿主只把 `decideChain` 的链记进快照/事件，任务仍由 executor 用**一条 prompt** 完成；`run-driver` 的 `nextStage`/`assertStage` 在 run 域内无调用点（仅 `tests/unit/run-driver.test.js` 覆盖）。链语义见 `run-driver.cjs:14-42`：simple `DEV→COMMIT`、medium `DEV→TEST→COMMIT`、complex `DEV→DOCS→REVIEW→TEST→COMMIT`；门禁/文档/提交类（review/test/doc/commit）强制走 simple 保守链（`SPECIAL_KIND_CHAIN:21`）；dev 类按 `plannedFiles*2 + deps + constraints` 打分分级（`classifyComplexity:24`：≥8 complex，≥3 medium，否则 simple）。

**超时判据 = 无变化窗口**（`server.cjs:542-554`，`defaultSingleExecutor`）：

```
每 500ms 轮询：task.status done/blocked → 返回
  decisionPending 未答        → idleSince=null（等人工不计时）
  pcx.state === 'busy'        → idleSince=null（CC 仍在推进 → 重置窗口）
  否则 idleSince 起算；now-idleSince >= READY_TIMEOUT_MS → break 进入收尾协商
```

即 **CC busy 不计时**；只有 CC 已 idle 且持续无变化到阈值，才判「本任务没落账」，交给 `task-channel.settleTask` 协商（wrapup → 追问 → 必要时标 blocked），而不是直接抛超时。注意这里的窗口阈值复用了 `READY_TIMEOUT_MS`（缺省 **120s**，`server.cjs:47`），与多 agent 侧的 15min 窗口不是同一个常量。

### 4. 多 agent 路径（`driveBatch` → `runScheduler` → `batch-transport`）

`driveBatch`（`run-host.cjs:304`）把宿主的三件事接到调度器：

- `dispatcher.send(task)`：写当前任务快照 + emit `task.started`（含 chain）→ `batch.dispatch(task)`（`run-host.cjs:313-325`）。
- `waitAnyDone(running)` → `batch.waitAnyDone(running)`。
- `onTaskComplete(id, snapshot)` → `settleTaskCompletion`（同一收账 + 门禁锚点）。

**滑动窗口纯逻辑**（`run-scheduler.js:120`）：

```
quota = makeQuota(cfg)                 四级硬上限：max / maxModules / maxPerModule / maxPerFeature（缺省 1）
pool  = peekReadyTasks(state)          就绪池：pending 且 deps 全 done，保持 state 原始顺序（state.js:159）
while (true):
  if (!suspended) while (pick = pickFromPool(...)): dispatcher.send(pick); running.add; pool 移除; dispatched++
  if (running.size === 0) break        池空且无运行 → 结束
  { done, suspended } = await waitAnyDone(running)
  for id of done: running.remove; await onTaskComplete(id, task)   ← await：门禁同步改盘须在池刷新前完成
  池刷新：重读 state，把新增就绪任务（依赖链/门禁派生）加入池 + 重算 scope
```

派发筛选（`pickFromPool`，`run-scheduler.js:86`）：

| 约束 | 规则 | 依据 |
|------|------|------|
| 独占 | commit（`EXCLUSIVE_KINDS`，`state.js:92`）运行中 → 禁止派发任何任务；commit 自身也只允许独占派发（running.size===0） | `run-scheduler.js:81,88,96-99` |
| 保守串行 | 缺失 `plannedFiles` 且非 review 的任务 → 只允许单独派发 | `run-scheduler.js:95-99` |
| 四级配额 | `canOccupy`：max 总并发 / maxPerFeature / maxPerModule / maxModules 活跃模块 | `run-scheduler.js:54-60` |
| 文件冲突 | 与运行中任务 plannedFiles 冲突（相等或互为目录前缀，`state.js:134`）→ 跳过 | `run-scheduler.js:69-78,102` |

配额语义是**硬上限而非目标**——池子按实际就绪任务填充，不足不凑满（`run-scheduler.js:6`）。

**传输层**（`batch-transport.cjs:53`）：

- `dispatch(task)`（`:142`）：先过 pause 闩锁（带 `isSettled` 谓词，暂停期间若该任务已被别处结算则跳过派发）→ `prompts.subagentDispatch` 生成派发提示词 → `send` 注入主会话（主会话据此派生后台 `awf-worker`）→ `markActive`。
- `waitAnyDone(running)`（`:165`）：`POLL_MS=2000` 轮询。
  - pause 期间不计时（`waitWhilePaused()` 返回后把流逝时间补回 `lastChangeAt`，`:176-178`）。
  - 决策挂起（`decisionPending` 未答）→ 重置窗口、不补位（`:181-182`）。
  - `resendPending()`：读 `subagent-failed.jsonl` 新增记录 → 要求主会话用 SendMessage 恢复子 Agent 补 `RESULT`，单个 agentId 补发上限 `RESEND_MAX=2`（`:85-111`）。
  - `checkNeedsInput()`：读 `subagent-needs-input.jsonl` → `pendingNeeds` 置位（`:114-127`）。
  - **推进探测**（`:187-190`）：`isBusy() || 任务状态指纹变化 || 子 Agent 事件日志体积变化` 任一发生即重置 `lastChangeAt`。
  - 返回 `{done, suspended}`：done=已结算（done/blocked）的 taskId；`suspended = pendingNeeds.size>0 && done.length===0`（决策挂起时不补位）。
  - `now()-lastChangeAt >= idleTimeoutMs`（缺省 **15min**，env `CC_BATCH_IDLE_TIMEOUT_MS`）→ 抛「等待子 Agent 完成超时」，保留现场待 w-monitor（`:206-208`）。

`subagent-failed.jsonl` / `subagent-needs-input.jsonl` / `subagent-events.jsonl` 由 server 的 hook 侧写入（`logSubagentFailure:75` / `logSubagentNeedsInput:89` / `logSubagentEvent:66`），每次 run 启动清空前两者以避免跨 run 伪补发（`resetRunLogs:106`）。

### 5. 门禁闭环（verdict → 派生修复 → 回退复审）

```
任务 blocked → settleTaskCompletion → runGateHook
  → chain.gateCompletionHook(projectRoot,{handleGateCompletion})   run-driver.cjs:62（kinds=['review','test'] 过滤）
  → gate-fix.handleGateCompletion                                  gate-fix.js:30
      gateFixMeta(gate) 判定不可派生 → no-op                        state.js:251
        （非 review/test / 非 blocked / 无 verdict / verdict.level==='pass' / recheck>=MAX_RECHECK）
      buildFixTarget(gate) 由 verdict+architecture+报告路径生成修复目标   gate-loop.cjs:15
      gateFixPrompt({fixId,fixTarget}) 插件模板生成提示词               plugin-bridge.js:87
      spawnGateFixTask(state, gate, prompt) 纯 mutate：               state.js:274
        推入 fix 任务（kind=dev, status=pending, deps=复制门禁 deps, plannedFiles=[] → 保守串行）
        gate.status 回退 pending；gate.deps 追加 fixId；gate.exec.recheck++
      saveState
  → handled=true 时 emit gate.fix
```

复审轮次上限 `MAX_RECHECK=3`（`state.js:241`）：达上限后 `gateFixMeta` 返回 null，门禁保持 blocked 需人工介入（`gate-fix.js:48-50`）。闭环由单/多 agent 共用同一锚点，测试见 `tests/unit/run-host.test.js:176`（fail → `R1-F1` → 复审 pass）与 `tests/integration/run-host.test.js:266`（`/run/state/gate` 端点）。

### 6. pause 闩锁在各路径的落点

`waitWhilePaused`（`src/lib/pause.js:57`）比较 `state.mode === 'pause'`（`isWorkflowPaused:31`）；`PAUSE_POLL_MS=1000`。三条出口由返回值 `releasedBy` 区分：`null`（没暂停）、`'resumed'`（mode 恢复）、`'settled'`（等待期间 `isSettled()` 变真——目标任务已被别处结算，不必再等）。

| 路径 | 位置 | 是否带 `isSettled` | 行为 |
|------|------|--------------------|------|
| 单 agent 主任务派发 | `server.cjs:514-526`（`defaultSingleExecutor`） | ✔ `dispatch:<taskId>` | 暂停期间不派发；已结算则跳过派发并返回其状态 |
| 会话通道 send / 收尾协商 | `server.cjs:577`（send）、`task-channel.cjs:111-122`（每轮介入前） | ✔ `settle:<taskId>` | 暂停期间不注入收尾 prompt；已结算则直接返回，不挂死（T1-111） |
| 会话通道上下文检查 | `task-channel.cjs:168` → `send` 路径 | 经 send 的闩锁 | 同上 |
| 多 agent 派发 | `batch-transport.cjs:144-153` | ✔ `dispatch:<taskId>` | 暂停期间不派发；已结算则跳过 |
| 多 agent 完成感知 | `batch-transport.cjs:176-178` | ✘（无谓词） | 暂停期间不计时、不推进，恢复后从恢复点续算无变化窗口 |

可观测性：等待超 `PAUSE_ALERT_MS(30s)` 打一次告警（含项目根 + 阶段 label），之后每 `PAUSE_HEARTBEAT_MS(60s)` 一条心跳，放行一条日志（`pause.js:93-102`）。

### 7. 收尾

- **版本归档**：`drive` 在单/多 agent 驱动返回后调用 `stateApi.backupState`（`run-host.cjs:352`），把 state 快照到 `.awf/versions/<version>-<ts>.json`（`state.js:307`）。
- **mode 复位**：仅当 **本宿主**在本次 run 内把 mode 从非 run 置为 run 时，`finally` 才复位 `idle`（`run-host.cjs:341-346, 362-365`）。这是刻意的软边界（回归断言「宿主只在它自己改了 mode 时才复位」，`tests/regression/fullflow-regression.mjs:893-950`）。
- **run_interrupted 信号**：CLI 正常流程会先把 mode 置为 run，宿主因此 `changedMode=false`、收尾不复位 → 若 CLI 中途死亡，宿主仍按「常驻、不依赖 CLI 存活」继续驱动，mode 停在 `run`，这正是 w-monitor 判定 `run_interrupted` 的依据（`tests/regression/fullflow-regression.mjs:779, 950`；识别规则见 `plugin/core/commands/w-monitor.md:79-85`）。宿主内无 `run_interrupted` 字样——它是监控侧的判定标签，不是宿主状态。
- **停止**：`host.stop()` 置 `stopping=true` 与 `hostState='stopped'`，当前 run 在安全点（循环条件 `while(!stopping)`）收尾后不再驱动（`run-host.cjs:386-391`）。`server.stop()` 遍历所有项目上下文停宿主（`server.cjs:1431-1434`）。

### 8. 观测面

- `snapshot(runId)`：单 run 摘要（`summarize:486`：status/counts/currentTaskId/currentChain/currentStage…）或全部 run 列表（`run-host.cjs:423-430`）。
- `pollEvents({runId, afterSeq, limit})`：`afterSeq` 游标增量拉取（`run-host.cjs:436-450`），事件环上限 `EVENT_RING_CAP=10000`，超限从头部裁剪（`:147-151`），`seq` 单调不回退。
- `subscribe(fn)`：实时订阅，`emit` 后同步扇出（`:456`）；WS 升级路径 `/run/events` 用它推送（`server.cjs:1396-1415`）。
- `publish(type, payload, {runId})`：让宿主外代码（如决策闸门）也把事件推入环 + 订阅（`:466`）；`decision.required` 即经此推送（`server.cjs:267-283`）。
- HTTP 端点：`POST /run/submit`（202/409/503）、`GET /run/status`、`GET /run/events`、`WS /run/events`、`POST /run/state/{mode,task/active,gate,backup,apply}`（`server.cjs:1269-1362`）。

事件类型目录见 `HOST_EVENT_TYPES`（`run-host.cjs:46-56`）：`run.submitted/started/phase/stopped/error`、`task.started/done/blocked`、`gate.fix`；与 `src/lib/events.cjs` 的 `EVENT_DEFS` 重叠（`gate.fix`、`run.error`、`run.submitted` 为该环新增）。`emit` 会同时投递到可选 `bus`、`onEvent`、订阅者与 `logger`，单个回调异常被吞不影响宿主（`:152-159`）。

## 核心常量 / 配置

| 常量 | 值 | 说明 | 位置 |
|------|----|------|------|
| `EVENT_RING_CAP` | 10000 | 事件环上限，超限从头部裁剪 | run-host.cjs:40 |
| `MAX_TASK_STEPS` | 5000 | 单 agent 推进步数保险丝，超限中止 run | run-host.cjs:43 |
| `HOST_STATES` | idle/running/stopped | 宿主生命周期状态 | run-host.cjs:28 |
| `RUN_STATES` | queued/running/done/error/stopped | run 状态集合 | run-host.cjs:31 |
| `STAGE_CHAINS` | simple/medium/complex | 三条阶段链定义 | run-driver.cjs:14 |
| `SPECIAL_KIND_CHAIN` | review/test/doc/commit → simple | 门禁/文档/提交类走保守链 | run-driver.cjs:21 |
| `MAX_RECHECK` | 3 | 门禁复审轮次上限，超限保持 blocked | state.js:241 |
| `EXCLUSIVE_KINDS` | `{commit}` | 独占任务类型（改共享仓库状态） | state.js:92 |
| `POLL_MS` | 2000 | 多 agent 完成感知轮询间隔 | batch-transport.cjs:20 |
| `IDLE_TIMEOUT_MS` | 15min（env `CC_BATCH_IDLE_TIMEOUT_MS`） | **无变化窗口**上限，非任务总时长上限 | batch-transport.cjs:22 |
| `RESEND_MAX` | 2 | 单个子 Agent 落账补发上限 | batch-transport.cjs:24 |
| `MAX_SETTLE_ROUNDS` | 3 | 连续「CC 无产出」轮数上限 → 标 blocked | task-channel.cjs:22 |
| `SETTLE_MAX_TOTAL_ROUNDS` | 12 | 介入总轮数保险丝（防「一直产出又永不结算」） | task-channel.cjs:24 |
| `SETTLE_MIN_TURN_BYTES` | 4096 | 单轮 transcript 增量≥此值 → 判定「真在干活」，不计数 | task-channel.cjs:32 |
| `AWAIT_HUMAN_POLL_MS` | 2000 | 等人工决策应答轮询间隔（期间不计轮） | task-channel.cjs:26 |
| `COMPACTION` | `{enabled:true, skipFirstCount:1, checkThreshold:80}` | 上下文压缩检查：跳过首个任务；实测≥80% 或无实测才打扰 AI | task-channel.cjs:38 |
| `PAUSE_POLL_MS` | 1000 | pause 闩锁轮询间隔 | pause.js:4 |
| `PAUSE_ALERT_MS` | 30s（env `CC_PAUSE_ALERT_MS`） | 闩锁挂起告警阈值 | pause.js:7 |
| `PAUSE_HEARTBEAT_MS` | 60s（env `CC_PAUSE_HEARTBEAT_MS`） | 告警后心跳间隔 | pause.js:9 |
| `DEFAULT_AGENTS` | max/maxModules/maxPerModule/maxPerFeature = 1 | 四级配额缺省（= 单任务串行） | run-config.js:14 |

环境开关（run 域相关）：

| env | 缺省 | 用途 | 位置 |
|-----|------|------|------|
| `CC_BATCH_IDLE_TIMEOUT_MS` | 900000 | 多 agent 无变化窗口 | batch-transport.cjs:22 |
| `CC_READY_TIMEOUT_MS` | 120000 | 主会话 ready 等待 + **单 agent 无变化窗口** | server.cjs:47 |
| `CC_PAUSE_ALERT_MS` / `CC_PAUSE_HEARTBEAT_MS` | 30000 / 60000 | pause 闩锁可观测 | pause.js:7,9 |
| `CC_RUN_HOST_DEPS`（全局，非 env） | — | 测试整体覆盖宿主装配 | server.cjs:625 |

## 函数清单

| 函数 | 说明 | 位置 |
|------|------|------|
| `createRunHost(opts)` | 宿主工厂；全部依赖注入 | run-host.cjs:102 |
| `host.start/stop/submitRun/snapshot/pollEvents/subscribe/publish/reset` | 宿主公开面 | run-host.cjs:377-483 |
| `driveSingle(run)` | 单 agent 顺序驱动：选任务 → 标链 → executor → 结算 | run-host.cjs:243 |
| `driveBatch(run)` | 多 agent：跑注入的 runScheduler，挂门禁锚点 | run-host.cjs:304 |
| `drive(run)` | run 驱动器：置/复位 mode、分派单/多 agent、收尾 backupState | run-host.cjs:336 |
| `settleTaskCompletion(run,id,snapshot)` | 任务完成统一收账：复读 state → 事件/计数 → 门禁锚点 | run-host.cjs:224 |
| `runGateHook(run,id,task)` | 经 `gateCompletionHook` 收敛单/多 agent 门禁 | run-host.cjs:213 |
| `emit(type,runId,payload)` | 事件入环 + bus/onEvent/订阅者/logger 扇出 | run-host.cjs:143 |
| `countTasks(state)` | 由 state 计算 `{total,done,blocked,active,pending}` | run-host.cjs:71 |
| `decideChain(task)` | 选阶段链（SPECIAL_KIND 保守 → 否则复杂度分级） | run-driver.cjs:38 |
| `classifyComplexity(task)` | `plannedFiles*2+deps+constraints` 打分分级 | run-driver.cjs:24 |
| `gateCompletionHook(root,deps)` | 门禁完成钩子锚点（kinds 过滤后委托 gate-fix） | run-driver.cjs:62 |
| `nextStage/assertStage` | 链内推进/校验（run 域暂无调用点） | run-driver.cjs:45,52 |
| `runScheduler({...})` | 滑动窗口主循环（纯逻辑） | run-scheduler.js:120 |
| `pickFromPool(pool,running,quota,scope)` | 派发筛选：独占/保守串行/配额/文件冲突 | run-scheduler.js:86 |
| `makeQuota(cfg)` / `makeRunning()` | 四级配额归一化 / 运行中集合与配额判定 | run-scheduler.js:13,24 |
| `createBatchTransport(ports)` | 多 agent 传输：dispatch + waitAnyDone | batch-transport.cjs:53 |
| `createSessionChannel(ports)` | 会话通道：settleTask + maybeCompactContext | task-channel.cjs:49 |
| `settleTask(taskId)` | 收尾协商：按「有无产出」判定，非按轮数 | task-channel.cjs:83 |
| `maybeCompactContext(prompt,idx)` | 任务前两层上下文压缩检查 | task-channel.cjs:161 |
| `handleGateCompletion(root,id,task)` | 门禁闭环：派生修复 + 回退复审 | gate-fix.js:30 |
| `buildFixTarget(gate)` | verdict/architecture/报告 → 修复目标文案 | gate-loop.cjs:15 |
| `gateFixMeta/spawnGateFixTask` | 门禁派生元判定 / 纯 mutate 派生 | state.js:251,274 |
| `peekReadyTasks/selectReadyBatch/filesConflict/buildScopeIndex` | 就绪池 / 静态批选择 / 文件冲突 / 作用域索引 | state.js:159,178,134,100 |
| `waitWhilePaused(root,opts)` / `isWorkflowPaused` | pause 闩锁（三出口）/ 判定 | pause.js:57,31 |
| `createRunSlot(sid)` | per-sid 内存槽（ready/busy/decision/contextReady） | run-slot.cjs:12 |
| `createProjectContext/createProjectRegistry` | 每项目上下文容器 + 注册表 | project-context.cjs:41,137 |
| `defaultSingleExecutor(pcx)` / `sessionChannel(pcx)` / `batchTransportFor(pcx,api)` | server 侧装配方：把端口接到现场 | server.cjs:503,568,731 |
| `bootstrapRunHost(pcx)` | 每项目惰性装配宿主 | server.cjs:622 |

## 接口 / 依赖

| 模块 | 用途 | 位置 |
|------|------|------|
| `src/lib/state.js` | state 读写原语、就绪池/作用域/文件冲突、门禁派生、backupState | state.js |
| `src/lib/pause.js` | pause 闩锁（三条等待路径共用） | pause.js |
| `src/lib/gate-loop.cjs` | verdict → 修复目标纯规则 | gate-loop.cjs |
| `src/lib/plugin-bridge.js` | 提示词模板填充（taskWrapup/taskSettle/contextCheck/subagentDispatch/subagentResend/gateFixPrompt） | plugin-bridge.js |
| `src/lib/run-config.js` | 读 `.awf/config.json` 的 `run.*`（四级配额 + decision 开关） | run-config.js:36 |
| `src/lib/events.cjs` | 进程内事件总线 + 事件类型目录（宿主事件定义的重叠锚点） | events.cjs |
| `src/server/server.cjs` | 装配方 + HTTP/WS 端点；落账 hook 写 `subagent-*.jsonl` | server.cjs |
| `src/server/project-context.cjs` | 每项目 `ProjectCtx`（含 `runHost` 装配位、`subagent*Path`） | project-context.cjs |
| `src/server/run-slot.cjs` | per-sid 内存槽（ready/busy/decision/contextReady 隔离） | run-slot.cjs |
| `plugin/core/agents/awf-worker.md` | 子 Agent 身份/输出协议（RESULT / NEEDS_INPUT / verdict） | awf-worker.md |
| `plugin/plugin-code/prompts.json` | 派发/收尾/门禁提示词模板的声明源 | prompts.json |

## 验收标准

- [ ] 单 agent：`POST /run/submit` 后宿主按 deps 顺序逐任务派发（executor），run 推进到 `done`，事件含 `run.submitted/started/stopped` 与两个 `task.done`（`tests/integration/run-host.test.js:127`）。
- [ ] 阶段链被真实消费：`task.started` 事件的 `payload.chain` 非空；review 门禁任务走保守链 `['DEV','COMMIT']`（`tests/unit/run-host.test.js:153`）。
- [ ] 超时判据为无变化窗口：CC busy 期间不计时，仅 CC idle 且持续无变化到 `READY_TIMEOUT_MS` 才进收尾协商（`server.cjs:539-554`）。
- [ ] 收尾协商按「有无产出」判定：CC 一直在产出不判死；连续 `MAX_SETTLE_ROUNDS(3)` 轮无产出才标 blocked；等人工决策期间不计轮（`tests/unit/task-channel-settle.test.js`）。
- [ ] 多 agent：`cfg.agents.max>1` → 宿主 batch 模式，经 `subagentDispatch` 派发并等到全部落账，收尾复位 mode（`tests/integration/batch-host.test.js`）。
- [ ] 调度约束生效：`commit` 独占（不与任何任务并行）、缺 `plannedFiles` 非 review 任务保守串行、四级配额为硬上限、plannedFiles 冲突不复用并行批（`src/server/run-scheduler.js:86-106`）。
- [ ] 门禁闭环：review/test `blocked + verdict 非 pass` → 派生 `<id>-F<n>`（kind=dev, 保守串行）+ 门禁回退 `pending` + `recheck++`；达 `MAX_RECHECK(3)` 保持 blocked（`gate-fix.js:30`、`state.js:251-299`、`tests/unit/run-host.test.js:176`）。
- [ ] pause 闩锁在四条路径均生效（单 agent 派发 / 会话通道 / 多 agent 派发 / 多 agent 完成感知），且「目标任务已结算即放行」不挂死（`tests/unit/pause.test.js`、`tests/unit/task-channel-settle.test.js:142`）。
- [ ] 收尾：驱动结束 `backupState` 归档版本；仅当宿主本轮改过 mode 时复位 `idle`（`run-host.cjs:352-365`）。
- [ ] 观测面：`afterSeq` 增量轮询幂等（尾部无新事件时 `events: []` 且 `tailSeq==afterSeq`）；WS `/run/events` 实时推送归一事件 `{seq,runId,type,at,payload}`（`tests/integration/run-host.test.js:153-196`）。

## 已知边界（读码记录，非缺陷）

1. **阶段链只标注、不驱动**：run 域无 `nextStage/assertStage` 调用点，`DEV→TEST→COMMIT` 不会逐阶段推进或逐阶段产事件；任务粒度即执行粒度（`run-host.cjs:266-280`）。
2. **单/多 agent 超时窗口不对称**：单 agent 复用 `CC_READY_TIMEOUT_MS`（120s），多 agent 为 `CC_BATCH_IDLE_TIMEOUT_MS`（15min）；同一 run 在不同 mode 下判定松紧不同（`server.cjs:47` vs `batch-transport.cjs:22`）。
3. **mode 复位依赖「谁改的」**：CLI 先置 run 时宿主 `changedMode=false`，正常收尾也**不复位** mode——复位靠 CLI。CLI 若中途死亡则 mode 永停 run（这是 `run_interrupted` 的判定信号，同时意味着宿主自身不具备兜底复位）。
4. **无 verdict 的门禁不派生修复**：`gateFixMeta` 对「无 verdict」直接返回 null（视为旧协议/卡住），门禁停在 blocked 等人工（`state.js:255-256`）。
5. **宿主单槽**：同一宿主同时只驱动一个 run，第二次 submit 返回 409（`run-host.cjs:403-409`）；多 run 并行靠多项目 / 多 `sid` 槽隔离，而非同一宿主并发。
6. **batch 完成感知的 pause 闩锁无 `isSettled`**：暂停期间若任务被别处结算，`waitAnyDone` 不会立刻返回，需等恢复或下一轮轮询到 done（`batch-transport.cjs:176-178`）——不挂死，但无 `task-channel`/`dispatch` 的 settled 快路径。
