# Bridge Control

`bridge-control` 是独立的内部控制插件。它直接通过 CMB 的公开 HTTP/SSE API 创建、查询和控制任务，不依赖 `bridge-hub`，也不依赖 `voice-control` 的源码或内部接口。

生产环境由可信宿主按会话选择 profile：

| Profile | 能力 |
| --- | --- |
| `voice-controller` | 创建、查找、状态、发送、读取、事件、问题回答、审批和停止 |
| `work-reporter` | 进度、问题、审批请求、产物和任务结束 |

默认 profile 是权限更小的 `work-reporter`。两个 profile 的工具集完全隔离。

## 依赖关系

```text
bridge-control -> CMB public HTTP/SSE
bridge-control -> local event files -> voice-control
```

任务事件只写入配置指定的本地事件文件，不经过 Hub。Voice Control 与 Bridge Control 可以加载同一份 integration config；事件路径由配置中的 `eventFiles` 决定，不再默认写入 `~/.codex-control/events`。

Voice Control 使用同一目录接收任务进度、审批和完成通知。两边可以分别启动：

- 只安装 `bridge-control`：任务控制可用，但没有语音播报；
- 只安装 `voice-control`：普通语音聊天可用；
- 两者都安装：任务控制、进度播报和播放回执形成闭环。

## 配置

```text
BRIDGE_CONTROL_CMB_BASE_URL
BRIDGE_CONTROL_CMB_USERNAME
BRIDGE_CONTROL_CMB_PASSWORD
BRIDGE_CONTROL_CMB_PASSWORD_FILE
BRIDGE_CONTROL_CMB_TIMEOUT_MS
BRIDGE_CONTROL_DATA_DIR
BRIDGE_CONTROL_INTEGRATION_CONFIG
CODEX_CONTROL_EVENT_DIR
BRIDGE_CONTROL_PROFILE
BRIDGE_CONTROL_DEV
BRIDGE_CONTROL_WS_HOST
BRIDGE_CONTROL_WS_PORT
BRIDGE_CONTROL_WS_TOKEN_FILE
```

凭据只能通过环境变量或私有文件提供，不能写进工具参数。CMB 源码保持只读；本插件使用自己的公开 HTTP/SSE 客户端。

启动时可设置 `BRIDGE_CONTROL_INTEGRATION_CONFIG` 为 integration config 的绝对路径；MCP 内的 `bridge_chat_control_config_load` 也会在加载校验后立即切换 Control 的事件总线。该配置是通用输入，Control 不导入或调用 Voice Control 实现。`CODEX_CONTROL_EVENT_DIR` 仅作为未加载 integration config 时的显式兼容回退，不再有隐式主目录默认值。

## 启动

```sh
BRIDGE_CONTROL_CMB_BASE_URL=http://127.0.0.1:18787 \
BRIDGE_CONTROL_CMB_USERNAME=admin \
BRIDGE_CONTROL_CMB_PASSWORD_FILE=/absolute/private/path/cmb-password \
BRIDGE_CONTROL_PROFILE=voice-controller \
node server.mjs
```

`server.mjs` 是 stdio MCP 服务。`.mcp.json` 默认关闭，只用于可信宿主按需加载，不作为普通全局插件安装入口。

## WebSocket 事件接口

MCP 进程同时提供本地 WebSocket Server，默认监听 `127.0.0.1:8792`。Voice 使用私有 token 连接，双方都可以发布和订阅事件。

```text
voice.initialization.requested
voice.chat_session.create.requested
voice.chat_session.bind.requested
voice.chat.user
control.initialization.started
control.chat_session.ready / bound
control.chat.reply
task.created / task.progress / task.completed / ...
```

初始化会话位于独立的初始化工作空间，不在固定语音工作空间中。固定聊天创建成功后，Voice 才写回 `voiceSessionId` 并发送绑定事件。事件先写入 SQLite，再推送给已连接订阅者；JSONL 保留为兼容台账。

## 创建与授权

1. `bridge_chat_create` 先形成草稿，不直接创建任务。
2. 草稿完整后返回 `awaiting_confirmation`，记录固定 Codex 会话当前最新用户消息作为基线。
3. 后续语音/文本消息由该 Codex 会话原生持久化，Voice Control 不另建转写台账。
4. `bridge_chat_confirm` 从 CMB 会话历史重新读取最新用户消息，只有明确肯定的新发言才能创建 CMB 任务。
5. 模型不能通过布尔值自授权；同一条消息不能重复授权两个任务。

创建任务会话后，Control 会先解析 `bridge-control-work-reporter` 技能，再把该技能 ID 和任务请求一起发送。技能不存在时任务创建失败关闭，不会启动一个无法上报进度的任务。可信宿主仍需只为该工作会话启动 `work-reporter` MCP profile。

## 事件

任务事件使用有界、去重后的 JSONL：

```json
{
  "schemaVersion": 1,
  "eventId": "evt_...",
  "noticeId": "evt_...",
  "topic": "task.progress",
  "text": "正在整理文档",
  "source": "bridge-control",
  "sessionId": "vcs_...",
  "workId": "work_...",
  "createdAt": "2026-10-30T12:00:00.000Z",
  "payload": {}
}
```

Voice Control 在自己的 `notices.json` 中记录 `queued/spoken/interrupted/failed`，不把播报状态写回 Hub。

## 验证

```sh
npm test
```

测试使用 mock CMB，不需要真实凭据。端到端测试在仓库根目录运行：

```sh
npm run test:integration
```
