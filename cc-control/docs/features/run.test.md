# awf run — 测试用例

> 对应功能文档：docs/features/run.md
> 源码：src/cli/run.js（`runCommand`/`driveSingle`/`observeRun`/`waitSessionStarted`/`handleDecision`/`drainDecisionResume`）
> 测试文件：
> - `tests/unit/run.test.js`（CLI 薄化控制流，主套件）
> - `tests/unit/session-ready-wait.test.js`
> - `tests/unit/run-resume.test.js`
> - `tests/unit/run-client.test.js`
> - `tests/integration/run-host.test.js`（server run host + 真实 client 闭环）
> - `tests/e2e/run.e2e.test.js`（runCommand 端到端，mock tmux + 进程内 server）
> - `tests/regression/fullflow-regression.mjs`（真机全链路，`npm run test:real`，不进 `npm test`）

## 测试场景总览

| # | 场景 | 类别 | 文件 |
|---|------|------|------|
| TC1 | state.json 不存在 → exit(1) | 入口 | run.test.js |
| TC2 | 环境拉起 → 提交 run → 观察至 done → mode idle + 清理 | 主流程 | run.test.js |
| TC2b | 观察循环消费宿主事件并展示（task.done 渲染） | 主流程 | run.test.js |
| TC2c | run 提交失败 → 保留现场（不 idle、不清理） | 异常保留现场 | run.test.js |
| TC2d | 宿主以 error 收尾 → 保留现场（不标 idle） | 异常保留现场 | run.test.js |
| TC2e | 正常完成但 idle 写入失败 → 保留现场 | 异常保留现场 | run.test.js |
| TC2f | `--resume` 重启暂停中的 CLI → 保留 pause 闩锁（不切 run） | pause/恢复 | run.test.js |
| TC6 | SIGINT/SIGTERM 注册清理处理器 | 环境管理 | run.test.js |
| TC7 | server 已存在且属本项目 → 复用（不 spawn 不 kill） | 环境管理 | run.test.js |
| TC8 | 端口被其他项目 server 占用 → 复用（单 server 多项目，`?p` 路由） | 环境管理 | run.test.js |
| RC1 | `--resume` 且宿主有活跃 run → 挂接续观（不重复提交），收敛 done + idle | 重连 | run.test.js |
| RC2 | `--resume` 且宿主空闲 → 提交续跑 store 剩余任务 | 重连 | run.test.js |
| RC3 | `--attach` 且宿主有活跃 run → 挂接（不提交） | 重连 | run.test.js |
| RC4 | `--attach` 且宿主空闲 → 报错保留现场（不提交、不 idle） | 重连 | run.test.js |
| RC5 | fresh 却撞上宿主活跃 run → 防御性转挂接（不重复提交） | 重连 | run.test.js |
| RC6 | `--attach -R r1` → 挂接指定 run（不提交），收敛 done | 重连 | run.test.js |
| RC7 | `--attach -R 不存在 run` → 报错保留现场（不提交不 idle） | 重连 | run.test.js |
| SR1 | sessionSeq 增长 → 放行，且不补 Enter | 会话就绪 | session-ready-wait.test.js |
| SR2 | 始终未收到 SessionStart → 超时返回 false（告警放行，不硬失败） | 会话就绪 | session-ready-wait.test.js |
| SR3 | 等待期间周期性补 Enter（兜信任弹窗） | 会话就绪 | session-ready-wait.test.js |
| SR4 | 拿不到 status（服务不可达）不抛，按未就绪处理 | 会话就绪 | session-ready-wait.test.js |
| DR1 | 探测到 decisionResume → 注入续跑消息（含 answer）→ 再等待；无 resume 后结束 | 决策中继 | run-resume.test.js |
| DR2 | gate off / 无决策：decisionResume 恒 null → 零注入、零等待 | 决策中继 | run-resume.test.js |
| DR3 | 多次决策依次续跑（多轮 resume），直到耗尽 | 决策中继 | run-resume.test.js |
| DR4 | 续跑注入失败 → 停止续跑（不静默死循环） | 决策中继 | run-resume.test.js |
| CL1 | submit/respond 经注入 http 命中对应路径 | run-client | run-client.test.js |
| CL2 | waitReady：ready 即返回 true；busy 轮询后超时 false | run-client | run-client.test.js |
| CL3 | API_ENDPOINTS 覆盖 send/respond/status/awf-state 等 | run-client | run-client.test.js |
| CL4 | subscribe：onEvent 收到 status 事件；unsubscribe 停止 | run-client | run-client.test.js |
| CL5 | submitRun / runSnapshot / pollRunEvents 命中 `/run/*`（含 query） | run-client | run-client.test.js |
| CL6 | setRunMode / markRunTaskActive / runGateComplete / backupRun 命中 `/run/state/*` | run-client | run-client.test.js |
| CL7 | getState 读 `/awf/state`；slotStatus(sid) 读 `/status?sid` | run-client | run-client.test.js |
| IT1 | `GET /run/status` 空态：host 装配完成、无 run | 集成 | integration/run-host.test.js |
| IT2 | `POST /run/submit` → 驱动到 done；事件轮询含 run/task 生命周期 | 集成 | integration/run-host.test.js |
| IT3 | 未知 runId 快照 → ok:false；重复/并发 submit 冲突可读 | 集成 | integration/run-host.test.js |
| IT4 | WS 订阅实时收 run/task 事件；decision.required 推送；非 `/run/events` 升级拒绝 | 集成 | integration/run-host.test.js |
| IT5 | 真实 createRunClient 提交→poll 事件到 done→快照→getState | 集成 | integration/run-host.test.js |
| IT6 | `/run/state/mode` + `task/active` 经 server 落盘；`/run/state/gate` 派生修复+回退复审 | 集成 | integration/run-host.test.js |
| E2E-1 | 单任务正常完成 → 只 send 一次 → backup 写 versions | 端到端 | e2e/run.e2e.test.js |
| E2E-2 | 未标 done → 补发 wrapup → 生效 | 端到端 | e2e/run.e2e.test.js |
| E2E-3 | wrapup 未生效 → 追问 1 轮 → done | 端到端 | e2e/run.e2e.test.js |
| E2E-4 | 追问 3 轮仍未完成 → 标 blocked 跳过 | 端到端 | e2e/run.e2e.test.js |
| E2E-5 | 多任务顺序执行，deps 满足后才执行 T2（任务间 context-check） | 端到端 | e2e/run.e2e.test.js |
| E2E-6 | cfg `run.agents.max>1` → 宿主按 batch 模式驱动（runScheduler 入口） | 端到端 | e2e/run.e2e.test.js |
| E2E-7 | `--multi-agent` → 显式以 batch 模式提交（不受 cfg 影响） | 端到端 | e2e/run.e2e.test.js |
| RR1 | resume：宿主空闲 `--attach` 拒绝 + 失败退出码非 0 + 不清场；中断后 `--attach` 挂接在飞 run 收敛 | 真机 | fullflow-regression.mjs |
| RR2 | recover：CLI 被 SIGKILL 后现场保留、宿主无 CLI 仍推进、`--resume` 收尾复位 idle | 真机 | fullflow-regression.mjs |
| RR3 | pause / pause-release：闩锁只挡派发、目标结算即放行、恢复后剩余任务续跑 | 真机 | fullflow-regression.mjs |

## 详细测试用例

### TC1: state.json 不存在 → exit(1)

**前置条件**：`loadState` 返回 null
**执行**：`runCommand(undefined, {})`
**断言**：抛出（`process.exit` 被 mock 为抛错）；不执行环境拉起与提交

### TC2: 环境拉起 → 提交 run → 观察至 done → mode idle + 清理

**前置条件**：state `mode='plan'`；`getStatus` 首探无 server（`false` → 走拉起）
**执行**：`runCommand(undefined, {})`
**断言**：`spawn('node', ['<server.cjs>'], …)` 被调用；`client.submitRun({})` 被调用；`setRunMode` 依次收到 `run`、`idle`；输出「工作流结束」「已停止运行会话」

### TC2b: 观察循环消费宿主事件并展示

**前置条件**：`pollRunEvents` 第 2 帧返回 `run.started`/`task.started(T1, 链 DEV→COMMIT)`/`task.done`
**执行**：`runCommand(undefined, {})`
**断言**：输出「任务 T1: 做 A」与「工作流结束」

### TC2c: run 提交失败 → 保留现场

**前置条件**：`submitRun` 返回 `{ok:false, error:'宿主正在驱动 run default'}`
**执行**：`runCommand(undefined, {})`
**断言**：`setRunMode` 未被 `idle`；未输出「已停止运行会话」；输出「保留 tmux 与 Session Server」

### TC2d: 宿主以 error 收尾 → 保留现场

**前置条件**：`runSnapshot` 返回 `run.status='error', error:'executor 失败'`
**执行**：`runCommand(undefined, {})`
**断言**：`setRunMode` 未被 `idle`；输出「保留 tmux 与 Session Server」；不输出「工作流结束」

### TC2e: 正常完成但 idle 写入失败 → 保留现场

**前置条件**：`setRunMode` 返回 `{ok:false}`
**执行**：`runCommand(undefined, {})`
**断言**：不输出「已停止运行会话」；输出「保留 tmux 与 Session Server」

### TC2f: `--resume` 重启暂停中的 CLI 时保留 pause 闩锁

**前置条件**：state `mode='pause'`
**执行**：`runCommand(undefined, {resume:true})`
**断言**：`setRunMode` 未被以 `run` 调用（`preservePause` 生效）

### TC6: SIGINT/SIGTERM 注册清理处理器

**执行**：`runCommand(undefined, {})`
**断言**：`process.on` 收到 `SIGINT` 与 `SIGTERM` 各一个函数

### TC7 / TC8: server 复用

**前置条件**：`getStatus` 返回 `{state:'ready', projectRoot}`（TC7=`/tmp/mock-cwd`，TC8=`/tmp/other`）
**执行**：`runCommand(undefined, {})`
**断言**：未 `spawn` server；输出「复用现有服务」；`setRunMode('idle')` 被调用（TC8 断言未执行 `lsof`）

### RC1–RC7: 重连语义（T1-059 / T1-073）

- **RC1**：宿主有活跃 run（`runs:[{runId:'default',status:'running',counts}]`）+ `{resume:true}` → `submitRun` **未**调用；输出「挂接 run default」「1/2 done」；`setRunMode('idle')`；输出「工作流结束」。
- **RC2**：宿主无活跃 run + `{resume:true}` → `submitRun({})` 被调用（续跑）；`setRunMode('idle')`。
- **RC3**：宿主有活跃 run + `{attach:true}` → `submitRun` 未调用；输出「挂接 run default」。
- **RC4**：宿主无活跃 run + `{attach:true}` → 抛「宿主无活跃 run」；不提交、不 idle；输出「保留 tmux 与 Session Server」。
- **RC5**：宿主有活跃 run + fresh → `submitRun` 未调用；输出「宿主已有活跃 run」（防御性转挂接）。
- **RC6**：`{attach:true, runId:'r1'}` 且宿主有 `r1` → 输出「挂接指定 run r1」；不提交；收敛 idle。
- **RC7**：`{attach:true, runId:'zzz'}` 且宿主无该 run → 抛「未找到 run zzz」；不提交、不 idle；保留现场。

### SR1–SR4: waitSessionStarted（会话就绪等待）

- **SR1**：`sessionSeq` 由 2 增到 3 → 返回 true，`nudge` 未触发。
- **SR2**：sessionSeq 恒为 5（`seqBefore=5`）→ 超时返回 false（告警放行）。
- **SR3**：sessionSeq 恒 0、`nudgeMs=5` → 等待期间补 Enter ≥1 次。
- **SR4**：`status` 返回 null → 不抛，按未就绪处理（超时返回 false）。

### DR1–DR4: drainDecisionResume（决策续跑）

- **DR1**：首次 `/status` 带 `decisionResume{decision_id,answer}`，其次 null → `POST /send` 1 次（文本含 answer）；`waitForReady` 1 次。
- **DR2**：`decisionResume` 恒 null → 零 `/send`、零 `waitForReady`。
- **DR3**：连续两轮 resume（D-1/D-2，其一 `fallback:true`）→ `/send` 2 次、`waitForReady` 2 次。
- **DR4**：`POST /send` 返回 `{ok:false}` → 停止续跑，`waitForReady` 不被调用（不静默死循环）。

### CL1–CL7: run-client 调用面

- **CL1**：`client.submit('你好')` → `POST /send`；`client.respond(v)` → `POST /respond`。
- **CL2**：`waitReady` —— status ready 返回 true；一直 busy 到超时返回 false。
- **CL3**：`API_ENDPOINTS` 含 send/respond/cmd/status/contextReady/awfState/awfMetrics。
- **CL4**：`subscribe({onEvent})` 收到 `{type:'status',…}`；`unsubscribe` 后停止。
- **CL5**：`submitRun` → `/run/submit`（runId 可选）；`runSnapshot`/`pollRunEvents` 命中 `/run/status`、`/run/events?afterSeq=&runId=`。
- **CL6**：`setRunMode`/`markRunTaskActive`/`runGateComplete`/`backupRun` 命中 `/run/state/{mode,task/active,gate,backup}`；端点表含这些项。
- **CL7**：`getState` 读 `/awf/state`；`slotStatus(sid)` 读 `/status?sid=<sid>`。

### IT1–IT6: server run host 集成闭环

以 `__CC_RUN_HOST_DEPS__` 注入真实 state/run-driver/gate-fix + fake per-task executor，走真实 HTTP。

- **IT1**：`GET /run/status` → `{ok:true, runs:[]}`。
- **IT2**：`POST /run/submit{runId:'it1'}` → 202，事件含 `run.submitted/started/stopped`，`task.started` 顺序 `[T1,T2]`，state 落账 `['done','done']`；尾游标后无新事件。
- **IT3**：未知 runId → `{ok:false, error:'…nope'}`。
- **IT4**：WS 实时收 `run.started/task.done×2/run.stopped`；`/choice` 触发 `decision.required` 推送；非 `/run/events` 路径握手被拒。
- **IT5**：真实 `createRunClient` 提交 → afterSeq 增量轮询到 `run.stopped` → 快照 `done 2/2` → `getState` 读 store。
- **IT6**：`/run/state/mode`、`/run/state/task/active` 经 server 落盘；`/run/state/gate`（review blocked + verdict fail）→ 派生 `R1-F1`、门禁回退 pending、`exec.recheck=1`。

### E2E-1–E2E-7: runCommand 端到端（进程内 server + mock tmux「模拟 AI」）

> 端到端跑的是 `runCommand` 的真实链路（CLI → 进程内 server run host → mock tmux）。**收尾协商 / 上下文检查 / 版本备份的执行体现已迁至 server run 域（`task-channel.cjs`、host drive 收尾），此处经宿主真实负载链路验证，不在 CLI 内**。

- **E2E-1**：`sendText==='do task one'` 时标 T1 done → state done、`.awf/versions/` 1 份、`sentPrompts=['do task one']`。
- **E2E-2**：仅当补发 prompt 含「收尾」+「awf_task_complete」时标 done → 2 条 prompt（第二条含 `awf_task_complete` 与 `T1`）。
- **E2E-3**：仅当含「三选一」时标 done → 3 条 prompt（task / 收尾 / 三选一）。
- **E2E-4**：永不标 done → 5 条 prompt（task + wrapup + 3 轮 settle），T1 标 blocked。
- **E2E-5**：T2 依赖 T1 → 3 条 prompt（task one / 上下文检查 / task two），两任务 done。
- **E2E-6**：`.awf/config.json` `run.agents.max=2` → 宿主走 batch（`runScheduler` 被调用）。
- **E2E-7**：`--multi-agent` → `runScheduler` 被调用（不受 cfg 影响）。

### RR1–RR3: 真机全链路（`npm run test:real`，不进 `npm test`）

依据 `.awf/reports/test/t3-011-full-real-gate.md`（真机回归覆盖边界口径）。

- **RR1 `resume`**：① 宿主空闲 `--attach` → 报错「宿主无活跃 run」、失败退出码非 0、tmux 会话保留、mode 未被静默复位；② CLI SIGKILL 中断后 `--attach` 挂接**在飞** run（日志含「挂接 run」且**无**「已提交 run」）、attach 正常退出、run 收敛、任务 done、产出落盘、mode 复位 idle。
- **RR2 `recover`**：CLI 被 SIGKILL 后 —— CLI 已死、tmux 会话在、常驻 server 仍响应、mode 仍为 run（run_interrupted 信号）、未完成任务未被清；宿主在无 CLI 时仍推进 run；`--resume` 正常退出并收尾（mode 复位 idle、每项 done 都有 `exec.result`、产出落盘）。
- **RR3 `pause` / `pause-release`**：未暂停时 `/intervene` 409；置 pause 后闩锁只挡**派发**、在飞任务照常收尾；目标结算即放行且不放松派发闩锁；`/intervene`、`/intervene/interrupt` 暂停下受理；恢复 mode=run 后剩余任务续跑 done、mode 复位 idle。

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| `src/lib/state.js`（`loadState`） | `vi.mock` | 预制 state（mode/currentState） |
| `src/lib/run-config.js` | `vi.mock` | 固定 `{agents:{max:1}}` |
| `src/lib/pause.js`（`waitWhilePaused`） | `vi.mock` | 默认立即放行（闩锁语义由 pause.test.js 覆盖） |
| `src/lib/profile.js`（`installProjectMcp`） | `vi.mock` | 返回 `{written:false,servers:[]}` |
| `src/lib/server-log.js` | `vi.mock` | 固定 fd/path |
| `src/lib/run-context.cjs`（`buildRunContext`/`projectSid`） | `vi.mock` | 固定路径/会话名/端口 |
| `src/server/run-settings.cjs`（`generateRunSettings`） | `vi.mock` | 返回 `{statusLine:{}}` |
| `src/cli/run-client.js`（`createRunClient`） | `vi.mock` | 返回可控 `submitRun/pollRunEvents/runSnapshot/setRunMode` |
| `src/lib/session/client.js` | `vi.mock` | `httpPost/httpPostJson/autoSelect/waitForReady/getStatus/SERVER_PORT/projectQuery` |
| `node:fs/promises` | `vi.mock` | `mkdir/writeFile`（run-settings 写入） |
| `node:child_process` | `vi.mock` | `spawn`/`execSync`（server/tmux/bootstrap） |
| `node:readline` | `vi.mock`（run.test.js 决策用例） | 模拟选择/输入，避免阻塞 |
| `process.exit` / `process.on` / `process.cwd` / `console.log` | `vi.spyOn` | 拦截退出与输出 |
| 计时器 | `vi.useFakeTimers` + `advanceTimersByTimeAsync` | 推进轮询循环 |

- **`run.test.js`** 顶部设 `process.env.CC_SESSION_READY_TIMEOUT_MS='0'`：无真实 SessionStart，会话就绪等待直接放行（该等待由 `session-ready-wait.test.js` 单独覆盖）。
- **`integration/run-host.test.js`** 与 **`e2e/run.e2e.test.js`** 走**真实 HTTP**（进程内 `server.start`），仅 mock tmux/进程：前者注入 `__CC_RUN_HOST_DEPS__`（fake executor），后者用 mock tmux 的 `sendText` 触发「模拟 AI」回写 state。
- **`tests/regression/fullflow-regression.mjs`** 不 mock：真 tmux + 真 claude + 真 server，走 `npm run test:real`（不进 vitest include）。
