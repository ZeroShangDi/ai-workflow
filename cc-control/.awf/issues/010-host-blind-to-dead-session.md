---
id: "010"
title: "会话消失后宿主不重评估：run 永久停摆且零告警"
status: open
labels: [bug, runtime, reliability, real-run]
assignee: null
milestone: null
priority: high
created: 2026-09-12
updated: 2026-09-12
deps: []
related: ["T3-011", "T1-111", "009"]
---

# 会话消失后宿主不重评估：run 永久停摆且零告警

**一句话**：tmux 会话一旦消失，服务端会话状态机就永远停在 `busy`，而单 agent 的 settle-wait 判据是
「CC 不 idle 就不计时」→ 永不超时、永不收尾。run 静默停摆十几个小时，没有任何告警。

## 一、现场（2026-09-12）

```
01:51:31  T3-011 派发，宿主进入该任务的 settle-wait
02:18     run 的 tmux 会话消失（会话 transcript 停在此刻）
12:20     宿主仍认为 T3-011 在跑：
          /run/status → runs[0].status=running, currentTaskId=T3-011, updatedAt 冻结在 17:51:31Z
          /status      → session:false, state:busy
          state.json   → T3-011 仍是 active（无存活执行者）
```

停摆约 **10 小时**，期间无任何事件、告警或退出。同时挂着 3 个 `awf run` 进程：主 run（01:37 起）
+ 两个沙箱 run（01:54 / 02:14，T3-011 执行用例时起的，从未退出）。

## 二、机制

`src/server/server.cjs` 单 agent 执行器的结算等待：

> CC 仍在跑（busy）→ **不计时**、永不误判超时；仅当 CC 已就绪（idle）且任务仍未结算时，累计
> 「无变化窗口」，超窗才进入收尾协商。

这条判据的前提是「busy 意味着执行者还活着」。会话没了之后 `pcx.state` 停在 busy（最后一次
`UserPromptSubmit` 置位，之后既无 `Stop` 也无任何 hook），于是：

**会话死 → 状态机 busy → 不计时 → 死等 → 零告警。**

## 三、与 T1-111 的关系

T1-111（`pause-release`）修的是**同族的另一条路径**：宿主在 pause 闩锁里被无限期挂住、看不见任务
早已结算。那次修的是「闩锁等待」，这次是「结算等待」——**同一个病根（宿主只信状态机、不信执行者
是否还在），换了一条等待路径复发**。

## 四、建议修法（待评审）

1. **探活并入等待循环**：settle-wait 每轮检查 `pcx.tmux.hasSession()`（或 claude 进程存活）；
   消失即判本次尝试失败，走既有收尾协商路径（追问 → 标 blocked → 门禁闭环），而不是继续死等。
2. **告警落盘**：会话消失必须写一条明确日志（"执行者已消失，任务 X 转入收尾"），
   让它在 `server.log` / run 日志里可见 —— 与 issue 005（server 可观测性）同源。
3. **收尾要能重建会话**：若判定为「执行者消失但任务仍 pending」，应当重建会话再派发，
   而不是把 run 收掉（本次停摆的代价正是整个 run 卡死）。
4. 顺带核查：CLI 侧 `observeRun` 是否有同样的盲区（CLI 活着但界面无任何提示）。

## 五、当前决议

- 只登记，不在本轮修（属运行基础设施）；
- 结论口径：**本次 run 的停摆不是产品逻辑判错，是等待判据缺了「执行者存活」这一维**；
  T3-011 的判定本身尚未产出（它被卡在中间）。
