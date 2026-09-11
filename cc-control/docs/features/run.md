# awf run — 功能文档

> 对应 WBS：T1-058（CLI 薄化）/ T1-059（--resume/--attach 重连）/ T1-061（state 写收敛到 server）/ T1-105（server 常驻 run host）
> 源码：src/cli/run.js（`runCommand`）、src/cli/run-client.js、src/lib/session/client.js

## 功能描述

`awf run` 是自治开发工作流的**薄入口**：它只做四件事 —— **起环境**（常驻 Session Server + tmux 会话 + 项目级 MCP + run settings）、**提交 run**、**订阅并展示宿主事件/状态**、**把决策与人机应答在 CLI 与宿主/会话之间中继**，最后收尾复位 mode。

**薄化前后对比**：薄化前 CLI 是「司机」，自己挑任务、推阶段链、跑多 agent 滑动窗口（`src/cli/run-batch.js` 等，已删除）；薄化后**编排全部搬进常驻 server 的 run 域**（`src/server/run-host.cjs` 等，见 `docs/features/run-domain.md`），CLI 不再持有任何调度权。

关键边界（均有代码依据）：

- **run.js 不再挑选任务、不推进阶段链、不做多 agent 调度**（见文件头注释 L16-42）。
- **多 agent 与单 agent 一律经 server run host 驱动**：`--multi-agent` 或 `cfg.agents.max>1` 由宿主 `driveBatch → runScheduler` 调度，CLI 只把 `mode:'batch'` 提交上去（`run.js:104-119`）。
- **提示词由插件声明，CLI 零感知**：插件改名/改命令，CLI 无需改动（`src/lib/plugin-bridge.js` 文件头注释；提示词模板见 `plugin/plugin-code/prompts.json`）。
- **写收口 server 单写者**：mode run/idle 复位走 `client.setRunMode`（`POST /run/state/mode`），本文件不直写 state（`run.js:602-619`）。读路径只经 `loadState` 只读校验 + `client` 快照（`run.js:56-58`）。

## 执行流程

```
runCommand(task, options)                                  src/cli/run.js:47
  ├─ 1. buildRunContext（会话名/socket/端口/路径单源）        run.js:51
  ├─ 2. connectionMode = attach | resume | fresh            run.js:54
  ├─ 3. loadState 只读校验（无 → exit 1）                    run.js:58-62
  ├─ 4. preservePause/needSetRun（--resume 保 pause 闩锁）   run.js:68-69
  ├─ 5. 注册 SIGINT/SIGTERM 清理（doCleanup：只关 tmux）      run.js:72-83
  ├─ 6. startSession                                        run.js:92
  │     ├─ installProjectMcp → 项目级 .mcp.json 幂等合并（MCP 可用必要条件）
  │     ├─ ensureServer      → 复用健康 server 或 spawn node src/server/server.cjs
  │     ├─ writeRunSettings  → 写 .awf/run-settings.json（statusLine）
  │     ├─ ensureSession     → reuseExisting 时复用与 workDir 匹配的会话，否则 bootstrap.sh 重建
  │     └─ created && waitSessionStarted → 等 SessionStart 到达（含补 Enter 兜信任弹窗）
  ├─ 7. spawn open dashboard（带 ?p 项目作用域）              run.js:99-100
  ├─ 8. setRunMode('run')（needSetRun 时）                    run.js:110-113
  ├─ 9. driveSingle(client, {connectionMode, runId, mode})  run.js:114-119
  └─ 10. 终态处理
        ├─ outcome.ok → setRunMode('idle') → doCleanup       run.js:121-127
        └─ 否则 → throw（保留 tmux/server 现场供 w-monitor）  run.js:124-133
```

### driveSingle 分支（提交/挂接判定）

`driveSingle` 先探宿主现态（`client.runSnapshot({})` 取全部 run 摘要），再按 `connectionMode` 分流（`run.js:304-372`）：

| 情形 | 行为 | 依据 |
|------|------|------|
| `runId` 指定 + attach/resume，宿主无该 run | 报错返回 `{ok:false}`（保留现场） | `run.js:313-317` |
| `runId` 指定 + attach/resume，找到目标 run | 挂接该 run 观察（不重复提交） | `run.js:318-327` |
| `runId` 指定 + 宿主正驱动**别的**活跃 run | 单槽冲突 → 报错（不并发开第二个 run） | `run.js:330-334` |
| 宿主无活跃 run + `attach` | 报错「宿主无活跃 run」（不提交、不清场） | `run.js:336-341` |
| 宿主无活跃 run + `fresh`/`resume` | **提交**新 run（`client.submitRun`）→ 观察 | `run.js:342-356` |
| 宿主有活跃 run + `attach`/`resume` | 挂接（读 store 落盘进度续观） | `run.js:359-371` |
| 宿主有活跃 run + `fresh` | **防御性转挂接**（单槽不可重复提交，告警） | `run.js:360-362` |

- 提交前的 `hostEventTail`（`pollRunEvents` 取 `tailSeq`）作为事件起始游标，避免回放本次之前的旧事件（`run.js:374-382`）。

### observeRun 事件环（订阅与展示）

`observeRun` 轮询循环直到 run 进终态 `done|error|stopped`（`run.js:388-452`），每轮：

1. **pause 闩锁**：`await waitWhilePaused(projectRoot)` —— 暂停期间不消费事件、不应答（`run.js:397`）。
2. **人机应答/决策中继**：读 `/status`，`decisionPending` → `handleDecision`；`decisionResume`（去重）→ `injectResumeOnce`（`run.js:399-411`）。
3. **宿主事件展示**：`pollRunEvents({runId, afterSeq})` 增量事件 —— TTY 下喂 `createRunFollow()`（任务行原地重绘）；非 TTY 走静态 `renderHostEvent`（`run.js:413-419`）。
4. **状态 → 进度行 + 终态判定**：`runSnapshot({runId})`；终态即 break（`run.js:421-430`）。
5. `sleep(200)` 后下一轮（`run.js:432`）。

## 决策中继

薄化后 CLI 的决策职责是**中继**（不是决策本体）：

| 入口 | 触发 | 处理 | 依据 |
|------|------|------|------|
| `handleDecision(d)` | `/status.decisionPending` | AskUserQuestion → 自动选（`autoSelect`，5s 默认第一项）；`choice` → readline 选；`text` → readline 输入；回应经 `POST /respond?p=<项目>` 写回 | `run.js:514-555` |
| `askChoice(rl, options)` | choice 输入循环 | 越界/非数字**拒收重问**，避免 "11" 之类脏值被当真实选择回传 | `run.js:563-570` |
| `injectResumeOnce(resume)` | `/status.decisionResume`（`seenResume` 去重，一次） | 构造续跑文本 `POST /send?p=<项目>` 注入会话 | `run.js:490-501` |
| `drainDecisionResume(projectRoot)` | 外部复用（run-resume） | 读 `/status.decisionResume` → 注入 → `waitForReady` 再等，最多 10 次 | `run.js:577-593` |

- 单 agent `observeRun` 内**不**用 `drainDecisionResume`，改由 `seenResume` 一次性注入代替（避免与宿主等待冲突，`run.js:572-576`）。
- 注：`awf run` 的**运行期决策**统一走「决策门阀」（`<AWF_DECISION_REQUIRED>`，见 CLAUDE.md）；`handleDecision`/`drainDecisionResume` 属遗留的会话级应答/续跑中继路径。

## pause / 恢复相关行为

- **pause 闩锁**：`waitWhilePaused(projectRoot)`（`src/lib/pause.js`）在 `mode=pause` 期间不返回；三条出口 `releasedBy`：`null`（本就没暂停）/`'resumed'`（mode 恢复）/`'settled'`（目标任务已结算）。等待超 `PAUSE_ALERT_MS`（默认 30s，`CC_PAUSE_ALERT_MS` 可覆盖）打一次告警。
- **`--resume` 对暂停闩锁保持原语义**：`preservePause = options?.resume && state.mode === 'pause'`（`run.js:68`）—— w-monitor 用 `--resume` 重启异常退出的 CLI 时**必须保留 pause**，等监控验证 CLI 已重新驻留后再显式恢复为 run；此时 `needSetRun=false`，不切 run（`run.js:69,110`）。
- **宿主自身只看 mode**：pause 的派发闩锁实际在 server 侧（`run-host`/`batch-transport`），CLI 侧只负责在暂停期间不消费事件/不应答。

## `--resume` / `--attach` / `-R, --run-id` 语义

选项声明见 `src/awf.js:31-40`；语义实现见 `run.js:54, 288-372`。

| 选项 | 语义 |
|------|------|
| `-r, --resume` | 重启续接：有活跃 run → 挂接续观（**不重复提交**）；宿主空闲 → 提交续跑 store 剩余 pending（done 保留）。对 `mode=pause` 保留 pause 闩锁 |
| `--attach` | 仅挂接活跃 run（读 store 落盘进度 + 续观 + 应答中继，不重复提交）；宿主空闲 → 报错退出、保留现场 |
| `-R, --run-id <runId>` | 指定目标 run：`--attach`/`--resume` 挂接该 run；`fresh` 提交时命名该 run。缺省探宿主活跃 run |
| `--multi-agent` | 显式多 agent：提交 `mode:'batch'`（不受 `cfg.agents.max` 影响），调度仍由宿主执行 |
| `-a, --auto` | 已声明（`awf.js:34`）但**当前 `run.js` 未消费**（无 `options.auto` 引用） |
| `-l, --local` | 已声明（`awf.js:38`）但**当前 `run.js` 未消费**（无 `options.local` 引用） |

- **`--attach` 与 `--resume` 复用现有 server/tmux 现场**：`reuseExisting = connectionMode !== 'fresh'`（`run.js:96`）。
- 会话复用判定：`tmux display-message` 取 pane 路径，**空输出显式判为「不存在」**（否则 `path.resolve('')` 静默取 cwd 令判断恒真，T1-108 真机回归暴露），路径与 workDir 一致才算复用（`run.js:233-249`）。
- `awf attach`（无连字符，`src/cli/attach.js`）是另一命令：`tmux attach` 进会话观看/操作实时对话（Ctrl-B D 脱离），与 `awf run --attach` 不同。

## 退出码与异常退出保留现场

| 场景 | 行为 | 依据 |
|------|------|------|
| `.awf/state.json` 不存在 | 打印「未找到 .awf/state.json，请先执行 awf plan」→ `process.exit(1)` | `run.js:58-62` |
| SIGINT / SIGTERM | `doCleanup()`（只关 tmux 会话）→ `process.exit(0)` | `run.js:82-83` |
| run 正常完成（宿主终态 done） | `setRunMode('idle')` 成功后 `runCompleted=true` → `doCleanup()` | `run.js:121-133` |
| run 异常（提交失败 / 宿主 error/stopped / idle 写入失败） | 抛错，**保留 tmux 与 Session Server 现场**供 w-monitor 诊断，不标 idle、不清理 | `run.js:124-134` |
| 二次 SIGINT（`cleaned` 标记） | 不重复清理 | `run.js:73-75` |

- **run 结束只关 tmux 会话，不 kill 常驻 server**（T1-064）：server 保留，下个 run/attach 复用，空闲超时自动回收，或 `awf server stop` 显式关闭（`run.js:78-80`）。
- **异常退出即非零退出码**：`runCommand` 抛出的 Error 经 `run.js` 的 `finally` 分支（不清理）向上传播；`--attach` 空宿主失败即此路径（真机断言「失败退出码非 0」，见回归 `caseResume`）。

## 核心常量 / 配置

| 常量 | 值 | 说明 | 来源 |
|------|-----|------|------|
| `SERVER_PORT` | plugin/config.json `port`（缺省 8787，`CC_PORT` 覆盖） | Session Server 端口（单源 runtime-config） | `src/lib/session/client.js:9`、`src/lib/runtime-config.cjs` |
| `READY_TIMEOUT` | 1800000ms（30min） | `waitForReady` 最大等待 | `client.js:11` |
| `POLL_INTERVAL` | 2000ms | ready 轮询间隔 | `client.js:13` |
| `DEFAULT_TIMEOUT_MS` | 5000ms | AskUserQuestion 自动选择等待 | `client.js:145` |
| `CC_SESSION_READY_TIMEOUT_MS` | 60000ms（env 覆盖） | `waitSessionStarted` 等 SessionStart 超时（超时不硬失败） | `run.js:176` |
| session nudge 间隔 `nudgeMs` | 5000ms | 等待就绪期间周期补 Enter（兜信任弹窗） | `run.js:177` |
| 事件环轮询间隔（`sleep(200)`） | 200ms | `observeRun` 每轮间隔 | `run.js:432` |
| tmux 会话名 | `${session}-${projectSid}`（`projectSid`=`p`+12hex） | 单 server 多项目会话名唯一化 | `src/lib/run-context.cjs` `projectSid`/`projectSessionName` |
| `PAUSE_ALERT_MS` | 30000ms（`CC_PAUSE_ALERT_MS` 覆盖） | pause 闩锁告警阈值 | `src/lib/pause.js:7` |

> 注：`awf run` **没有** `--port` 选项；端口经 `plugin/config.json` 的 `port` + `CC_PORT` env 控制（`runtime-config.cjs`）。回归 harness 的 `--port <n>`（`tests/regression/fullflow-regression.mjs`）是**该脚本**的选项，用于隔离端口起 server/插件副本，与 `awf run` 无关。

## 函数清单

| 函数 | 说明 | 位置 |
|------|------|------|
| `runCommand(task, options)` | 主入口：起环境 → 提交 run → 观察 → 收尾复位 | `run.js:47` |
| `startSession({ctx, workDir, reuseExisting})` | 组装环境：installProjectMcp → ensureServer → writeRunSettings → ensureSession | `run.js:140` |
| `sessionSeqOf(workDir)` | 读本项目当前 SessionStart 序号（拿不到→0） | `run.js:154` |
| `waitSessionStarted(ctx, workDir, seqBefore, deps)` | 等 sessionSeq 增长（SessionStart 到达）才放行；期间补 Enter；超时告警放行 | `run.js:171` |
| `ensureServer(serverScript, infraRoot, workDir, reuseExisting, runCtx)` | 复用健康 server 或 spawn（输出接 `.awf/logs/server.log`），最多轮询 30×500ms | `run.js:202` |
| `ensureSession(bootstrapScript, workDir, sessionName, reuseExisting)` | 复用匹配会话或 kill + 执行 bootstrap.sh | `run.js:233` |
| `writeRunSettings(ctx, workDir)` | 写 `.awf/run-settings.json`（statusLine；T1-065 已移除 inbox 入站配置） | `run.js:277` |
| `driveSingle(client, opts)` | 单 agent：探宿主 → 提交/挂接 → observeRun | `run.js:304`（导出） |
| `hostEventTail(client)` | 取宿主事件尾游标（提交/挂接前） | `run.js:375` |
| `observeRun(client, opts)` | 观察宿主推进至 run 终态；TTY 跟随 / 非 TTY 静态 | `run.js:388` |
| `renderHostEvent(e)` | 非 TTY 下渲染单个宿主事件 | `run.js:455` |
| `injectResumeOnce(resume)` | 注入 gate 决策续跑消息（一次） | `run.js:490` |
| `handleDecision(d)` | 分发三种决策（AskUserQuestion/choice/text） | `run.js:514`（导出） |
| `askChoice(rl, options)` | 反复追问直到拿到合法序号 | `run.js:563` |
| `drainDecisionResume(projectRoot)` | 外部复用：读 decisionResume → 注入 → 等待 | `run.js:577`（导出） |
| `logBanner(text)` | 打印任务分隔横幅 | `run.js:600`（导出） |

## 接口 / 依赖

| 模块 | 用途 |
|------|------|
| `src/cli/run-client.js`（`createRunClient`） | CLI↔Server 调用面：`submitRun`/`runSnapshot`/`pollRunEvents`/`setRunMode`（含 `?p` 项目路由） |
| `src/lib/session/client.js` | HTTP 原语与就绪等待：`httpPost`/`httpPostJson`/`getStatus`/`autoSelect`/`waitForReady`/`SERVER_PORT`/`projectQuery` |
| `src/lib/run-context.cjs`（`buildRunContext`/`projectSid`） | run 上下文装配：会话名、端口、路径、settings 引用单源 |
| `src/lib/profile.js`（`installProjectMcp`） | 项目级 `.mcp.json` 幂等合并（MCP 工具可用必要条件） |
| `src/lib/pause.js`（`waitWhilePaused`） | pause 闩锁（暂停期间挂起、恢复/settled 放行） |
| `src/lib/state.js`（`loadState`） | 只读校验 state 存在与 mode（不写） |
| `src/cli/run-client.js` + 上述 client | 提交/订阅/应答；mode 写经 `setRunMode`（`POST /run/state/mode`） |
| `src/server/run-host.cjs` 等 server run 域 | 实际编排（任务选择/阶段链/门禁/多 agent 调度）；CLI 不持有 |
| `src/lib/ui/run-follow.js`（`createRunFollow`） | TTY 跟随展示（任务行原地重绘 + 进度行） |
| `src/lib/ui/log.js`（`logSection`/`logStep`）| 结构化输出 |
| `node:child_process`（`spawn`/`execSync`） | tmux 会话管理（display-message/kill-session/attach）、bootstrap、补 Enter |
| `node:readline` | 交互式决策输入（choice/text） |
| `plugin/plugin-code/prompts.json` | 运行期提示词模板（经 `plugin-bridge.js` 读取；CLI 零感知） |

## 验收标准

- [ ] `awf run` 能在无 server 时拉起常驻 server、无 tmux 会话时执行 bootstrap 建会话；已有健康 server/会话时复用（不 spawn、不 kill）。（`run.test.js` TC2/TC7/TC8）
- [ ] 派发前等到 `SessionStart` 到达（sessionSeq 增长）；超时告警放行、不硬失败。（`session-ready-wait.test.js`）
- [ ] 单 agent 提交 run 后，CLI 消费宿主事件并展示（`task.started/done` 等）；观至终态后 `setRunMode('idle')` + 清理 tmux。（`run.test.js` TC2/TC2b；`run-host.test.js`）
- [ ] `--resume`/`--attach`：宿主空闲时 `--attach` 拒绝且**不清场**（tmux 与 mode 保留）；CLI 被 SIGKILL 中断后 `--attach` 挂接在飞 run，续观至完成、**不重复提交**；`--resume` 完成收尾复位（run_interrupted 闭环）。（真机 case `resume`/`recover`）
- [ ] `--resume` 重启暂停中的 CLI 时保留 pause 闩锁，不切 run。（`run.test.js` TC2f）
- [ ] 决策中继：`decisionPending`（AskUserQuestion/choice/text）经用户应答写回 `/respond`；`decisionResume` 去重注入续跑 `/send`。（`run.test.js`；`run-resume.test.js`）
- [ ] 异常退出（提交失败 / 宿主 error / idle 写入失败）**保留 tmux 与 server 现场**、不标 idle；正常退出只关 tmux、不 kill 常驻 server。（`run.test.js` TC2c/TC2d/TC2e）
- [ ] `--multi-agent` 或 `cfg.agents.max>1` → 宿主走 batch 模式经 `runScheduler` 调度（CLI 不实现滑动窗口）。（`run.e2e.test.js` E2E-6/E2E-7）
- [ ] 真机全量回归 `--case all` 覆盖边界：`resume`/`recover`/`pause`/`pause-release`/`dual` 等已注册 case 通过；未覆盖项（plan 全链路、门禁失败分支、多 agent 真并发调度、异常路径等）按 `t3-011-full-real-gate.md` §四声明为准。
