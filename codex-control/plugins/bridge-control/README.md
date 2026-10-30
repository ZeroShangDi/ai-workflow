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

任务事件只写入本地事件总线，不经过 Hub。事件总线默认位于：

```text
~/.codex-control/events/task-events.jsonl
```

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
CODEX_CONTROL_EVENT_DIR
BRIDGE_CONTROL_PROFILE
BRIDGE_CONTROL_DEV
```

凭据只能通过环境变量或私有文件提供，不能写进工具参数。CMB 源码保持只读；本插件使用自己的公开 HTTP/SSE 客户端。

## 启动

```sh
BRIDGE_CONTROL_CMB_BASE_URL=http://127.0.0.1:18787 \
BRIDGE_CONTROL_CMB_USERNAME=admin \
BRIDGE_CONTROL_CMB_PASSWORD_FILE=/absolute/private/path/cmb-password \
BRIDGE_CONTROL_PROFILE=voice-controller \
node server.mjs
```

`server.mjs` 是 stdio MCP 服务。`.mcp.json` 默认关闭，只用于可信宿主按需加载，不作为普通全局插件安装入口。

## 创建与授权

1. `bridge_chat_create` 先形成草稿，不直接创建任务。
2. 草稿完整后返回 `awaiting_confirmation`，记录当前真实用户转写。
3. Voice Control 将最终用户语音写入共享语音转写事件文件。
4. `bridge_chat_confirm` 重新读取最新转写，只有明确肯定的新发言才能创建 CMB 任务。
5. 模型不能通过布尔值自授权；同一条转写不能重复授权两个任务。

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
