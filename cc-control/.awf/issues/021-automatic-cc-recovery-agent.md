---
id: "021"
title: "运行异常后的隔离 CC 自动诊断与修复"
status: resolved
labels: [recovery, observability, automation]
assignee: null
milestone: null
priority: medium
created: 2026-10-03
updated: 2026-10-03
deps: []
related: ["T1-112"]
---

# 运行异常后的隔离 CC 自动诊断与修复

**一句话**：Run 明确失败且主 CC 会话仍存在时，自动启动独立 CC 运行现有 `w-monitor`；监控退出后只回收新 CC，不影响主 Run CC。

## 方案与实现

`w-monitor` 已负责侦查、按需调用 `awf-monitor-repair`、复核与退出。本 issue 只补自动启动和生命周期管理，不另造监听或修复机制。

1. 仅在 CC adapter 收到 `run.stopped(status=error)` 且主 Run tmux 存在时启动。
2. 为监控 CC 生成独立 tmux 名与 `CC_SID`；其 hook 只更新自身会话槽，w-monitor 的现有 MCP 操作仍指向项目主 Run CC。
3. 运行既有 `/w-monitor` 闭环；若失败收尾把 mode 复位成 idle，启动提示会在仍有未完成任务时把 mode 交还监控闭环管理。
4. w-monitor 标记自己的 `monitor_exited` 后，向独立 CC 发送 `/exit`；bootstrap 只回收该监控会话。server shutdown 也只清理它记录的自有会话。

## 验收

- 普通长任务在无 Run error 时不会触发；明确 Run error 会交给 w-monitor 判定是否已正常结束。
- 监控 CC 的启动、完成、关闭均使用其唯一生成的 tmux 名；清理不指向主 Run 会话名。
- w-monitor 的正常、修复、需人工路径仍由已有命令处理；非 CC adapter 不启动 tmux 监控。

**实现**：`server/features/monitor/auto-recovery.cjs`、`server/runtime/index.cjs`、`server/adapters/cc/session.cjs`、`scripts/bootstrap.sh` 与 core `w-monitor` 命令。
