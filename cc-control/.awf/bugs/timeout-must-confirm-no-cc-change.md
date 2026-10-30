# 超时判定缺少「确认 CC 无变化」前置：仍在运行即便超时不判超时

- 状态: 部分实现（2026-09-10）
  - **已实现**：宿主单 agent 执行器（`server.cjs` defaultSingleExecutor）——CC 仍 busy 则重置无变化窗口、
    不计时；仅 idle 且窗口内无任何变化才进入收尾协商（`task-channel.cjs`：wrapup → 3 轮追问 → 标 blocked），
    不再直接抛超时中断。
  - **已实现**：多 agent 传输（`batch-transport.cjs` waitAnyDone）——无变化窗口判据，主会话 busy /
    任务状态变化 / 子 Agent 事件增长任一发生即重置窗口；pause 与决策挂起期间不计时。
  - **未实现**：CLI `waitForReady`（30min 墙钟，`lib/session/client.js`）与 server `waitReady`
    默认 120s（`server.cjs`）仍是固定墙钟；待各等待点收敛到统一活动探测原语时一并处理。
- 类型: awf 产品缺陷（运行/等待超时语义）
- 关联: 99aba2d（30min 就绪超时）、43d1715（超时后防跨任务派发）、run-host 宿主执行器 defaultSingleExecutor

## 现象 / 要求

用户明确要求：**超时只有在「确认 Claude Code 无变化/不再推进」的前提下才成立；只要 CC 仍在运行
（busy / 正在产出），即使超过时限也不应判超时。**

当前多处等待逻辑是**固定墙钟 deadline**：到点即抛"超时"，没有先探测 CC 是否仍在推进
（会话 busy 态、transcript 尾增量、任务 state 是否有新落账）就中断/重派/收尾。

## 当前超时常量清单（feature 分支 HEAD）

| 作用点 | 值 | 位置 | 说明 |
|---|---|---|---|
| CLI waitForReady（等 CC 就绪 / 决策循环 / sendRespond 前后） | 30 min（`READY_TIMEOUT=1800000`） | `src/lib/session/client.js:11` | 即 99aba2d 调成 30min 的窗口 |
| server 等 CC ready 才真正 submit（/send /cmd /respond + 宿主执行器 submit 前） | **默认 120s** | `src/server/server.cjs:46` `READY_TIMEOUT_MS = CC_READY_TIMEOUT_MS \|\| 120000`（479/986/1003/1066 waitReady） | env `CC_READY_TIMEOUT_MS` 可调 |
| 宿主执行器「等任务自我结算到 done/blocked」 | **默认 120s deadline**，到点抛 `task … 超时未自我结算` | `src/server/server.cjs:485`（defaultSingleExecutor 轮询循环） | 最容易踩中本缺陷：CC 还在跑长任务时 120s 就抛 |
| run-batch（多 agent）单轮等待上限 | 15 min | `src/cli/run-batch.js:28/103/128` | 到 deadline 抛「等待任务完成超时」 |
| server 空闲自动回收（非任务超时） | 30 min | `src/lib/server-idle.cjs:12` | `CC_SERVER_IDLE_MS` 覆盖 |

另：`DECISION_FALLBACK_MS=300s`、`LOCAL_CMD_FALLBACK_MS=1.5s` 为决策/本地命令的 ready 兜底恢复定时器，非任务超时。

要点：**30 分钟只是 CLI waitForReady 那一处**；server 端「等 CC ready 才下发」与「宿主等任务自我结算」
默认是 **120s**（`CC_READY_TIMEOUT_MS` 覆盖），run-batch 单轮是 **15min**——都不是 30min，
且都不是"无变化才算"的语义。

## 根因

- 超时判定基于 wall-clock 上限，缺少统一的「CC 是否仍在推进」探测（activity/no-progress 判据）。
- 43d1715 曾在旧 cli/run.js 把 30min 改成"会话仍忙则继续等当前任务"的运行观察窗口；
  该语义迁入 run-host 单 agent 通道（defaultSingleExecutor）后，退化成固定 `READY_TIMEOUT_MS`(120s)
  的自我结算轮询 deadline，把"CC 仍 busy"误判为超时。
- 各等待点各自为政：CLI 30min、server 120s、run-batch 15min，无统一"推进心跳/无变化窗口"。

## 必改方向（待定）

1. 引入统一判据：等待 CC 完成时，把"墙钟上限"改为「**无变化观察窗口**」——
   持续轮询会话 busy 态 / transcript 尾增量 / 任务 state 落账；在**已无变化并持续空闲窗口**后才判超时，
   否则只要还有推进就重置窗口继续等。
2. 宿主执行器 self-settle deadline 用上述判据替换固定 120s（CC 仍在产出就继续等，不抛超时）。
3. 与 43d1715 语义对齐：超时(真无变化)后不得向后跨任务派发，应中断现场/标 blocked 交人工。
4. 可选：把各等待点收敛到单一活动探测原语，避免 CLI/server/run-batch 三套数值漂移。
