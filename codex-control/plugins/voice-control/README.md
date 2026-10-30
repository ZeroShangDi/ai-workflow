# Voice Control

`voice-control` 是独立安装、独立启动的语音插件。它自己负责语音页面、ASR/TTS、对话闭环、会话事件、任务播报队列和播放回执，不依赖 `bridge-hub` 或 `bridge-control` 的接口。

## 独立能力

只安装并启动 `voice-control` 时：

```text
语音输入 -> ASR -> 对话模型 -> assistant 文本 -> TTS -> 播放回执
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
CODEX_CONTROL_EVENT_DIR
```

对话后端使用 OpenAI-compatible `/chat/completions` 协议。没有配置对话后端时，页面、会话、任务播报和回执仍可运行，但普通聊天会明确返回 `chat_not_configured`。

事件目录默认是 `~/.codex-control/events`。Voice Control 从 `task-events.jsonl` 读取 `bridge-control` 产生的任务事件，把通知状态保存在自己的 `data/notices.json` 中。

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
