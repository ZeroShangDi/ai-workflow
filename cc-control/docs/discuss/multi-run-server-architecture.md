# 单实例常驻 Session Server + 多项目并发 run（设计方向）

> 2026-09-09 **已实现**（v0.2.0 收口落地，主键定为 projectRoot）：一个常驻 server 进程按
> `Map<projectRoot, ProjectCtx>` 服务多个项目目录；请求/hook 带 `?p=`（gateway 从 env CC_PROJECT 附，
> CLI/run-client/MCP 同源）路由到对应项目上下文。磁盘仍锚各自 `.awf/state.json`，**不做 `.awf/runs/<sid>`
> 磁盘分片**（Q1 用户裁定：同目录不同时跑多 run）；sid 仅作 run 标签（tmux 会话名 `cc-<projectSid>` + hook 路由）。
> tmux/logger/decision-gate 每项目一份，互不串；空闲回收在全部项目无活跃 run 且空闲超时后触发。
> 关联实现：`src/server/project-context.cjs`（容器+注册表）、`src/server/server.cjs`（pcx 路由）、
> `src/server/one-server-two-projects.test.js`（验收）。原方向文（未实现阶段）留档如下。

> 日期：2026-09-07 · 状态：**方向记录（未实现）**（已于 2026-09-09 落地，见上）· 关联 Issue `.awf/issues/002`
> 触发：T1-027 嵌套 run 自毁父基础设施 → 明确未来不靠「每 run 重启」解决，改单实例常驻。

## 目标

允许多个项目**同时**跑 `awf run`：

- 每个 run 按 **sid**（session/run 标识）通信、路由、互不干扰
- Session Server **已存在则不复启**（去掉 `ensureServer` 的 kill-by-port）
- **前后端都只启动一次**，跨 run 常驻复用
- 页面/展示按 sid 区分展示多个 run
- **run 结束也不关闭 server**——关闭另找时机

## 核心变化点（对现状的冲击）

| 现状（每 run 独立生命周期） | 目标（单实例常驻 + sid） |
|---|---|
| `ensureServer`：`lsof -ti:8787 | kill -9` 再 spawn | 存在即复用；kill 只在确认是自身残留时 |
| `ensureSession`：`tmux kill-session -t cc` 再 bootstrap | session 按 run 隔离命名；复用/注册，不互杀 |
| hook 事件只靠单 `mainSessionId` 判主 | hook 事件需携带 **sid/runId**，按 sid 路由到对应 CLI/run |
| `decisionPending`/`decisionGate`/run 状态是**单槽** | 需按 sid 分槽（每 run 独立状态机） |
| dashboard 展示单 run | 页面按 sid 列表/过滤多 run |
| server 随 run 结束（关 or 残留） | run 结束不关，**另行定关闭时机** |

## 待定 / 开放问题

1. **server 关闭时机**：空闲超时？显式 `awf stop`？最后一个 run 结束且空闲后回收？随安装/服务生命周期？（用户：找"另外的关闭时机"，未定）
2. sid 的载体与生成：复用 `runStamp`（`version-ts`）？还是独立 runId？如何贯穿 tmux session、日志、决策 store、展示
3. tmux session 多项目并存的命名/隔离方案（`cc-<sid>`？）；单 tmux server 多 session
4. 前端（dashboard/decisions.html）与后端解耦（衔接 backlog「server 前后端分离」）——前端只启动一次后如何发现/切换不同 run 的 server

## 承接关系

- 衔接 backlog：server 前后端分离重构
- 本方向落地前，T1-027 类「真 run 冒烟」仍需在**独立 shell / 非 run 上下文**里执行
