# Voice Control

`voice-control` 是独立安装、独立启动的语音插件。它负责语音页面、WebRTC 会话、事件流、任务播报队列和播放回执；实时 ASR、VAD、对话和流式 TTS 由配置的语音后端提供。

## 独立能力

只安装并启动 `voice-control` 时：

```text
浏览器 WebRTC 音频 -> 服务端 VAD/ASR -> 对话模型 -> 流式 PCM TTS -> WebRTC 播放
```

页面只有一个语音开关、状态文字和对话文字。用户开始说话时打断当前播报；后台任务通知只在对话空闲时播放。

## 配置

```text
VOICE_CONTROL_HOST
VOICE_CONTROL_PORT
VOICE_CONTROL_DATA_DIR
VOICE_CONTROL_ALLOWED_ORIGINS
VOICE_CONTROL_CHAT_URL
VOICE_CONTROL_CHAT_API_KEY
VOICE_CONTROL_CHAT_API_KEY_FILE
VOICE_CONTROL_CHAT_MODEL
VOICE_CONTROL_CHAT_TIMEOUT_MS
VOICE_CONTROL_AUDIO_SERVICE_URL
VOICE_CONTROL_AUDIO_TIMEOUT_MS
VOICE_CONTROL_TICKET_SECRET_FILE
VOICE_CONTROL_TENANT
VOICE_CONTROL_USER
VOICE_CONTROL_DEVICE
VOICE_CONTROL_LLM_UPSTREAM_URL
VOICE_CONTROL_LLM_UPSTREAM_API_KEY_FILE
VOICE_CONTROL_LLM_TIMEOUT_MS
VOICE_CONTROL_SEARCH_URL
VOICE_CONTROL_SEARCH_TOKEN_FILE
VOICE_CONTROL_SEARCH_TIMEOUT_MS
VOICE_CONTROL_INTEGRATION_CONFIG
VOICE_CONTROL_CONTROL_WS_URL
VOICE_CONTROL_CONTROL_WS_TOKEN_FILE
```

实时语音使用 WebRTC。票据由 Voice Control 签发，SDP offer 通过本插件代理到语音后端，页面不接触上游凭据。`VOICE_CONTROL_TICKET_SECRET_FILE` 必须与语音后端使用的票据密钥一致。

联网聊天由 Voice Control 的 OpenAI-compatible LLM 代理处理。Control 可用且固定会话已初始化时，代理把最终用户文本发送到固定 Codex 会话；Control 不可用时回退到独立模型与搜索链路。语音后端应把 `VOICE_LLM_URL` 指向本插件 `/v1`。

HTTP 服务默认读取插件内的 `config/settings.json`，也可以通过 `VOICE_CONTROL_INTEGRATION_CONFIG` 指向绝对路径配置。Control WebSocket 地址和任务事件兼容台账路径都从该配置解析。通知状态保存在自己的 `data/notices.json` 中。

启动前必须保证配置中的 `eventFiles.taskEvents` 是预期文件；语音插件自身启动不依赖 Control、人物设定插件或 Hub。语音聊天记录由固定 Codex 会话持久化，不由 Voice Control 另建转写台账。

Voice 启动后会尝试连接 Control WebSocket。握手失败时继续独立运行；握手成功时，`/api/open` 会先完成固定工作空间和固定会话的初始化或绑定，再打开语音。

## 启动

```sh
npm start
```

默认地址：`http://127.0.0.1:8791/`。

## 公共接口

Voice Control 对外只保留三个主要宿主接口：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/open` | 打开语音会话 |
| `POST` | `/api/close` | 关闭语音会话 |
| `POST` | `/api/tunnel` | 接收通用外部事件和任务通知 |

兼容与内部调试接口仍保留：

- `POST /api/sessions/:id/chat`：执行一次文本对话；
- `POST /api/voice/session`：签发短时一次性语音票据；
- `POST /api/voice/offer`：代理 WebRTC SDP offer；
- `POST /v1/chat/completions`：对话模型代理，并按需注入联网搜索结果；
- `GET /api/sessions/:id/events`：SSE 事件流；
- `POST /api/sessions/:id/events`：追加转录、语音状态或播放回执；
- `GET /api/notices`：查看尚未完成的通知；
- `GET /api/health`：健康状态。

Hub、移动 App 或未来其他宿主通过 `open/close/tunnel` 接入，不允许 Voice Control 反向依赖 Hub。

## 事件与回执

外部任务事件示例：

```json
{
  "eventId": "evt_123",
  "noticeId": "evt_123",
  "topic": "task.progress",
  "text": "正在整理文档",
  "sessionId": "vcs_123"
}
```

通知在 Voice Control 内经过：

```text
queued -> delivered -> spoken | interrupted | failed
```

页面实际观察完 TTS 状态后提交回执；插件不把“已生成文本”误记为“已播报”。

## 开发与验证

```sh
npm test
```

测试使用 fake chat provider 和临时事件目录，不需要真实模型、麦克风、CMB 或播报设备。跨插件闭环在仓库根目录运行：

```sh
npm run test:integration
```
