---
id: "006"
title: "stale run 恢复能力与调用权边界尚未决策"
status: open
labels: [discussion, tooling, recovery, deferred]
assignee: null
milestone: null
priority: low
created: 2026-09-11
updated: 2026-09-11
deps: []
related: ["T3-011", "001", "005"]
---

# stale run 恢复能力与调用权边界尚未决策

**一句话**：系统目前能留下 `mode=run`、`task.status=active` 但执行者已经死亡的残留状态；是否应提供恢复能力、由人还是系统判断和调用、允许恢复到什么程度，尚未完成设计裁决，因此暂不实现、不加入当前运行链。

**优先级**：low，当前不是 v0.2.0 恢复工作的首要阻塞项；先登记证据和设计问题，待核心运行身份、任务依赖和门禁顺序稳定后再评审。

---

## 一、已发生的真实案例

2026-09-10 的 v0.2.0 真实运行在派发 `T3-011` 后中断：

- 实际已无 `awf run`；
- 实际已无 `src/server/server.cjs`；
- TCP 8787 无监听；
- tmux server 不存在；
- `.awf/state.json` 仍为 `mode=run`；
- `T3-011.status=active`，`startedAt=2026-09-10T20:28:01.355Z`。

2026-09-11 已在人工核验“无存活写入者”后做一次性恢复：

- `mode: run → idle`；
- `T3-011: active → pending`；
- 删除陈旧 `startedAt`；
- 保留旧 `result/files/verdict/architecture/recheck`；
- 未启动或恢复 awf run。

恢复前 state 由提交 `8fa0740` 完整保存，SHA-256 为
`c50132b79abfb53568a609f2256fba783f36416fda54d717b285119708dd5b30`；
恢复后 SHA-256 为
`cb7304b74f6c1792d7cdc60dc07a600fa2ddbe5e1e70cbbe84144386e00a1688`。

详细过程见 `docs/discuss/v0.2.0-refactor-audit-and-recovery-plan.md` 的“人工恢复进度”。

> 注意：本次人工操作只能证明特定现场可以安全恢复，不能自然推出未来应当由人、监控或调度器自动执行。

---

## 二、当前能力缺口

### 1. active 没有存活性语义

任务只有 `startedAt`，没有：

- attempt id；
- owner / worker / server id；
- heartbeat；
- lease expiry；
- server incarnation；
- finish / interruption reason。

所以系统无法严格区分“仍在执行但很慢”和“执行者已经死亡”。

### 2. 没有 attempt 历史

`task.exec` 同时承载当前执行和上次结果；重新派发会复用、覆盖或混合
`result`、`verdict`、`startedAt` 等字段，无法稳定回答“这是第几次尝试、上一次为何停止”。

### 3. 没有带并发保护的恢复操作

现有状态 API 可以把任务改回 pending，但没有提供一个完整事务来保证：

1. 状态自检查；
2. 存活执行者检查；
3. 旧 attempt 归档；
4. state hash / revision 比对；
5. 获取锁后再次确认；
6. `active → pending` 与 `run → idle` 原子落盘；
7. 恢复审计记录。

### 4. 调用权尚未决定

目前至少有三种方向，不能提前假定答案：

| 方向 | 优点 | 风险 |
| --- | --- | --- |
| 仅人工判断、人工调用 | 最保守，适合高风险事故 | 恢复依赖经验，可能长期无人处理 |
| 系统判断、人工确认 | 系统负责取证和给建议，人负责最终授权 | 需要可信的 stale 判定和清晰确认界面 |
| 系统自动恢复 | 无人值守能力强 | 误判会造成双执行、覆盖现场或重复写入 |

还需考虑按任务风险分级的混合方案，例如只自动回收有明确 lease 过期且无副作用的任务，高风险任务仍要求人工确认。

---

## 三、需要决策的问题

1. 谁拥有“任务已 stale”的最终判定权：人、server、w-monitor，还是租约协议？
2. “诊断”和“修改状态”是否必须拆成两个能力？
3. 人工确认应发生在 CLI、Web UI、w-monitor 对话还是其他入口？
4. 是否允许非交互调用；如果允许，需要什么 capability/token 和显式参数？
5. 恢复粒度是单任务、单 run，还是整个项目状态？
6. `mode=run → idle` 是否应与 `active → pending` 同事务，还是分别确认？
7. 旧 attempt 应存进 state、独立事件日志，还是 append-only journal？
8. 执行者重新出现时，如何阻止旧进程继续写入已经恢复的任务？
9. 哪些任务绝不能自动恢复，例如 commit、发布、外部写操作？
10. 恢复能力是否暴露给 MCP；若暴露，怎样避免正在运行的 agent 自行给自己解锁？

---

## 四、未来实现的最低安全条件

在以上调用权决策完成后，任何实现至少必须满足：

- 默认只读诊断或 dry-run；
- 恢复前后都有不可覆盖的审计记录；
- 使用 state lock，并在锁内做 revision/CAS 二次校验；
- 旧 attempt 先归档，不能静默覆盖；
- 能证明旧 owner 已失效，或使旧 owner 的后续写入必然被拒绝；
- 一次恢复一个明确 task/run，不提供无边界的“全部重置”；
- 对 commit、发布和外部副作用任务采用更高确认等级；
- 有并发恢复、旧进程回归、重复调用幂等、证据保留等负向测试；
- 未完成这些条件前，不得由 scheduler 或 w-monitor 自动触发。

---

## 五、当前决议

- 只登记 issue，不实现恢复命令或自动恢复逻辑；
- 不新增自动调度任务，不改变当前依赖链；
- 不预设“必须交给人”或“最终应自动化”；
- 待运行身份模型、任务图原子变更和 attempt/lease 设计明确后再评审；
- 当前如再次发生 stale 状态，仍按事故现场逐例人工核验和处置。
