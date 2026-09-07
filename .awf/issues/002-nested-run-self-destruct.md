---
id: "002"
title: 嵌套 awf run 自毁父基础设施（kill-by-port + kill-session）
status: open
labels:
  - bug
  - run
assignee: ""
milestone: ""
priority: high
created: 2026-09-07
updated: 2026-09-07
deps: []
related: ["001"]
---

# 嵌套 awf run 自毁父基础设施

## 现象

在**正在运行的 awf run 的 tmux CC 会话里**，试图再起一个 fixture 的 `awf run`（真 run 冒烟），
父 run 的 Session Server 与 tmux 会话被连带杀死：父 CLI 下一个 `/send` 抛
`ECONNREFUSED 127.0.0.1:8787` 异常退出（保留现场）。

日志佐证：`.awf/logs/<run>/main.log` 最后一条（17:10:55 wrapup）后 server 不再响应；
现场 `lsof 8787` 无监听、tmux `no server running`。

## 根因

`src/cli/run.js` 起基础设施的两个动作对**运行中的父 run 是破坏性的**：

1. `ensureServer()`：`lsof -ti:8787 -sTCP:LISTEN | xargs kill -9`——无条件杀占用默认端口的进程，
   把父 run 的 Session Server 杀掉。
2. `ensureSession()`：`tmux kill-session -t cc`——把同名 tmux 会话（即父 run 所在的会话，执行者自己）杀掉。

任何「awf run 里再跑 awf run / 冒烟起真 server」都会命中。

## 修复方向（加固候选）

- 嵌套/自叠检测：启动时探测是否已处于 awf run 上下文（如 `AWF_RUNNING` env / state.mode=run 且当前 session 是 tmux cc），
  是则拒绝直接起 run 或要求 `--port`/`--session` 隔离；
- kill 动作加保护：仅当目标进程/会话确实是本 run 曾持有的（记录自身 spawn 的 pid / session）才 kill，不按「端口被占就杀」；
- 冒烟/工具类真 server 一律走随机端口（如 smoke.cjs 的 `server.start(0)`），杜绝与业务端口冲突。

## 目标架构（2026-09-07 用户确认方向，取代"每 run 重启"）

嵌套问题最终以**单实例常驻 Session Server + 多项目并发**解决，而非加嵌套检测回避：

- 允许**多个项目同时 awf run**；每个 run 按 **sid**（session id / runId）通信与路由，互不干扰
- Session Server **已存在则不复启**（去掉 kill-by-port），前后端**只启动一次**、跨 run 常驻复用
- 展示层（dashboard / 页面）按 sid 区分展示多 run
- **run 结束也不关闭 server**——关闭改由**其它时机**负责（如：空闲超时、显式 `awf stop`、全部 run 结束后人工关、随 npm/服务生命周期），关闭时机为开放问题，需另行设计
- 连带影响：`ensureServer`/`ensureSession` 从「每 run kill+spawn」改为「存在即复用/注册 sid」；tmux session 命名/进程归属需按 run 隔离；hook 事件需携带 sid 供 CLI/展示路由

> 该方向同时衔接 backlog 的「server 前后端分离重构」。详见 `cc-control/docs/discuss/multi-run-server-architecture.md`。

## 关联

- 由 T1-027（真 run 冒烟）触发；该任务已用 real-server 冒烟（端口 0）替代证据 + README 手跑步骤标 done。
- run 结束 FINISH 收尾 / 手跑复核同族见 Issue 001。
