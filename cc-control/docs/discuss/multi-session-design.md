# 多会话（multi-session）设计留档

状态：**已设计，暂缓实现**。当前代码仍是单会话。等其他功能完善后再动手。
决策：采用**方案 B**（CLI 创建会话、UI 只做发现/切换）。

## 目标

把当前单会话的 tmux-http 控制方案扩展为多会话：

- 可同时启用多个跑着 `claude` 的 tmux 会话（会话名 `cc-<id>`）。
- HTTP 接口增加 `id` 参数，路由到不同会话实例。
- 页面顶部增加 tabs 切换会话，`?id=<sessionId>` 同步到 URL。
- 仍然只有**一个** Node 服务、一个端口，靠 `id` 分流。

## 关键点（成败地基）：hook 回调的反向路由

这是整个多会话设计里**最容易被忽略、但决定方案是否成立**的一环。

现在 hook 把
```
curl .../hook -d '{"event":"Stop"}'
```
**写死**在被控 claude 的 `.claude/settings.json` 里。多会话后，服务收到一个 `Stop` 事件时，**无法判断是哪个会话的回合结束了**——所有会话打回来的 payload 完全相同，会翻错某个会话的 ready/busy 灯。

**解决办法**：像现在渲染 `__PORT__` 一样，bootstrap 时把 `__ID__` 也渲染进**每个会话各自的** `settings.json`，让 curl 带上会话身份：
```
curl .../hook -d '{"event":"Stop","id":"<sessionId>"}'
```
服务端按 `body.id` 找到对应会话的状态机再翻灯。

**推论**：每个会话**必须有独立 workdir**（如 `sandbox/<id>`），不能共用一个 sandbox——因为 `settings.json` 是随目录走的，共用就分不开 id。这条是多会话的前提。

## 改动面清单

- **tmux.js**：去掉模块级 `SESSION` 常量；每个函数（`hasSession`/`sendText`/`sendEnter`/`sendKeys`/`capture`）接收 `sessionId`，内部用 tmux 会话名 `cc-<id>`。
- **server.js**：
  - 模块级的 `state` / `waiters` 全局 → 改成 `Map<id, { state, waiters }>`，每个会话一台独立状态机。
  - `/send`·`/cmd`·`/key`·`/status` 从 `?id=` 读会话 id（缺省可保留一个默认 id 兼容旧用法）。
  - `/hook` 从 `body.id` 路由到对应会话状态机。
  - 新增 `GET /sessions`：列出当前活跃会话（`tmux ls` 按 `cc-` 前缀过滤 + 已知状态），供 UI 渲染 tabs。
- **bootstrap.sh**：接收 `id` 参数（如 `./bootstrap.sh myid`）；建 `sandbox/<id>` workdir；渲染 `__PORT__` 与 `__ID__` 到该目录的 `settings.json`；tmux 会话名用 `cc-<id>`。
- **hooks/settings.json**：curl payload 增加 `"id":"__ID__"` 占位符。
- **ui.html**：顶部 tabs（数据来自 `GET /sessions`）；切 tab 时更新 `?id=` 并把后续请求都带上该 id；初始从 URL 的 `?id=` 恢复选中。

## id 约束

`id` 同时用作 tmux 会话名后缀和目录名，必须校验字符集：只允许 `[A-Za-z0-9_-]`，拒绝其他，避免命令/路径注入。

## 方案 A vs B（已选 B）

- **A. UI 内管理会话**：页面提供「+ 新建 / 关闭」按钮，服务负责 spawn/kill `bootstrap.sh` 与 claude 进程。体验一站式，但服务要背进程生命周期，复杂度和出错面更大。
- **B. CLI 建、UI 只切换（已选，先做这个）**：用户在终端 `./bootstrap.sh <id>` 建会话，页面只负责**发现**并在 tabs 间切换/发消息。改动最小、最稳，符合"测试控制方案"边试边看的定位。将来要 A 再在其上叠加。

## 未决 / 后续

- 会话被 kill 后 UI tab 的清理与状态回收。
- `GET /sessions` 里每个会话的 state 如何持久（目前 state 只在内存，服务重启会丢；单会话时无所谓，多会话可考虑靠 `/status` 主动探测补齐）。
- 与"返回内容捕获"层的关系：那一层实现后也要按 `id` 分流。
