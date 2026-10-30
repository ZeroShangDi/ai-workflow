# Bridge Control

`bridge-control` 是 `bridge-hub` 加载的内部控制插件，不是普通全局 Codex 插件。生产环境只能由可信 Hub 按会话选择 profile 并注入 Hub 客户端；不要把 `.mcp.json` 当成生产安装入口。

## Profiles

| Profile | 使用位置 | 能力 |
| --- | --- | --- |
| `voice-controller` | 专用语音或 App 控制会话 | 创建、查找、状态、发送、读取、事件、待处理、回答、审批、停止 |
| `work-reporter` | 由控制器创建的工作会话 | 进度、提问、审批请求、产物、结束 |

默认 profile 是权限更小的 `work-reporter`。两个 profile 的工具集完全隔离，不能在一次加载中同时暴露。

所有模型可见的新工具均使用 `bridge_chat_` 前缀。`bridge_chat_ack` 只供语音宿主内部回执，不属于模型工具。

## Hub 边界

本插件不导入 CMB 源码，也不直接访问 CMB HTTP/SSE。Hub 负责具体软件适配、持久化和会话绑定；插件只依赖 `src/hub-client.mjs` 中声明的接口。

`voice-controller` 需要 Hub 提供：

```text
latestUserTranscript
getPending
createWork
findWork
getStatus
sendMessage
readWork
readEvents
resolveAnswer
resolveApproval
stopWork
ackAnnouncement
```

`work-reporter` 需要 Hub 提供：

```text
emitProgress
requestInput
requestApproval
publishArtifact
finishWork
```

Hub 返回的审批或问题必须带有稳定 `interactionId` 和 `binding`。插件在回答、批准前重新读取待处理记录并核对二者，同时把 Hub 提供的最新真实用户转写交给 Hub 验证。

Hub 的 `latestUserTranscript` 必须返回稳定的 `turnId` 或 `sequence`；插件用它判断确认与审批是否来自提示之后的新用户发言。

## 创建状态机

```text
needs_input -> awaiting_confirmation -> confirmed
                                     -> cancelled
```

1. `bridge_chat_create` 缺少项目或任务描述时返回 `needs_input`，不会创建工作。
2. 模型在同一语音会话中补充字段，工具仍返回同一个 `draftId` 和 `binding`。
3. 草稿完整后返回 `awaiting_confirmation`，记录当前用户转写作为确认基线。
4. `bridge_chat_confirm` 不接收模型确认布尔值，只读取 Hub 的最近真实用户转写。
5. 只有基线之后的新转写明确为“确认/是/可以”等肯定词时才调用 Hub 创建工作；明确否定则取消；其他内容保持待确认。
6. 创建写入结果未知时进入不可自动重试状态，必须先与 Hub 对账。

## 本地开发

选择 profile：

```sh
BRIDGE_CONTROL_PROFILE=voice-controller node server.mjs
```

也可以使用参数：

```sh
node server.mjs --profile work-reporter
```

本地 MCP 调用需要一个导出 `createHubClient({ env })` 的 Hub 模块：

```sh
BRIDGE_CONTROL_HUB_MODULE=/absolute/path/to/bridge-hub/src/control-client.mjs \
BRIDGE_HUB_URL=http://127.0.0.1:4310 \
BRIDGE_HUB_API_TOKEN=local-development-token \
BRIDGE_CONTROL_CONSUMER=bridge-control \
BRIDGE_CONTROL_PROFILE=voice-controller \
node server.mjs
```

工作会话使用同一客户端并把 `BRIDGE_CONTROL_CONSUMER` 切换为已配对、已订阅的
`work-reporter` 标识。远端 MCP 集成可复用 `tests/fake-hub.mjs`，但 fake Hub
只能用于测试，不能作为部署后端。

只有同时满足 `voice-controller` 且显式传入 `--dev` 或 `BRIDGE_CONTROL_DEV=1` 时，才暴露历史便利工具 `bridge_chat`。它只用于本地快速联调，不能用于创建确认、审批或后台通知。

## 写入安全

- 所有写调用携带调用方生成的幂等键。
- Hub 返回 `unknown`、`UNKNOWN_RESULT` 或超时异常时，插件返回 `retryable: false`，不会自动重放。
- 审批和回答的绑定缺失、过期或与待处理记录不一致时直接拒绝。
- 工具只返回事实、提示词和可选播报文本，不合成或播放音频。
- 插件安装不代表 Hub 已配置、已配对或已订阅事件。

## 测试

```sh
npm test
```

测试使用 fake Hub，不需要 CMB、ASR/TTS 或真实凭据，覆盖 profile 隔离、创建状态机、问题/审批绑定、unknown 写入、MCP 暴露面和无 CMB 导入。
