---
id: "001"
title: run 结束 FINISH 收尾（复盘 / 记忆 / 交接）— 0.3.0
status: open
labels:
  - run
  - FINISH
  - 复盘
  - backlog
assignee: ""
milestone: "0.3.0"
priority: medium
created: 2026-09-07
updated: 2026-09-07
deps: []
related: []
---

# run 结束 FINISH 收尾（复盘 / 记忆 / 交接）

## 背景

现状（单 agent）`awf run` 在无 pending 任务时仅 `backupState()` + 打印「工作流结束」即退出：
`currentState` 不会被写成 `FINISH`，也没有自动收尾动作（复盘 / 记忆沉淀 / 上下文交接都不触发）。
这导致一次 run 结束后缺少「这次做到什么程度、留下什么记忆、下次怎么续」的闭环——正是
`code-retro-point`、`code-context-onboard`、跨 run 记忆沉淀本应覆盖却无人触发的位置。

## 提议（0.3.0 实现）

run 结束时自动进入 FINISH 收尾，按 code-retro-point 固定三段（Stable / Improve / Experiment）产出复盘，
并执行：质量/性能自查 → 文档同步核对 → 运行总结 → 记忆沉淀（值得记录的写入记忆/决策记录）→
交接快照（handoff.md，供下次 run / 下个 session 续接）。最终把 `currentState` 写入 `FINISH`，
使结束态可观测、可恢复。

## 建议验收

1. run 全部任务完成后自动触发一次 FINISH 收尾，产出复盘文件并落盘交接快照
2. `currentState` 在结束时更新为 `FINISH`（单/多 agent 双路径一致），状态可查询
3. 复盘沉淀进 code-retro-point 规范文档；值得长期保留的内容写入记忆/决策记录
4. 交接快照供 `--resume` / 下一 run 无缝续接，无上下文断裂

## 同族缺口（可并入或另立 issue）

- plan 结束无显式标记：产完三大件即算完，`w-plan-check`（plan 结束门禁）不被自动调用
- `awf run` 启动不强制 plan 门禁（直接 loadState + findNextTask）
- FINISH 语义目前只有读取判断，无写入方

> 注：v0.2.0 定位 = 重构 / 优化 / 攻克难点（当前「决策闸门」为攻克难点的初步尝试），
> 本收尾能力刻意排到 v0.3.0。
