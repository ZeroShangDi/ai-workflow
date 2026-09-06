# cc-control / tmux-http（中文文档）

> 英文版见 [README.md](./README.md)。

通过 HTTP 驱动一个 tmux pane，控制**一个常驻的、交互式** Claude Code 会话。
聚焦于**输入**：发送消息、发送斜杠命令（`/clear` 及自定义命令）、保持多轮上下文。
"回合结束（ready）"的判断依靠 Claude Code 的 **hook 事件**，而非屏幕抓取——因此稳定、不随 TUI 版本漂移。

```
HTTP 客户端 ──POST──> server.js ──tmux send-keys──> [tmux pane: claude]
                          ^                                  │
                          └────── POST /hook <── curl <── Stop/UserPromptSubmit hook
```

## 工作原理

1. `claude` 跑在名为 `cc` 的 tmux 会话里（由 `bootstrap.sh` 启动）。
2. Node 服务收到 HTTP 请求后，用 `tmux send-keys` 把文本/按键打进那个 pane。
3. 被控 claude 的 `.claude/settings.json` 配了三个 hook，回合状态变化时用 `curl` 打回服务的 `/hook`，服务据此翻转 `ready`/`busy` 状态灯。

状态机：`SessionStart` / `Stop` → **ready**；`UserPromptSubmit` → **busy**。
`/send` 会阻塞直到 **ready**（最长 `CC_READY_TIMEOUT_MS`，超时返回 `409`），确保不会往还在忙的输入框里塞下一条。

## 前置条件

- `brew install tmux`
- `claude` 在 PATH 中（已登录）

## 运行

```sh
# 1. 启动控制服务（终端 A，先起，这样 claude 的 SessionStart hook 能打回来）
node server.js                 # 监听 127.0.0.1:8787

# 2. 启动被控 claude 会话（终端 B）
./bootstrap.sh                 # 渲染 hook -> ../sandbox/.claude/settings.json，起 tmux 会话 'cc'

# 3. 驱动它
curl -s localhost:8787/status
curl -s -X POST localhost:8787/send -H 'content-type: application/json' -d '{"text":"你好"}'

# 实时围观
tmux attach -t cc              # 脱离：先按 Ctrl-b，再按 d
```

> 首次进入全新的 `sandbox/` 目录会弹出 "trust this folder?" 确认框（默认接受），
> `bootstrap.sh` 会自动补一个 Enter 接受。

## 网页控制台

服务**同源**托管了一个控制台页面（免跨域），启动 `node server.js` 后浏览器打开：

```
http://127.0.0.1:8787
```

页面上可以：
- 输入框发消息（回车即发），右侧状态灯 `READY/BUSY` 随 hook 实时翻转；
- 一键发 `/clear`、`/compact` 等斜杠命令；
- 发原始按键：`Ctrl-C`（打断）、`Esc`、方向键等；
- 下方「Pane 实况快照」与 `tmux attach -t cc` 同步显示 Claude 的反应。

## HTTP 接口

| 方法 + 路径 | 请求体 | 作用 |
|---|---|---|
| `POST /send` | `{"text": "..."}` | 等到 ready → 打字 → 回车 |
| `POST /cmd`  | `{"cmd": "/clear"}` | 同上，用于斜杠命令（带一个兜底 ready 定时器） |
| `POST /key`  | `{"keys": "Escape"}` 或 `"C-c"` | 发原始 tmux 按键（打断 / 纠错） |
| `GET  /status` | — | 返回 `{state, session}`；加 `?snapshot=1` 附带 pane 快照 |
| `POST /hook` | `{"event": "Stop"}` | 内部接口——由被控 claude 的 hook 调用 |
| `GET  /` 或 `/ui` | — | 网页控制台 |

## 配置（环境变量）

| 变量 | 默认值 | 含义 |
|---|---|---|
| `CC_PORT` | `8787` | 服务端口 |
| `CC_SESSION` | `cc` | tmux 会话名 |
| `CC_WORKDIR` | `../sandbox` | 被控 claude 的工作目录 |
| `CC_READY_TIMEOUT_MS` | `120000` | `/send` 等待 ready 的超时（毫秒） |
| `CC_ENTER_DELAY_MS` | `200` | 打字与回车之间的间隔（毫秒） |
| `CC_LOCAL_CMD_MS` | `1500` | 本地命令（如 `/clear`）不触发 Stop 时的兜底翻灯延时 |

## 测试

```sh
./test/smoke.sh
```
验证两件事：多轮上下文留存（第 2 轮能召回数字）、`/clear` 清除上下文（第 3 轮不记得）。

## 已验证行为（Claude Code v2.1.197）

- 项目级 `settings.json` 里的 hook **无需审批直接执行**，不会被弹窗卡住。
- `UserPromptSubmit` 在提交时触发 → busy；`Stop` 在回合结束时触发 → ready。
- `/clear` 触发的是 **`SessionStart`** hook（不是 `Stop`），而它同样映射为 ready，
  因此 `/clear` 后就绪状态能正确恢复；`CC_LOCAL_CMD_MS` 兜底只是保险，实测未派上用场。
- 多轮上下文在多次 `/send` 之间保留；`/clear` 会清空。

## 已知脆弱点

- **就绪判断依赖 hook 触发。** `/clear` 已通过 `SessionStart` 映射覆盖；
  未知的本地命令则退回 `CC_LOCAL_CMD_MS` 兜底。
- **信任弹窗：** 首次进入全新 `sandbox/` 会有 "trust this folder?" 对话框，
  `bootstrap.sh` 发一个 Enter 接受。
- **多行输入未处理**（回车即提交），目前仅支持单行消息。
- 会话尺寸固定为 200x50；超长输出的换行只是显示问题，不影响功能。

## 收摊

```sh
# 终端 A：Ctrl-C 停服务
tmux kill-session -t cc        # 关闭被控会话
```

## 后续规划

- **多会话支持**：设计已留档于 [docs/multi-session-design.md](./docs/multi-session-design.md)
  （含 hook 反向路由这一关键点），暂缓实现。
- **返回内容捕获**：目前只有调试用的 pane 快照，尚无干净的"本回合回复文本"结构化输出，是下一步的重点课题。
