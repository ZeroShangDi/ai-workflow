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

任务事件写入配置指定的本地事件文件，并通过本地 WebSocket 实时推送，不经过 Hub。Voice 与 Bridge Control 可以加载同一份 integration config；事件路径由配置中的 `eventFiles` 决定，不再默认写入 `~/.codex-control/events`。

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

## MCP 工具完整清单（按当前实现）

入口为 `node server.mjs --profile <profile>`，通过 stdio JSON-RPC 提供 MCP；默认
`work-reporter`。下面的“必填”按 `src/tool-contracts.mjs` 的 schema 标注，业务层仍会
检查会话绑定及状态。两套 profile 的 MCP 工具互相隔离，只能由可信宿主加载。

| Profile | 工具 | 参数（`*` 为 schema 必填） | 用途 / 结果 |
| --- | --- | --- | --- |
| voice-controller | `bridge_chat_control_config_load` | `configPath*`（绝对路径） | 校验配置，切换当前进程的事件台账绑定 |
| voice-controller | `bridge_chat_control_workspace_ensure` | `createDirectory` | 检查固定工作区；明确设置创建时初始化目录 / 注册项目 |
| voice-controller | `bridge_chat_create` | `sessionId, draftId, binding, draft` | 创建 / 补全草稿；返回缺失字段或待确认摘要，不直接创建任务；draft 可含 project/request/title/cwd/agent |
| voice-controller | `bridge_chat_confirm` | `sessionId*, draftId*, binding*` | 重新读取最新真实用户发言，确认或取消草稿 |
| voice-controller | `bridge_chat_find` | `query*, limit` | 查找任务 / 会话候选 |
| voice-controller | `bridge_chat_status` | `sessionId, workId` | 查询任务状态、进度、待处理交互及结果 |
| voice-controller | `bridge_chat_send` | `text*, sessionId, workId, mode` | send / queue / steer，返回受理回执 |
| voice-controller | `bridge_chat_read` | `sessionId, workId, view, before, after, maxChars` | 读取 history/result/errors/activity/artifacts |
| voice-controller | `bridge_chat_events` | `sessionId, after, topics, limit` | 按游标读取事件台账，返回 events/nextCursor；当前实现不长轮询 |
| voice-controller | `bridge_chat_pending` | `sessionId*, interactionId*` | 读取问题 / 审批及不可变 binding |
| voice-controller | `bridge_chat_answer` | `sessionId*, interactionId*, binding*, answers*` | 提交 `{questionId, text}` 答案数组 |
| voice-controller | `bridge_chat_approve` | `sessionId*, interactionId*, binding*, decision*` | approve / reject；后端验证真实用户发言和交互绑定 |
| voice-controller | `bridge_chat_stop` | `sessionId, workId, reason` | 停止任务，与关闭语音会话分开 |
| work-reporter | `bridge_chat_emit_progress` | `sessionId*, text*, percent, artifact` | 上报进度，可附产物引用 |
| work-reporter | `bridge_chat_request_input` | `sessionId*, questions*, speak, expiresAt` | 创建问题交互，返回 interactionId/binding；问题含 questionId/prompt，可选 kind/choices |
| work-reporter | `bridge_chat_request_approval` | `sessionId*, operation*, target*, impact*, reversibility*, speak*, expiresAt` | 创建待审批交互 |
| work-reporter | `bridge_chat_publish_artifact` | `sessionId*, artifact*` | 注册产物引用；artifact 含 artifactId/kind/uri，可选 title |
| work-reporter | `bridge_chat_finish` | `sessionId*, outcome*, summary*, resultRef, artifactIds` | 结束任务：completed/failed/interrupted/blocked |
| voice-controller，仅 dev | `bridge_chat` | `text*, sessionId, project, title, timeoutMs` | `--dev` 或 `BRIDGE_CONTROL_DEV=1` 时额外开放的简单聊天工具，不用于授权 |

`bridge_chat_create` 的 sessionId 在业务层必需；status/send/read/stop 必须提供 sessionId 或 workId。

`bridge_chat_ack` 是内部宿主回调名称，不在任一 profile 的 MCP `tools/list` 中。
播放结果必须由音频宿主观察后上报，模型不能自行宣称已播放。

## WebSocket 消息与事件完整清单

本插件是 WS **服务端**，默认 `ws://127.0.0.1:8792`；可用
`BRIDGE_CONTROL_WS_ENABLED=0` 关闭。`voice-center` 的 Node host 和 Python runtime
都是客户端。令牌来自私有文件 / 环境变量，不放入 MCP 参数或文档示例。

### 协议消息（不是业务 topic）

| `type` | 方向（相对 Control） | 中文解释 | 关键字段 / 含义 |
| --- | --- | --- | --- |
| `hello` | 接收 | 客户端发起认证握手 | protocolVersion=1、client{id,version}、token、cursor；握手认证 |
| `hello.ack` | 发送 | 服务端确认握手成功 | protocolVersion、connectionId、server、cursor、capabilities |
| `subscribe` | 接收 | 客户端申请订阅事件 | topics；支持精确匹配及 `task.*` 这类前缀匹配 |
| `subscribe.ack` | 发送 | 服务端确认订阅范围 | 已接受的 topics |
| `event` | 双向 | 传递业务事件 | event 业务信封 |
| `event.ack` | 发送 | 确认事件已接收并入库 | eventId、cursor；表示事件已入库，不代表业务完成或已播放 |
| `replay.complete` | 发送 | 本次历史事件回放结束 | 本次回放后的 cursor |
| `error` | 发送 | 协议消息处理错误 | error{code,message}；协议错误，区别于业务 `control.error` |

服务端另使用原生 WS ping/pong 心跳。业务信封包含
`schemaVersion=1, eventId, correlationId, topic, source, createdAt, payload`；
服务端投递时增加字符串 `cursor`。客户端 source 必须与认证的 client.id 相同。
请求与响应通过 correlationId 关联。事件先写 SQLite，再推送；当前每次订阅最多
回放 1000 条，不能把回放结束理解为无限历史已全部补齐。持久化 / eventId 去重
不保证业务处理 exactly-once；外部写入结果未知时必须查询状态，不能盲目重发。

### 业务 topic

| Topic | 方向（相对 Control） | 中文解释 | payload 主要内容 / 触发条件 |
| --- | --- | --- | --- |
| `voice.initialization.requested` | 接收 | 请求启动语音控制初始化 | requestId(UUID)、configPath、workspacePath，可选 chatTitle/initializationTitle；启动独立初始化会话 |
| `control.initialization.started` | 发送 | 初始化会话已启动，尚未完成初始化 | initializationSessionId、skillId、receiptStatus；初始化已受理，不代表完成 |
| `control.initialization.failed` | 发送 | 初始化启动失败 | code、message、initializationSessionId；缺少初始化技能 |
| `voice.chat_session.create.requested` | 接收 | 请求创建或复用固定语音聊天会话 | requestId(UUID)、projectKey、workspacePath，可选 chatTitle；创建 / 复用固定会话 |
| `control.chat_session.ready` | 发送 | 固定聊天会话已创建或复用，可进行绑定 | voiceSessionId、projectKey、workspacePath、title、reused |
| `control.chat_session.failed` | 发送 | 固定聊天会话准备失败 | code、message，可含 candidates；工作区不存在 / 不匹配 / 多个会话候选 |
| `voice.chat_session.bind.requested` | 接收 | 请求校验并绑定已有固定聊天会话 | voiceSessionId；校验并绑定固定会话 |
| `control.chat_session.bound` | 发送 | 固定聊天会话已校验并绑定 | voiceSessionId、title、status、cwd |
| `voice.chat.user` | 接收 | 将真实用户发言提交给固定控制会话 | voiceSessionId、text；提交真实用户发言到固定 Control 会话 |
| `control.chat.reply` | 发送 | 返回控制会话已完成的助手回复 | voiceSessionId、messageId、turnId、text；已完成的助手回复 |
| `control.chat.failed` | 发送 | 本次控制会话对话失败 | code、message；会话忙或发送失败 |
| `voice.playback.result` | 接收 | 上报宿主观察到的通知播放结果 | noticeId、status，可含 message/sessionId；宿主实际观察的 spoken/interrupted/failed |
| `control.playback.recorded` | 发送 | 控制端确认收到播放结果，当前仅回显 | noticeId、status；当前仅回显确认，播放状态由 Voice 自己持久化 |
| `control.tool.call.requested` | 接收，可信内部调用 | 可信客户端请求调用指定权限组的工具 | profile、tool、threadId、arguments；WS 工具网关，使用对应 profile 的业务工具校验 |
| `control.tool.call.completed` | 发送 | 工具调用完成，返回业务结果 | profile、tool、result |
| `control.tool.call.failed` | 发送 | 工具调用网关不可用 | code、message；当前用于工具网关未配置 |
| `control.error` | 发送 | 请求发生通用业务错误或事件不受支持 | code、message；通用业务异常或不支持的 topic，也可能作为上述任一请求的失败响应 |
| `task.created` | 发送 | 任务已创建并受理 | 任务已创建；详情含 workId/workSessionId/title/project/controlSessionId |
| `task.progress` | 发送 | 任务进度更新 | 进度上报 / CMB 活动；详情可含 percent/artifact 或 remoteStatus |
| `task.completed` | 发送 | 任务已完成 | completed 结束；详情含 outcome/summary/resultRef/artifactIds |
| `task.failed` | 发送 | 任务失败或阻塞，按 outcome 区分 | failed **或 blocked** 结束；用详情 outcome 区分，无独立 task.blocked topic |
| `task.interrupted` | 发送 | 任务已中断 | interrupted 结束；详情同终态事件 |
| `task.stopped` | 发送 | 任务已被主动停止 | 主动停止任务 |
| `interaction.requested` | 发送 | 请求用户回答问题或审批操作 | 完整问题 / 审批交互，含 interactionId/binding/kind/expiresAt 及问题或操作描述 |
| `interaction.answered` | 发送 | 问题或审批已处理 | interactionId、kind 及 answers 或 decision |
| `artifact.ready` | 发送 | 任务产物已就绪 | workId、artifact、controlSessionId |

任务 / 交互 / 产物事件的 WS `event.payload` 是完整 JSONL 事件，含
`eventId, noticeId, topic, text, source, sessionId, workId, createdAt, payload, dedupeKey`
及 schemaVersion；上表“详情”位于 **`event.payload.payload`**。这与聊天 / 初始化
响应直接将结果字段放在 `event.payload` 的结构不同。

WS 工具网关按请求中的 profile 选择工具集；共享令牌本身不提供逐客户端 profile
授权，threadId 当前用于补齐 sessionId。该网关只供可信宿主内部使用，不应作为
普通工作会话的直连入口；工作会话仍只能加载 work-reporter。

实现核对入口：[`tool-contracts.mjs`](src/tool-contracts.mjs)、
[`ws-server.mjs`](src/ws-server.mjs)、[`ws-service.mjs`](src/ws-service.mjs)、
[`direct-backend.mjs`](src/direct-backend.mjs)、[`server.mjs`](server.mjs)。
