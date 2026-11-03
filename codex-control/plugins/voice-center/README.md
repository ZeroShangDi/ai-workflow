# Voice Center

`voice-center` is the self-contained successor voice plugin. The market voice-service core is copied into `backend/`; no ai-market source or service is imported at runtime.

```text
Node host: page, open/close/tunnel, SSE, notice ledger, Control integration
Python backend: WebRTC, VAD, ASR, LLM, streaming TTS, task notices
SQLite: append-only local transcript history
```

## Capability modes

- `voice_history`: always on; local SQLite is core-owned, external conversation mirroring is optional.
- `web_search`: always loaded; requires a configured external agent search service and token.
- `work_market`: retained optional market/mobile host integration; select explicitly with `VOICE_CENTER_WORK_MODE=market`.
- `work_control` (default): Control conversation delegation over public WebSocket; selected with `VOICE_CENTER_WORK_MODE=control`.
- `none`: voice chat and history only.

`GET/PUT /api/config/work-mode` reads or persists the mode. A mode change applies on the next backend start. Only one work capability is loaded at a time.

## Start

```sh
uv venv .local/runtime-venv --python 3.12
uv pip install --python .local/runtime-venv/bin/python -e backend
npm start
```

Default port: `8891`.

Work Control forwards host-observed speech once to the fixed Control conversation, which owns drafts and subsequent confirmation. It requires initialized Control configuration and its trusted voice-controller profile. Market work integration is retained but not enabled by default. It still requires the external services and mobile host bridge. Explicitly saved none mode is respected.

## 对外接口清单（按当前实现）

此处记录新版 `voice-center`，旧版 `voice-control` 的接口文档仍位于其自身目录。
Node host 默认地址为 `http://127.0.0.1:8891`。主要宿主接入面是
`open/close/tunnel`；其余是当前实现的会话、配置、音频及兼容接口。

### HTTP / SSE

| 方法 | 路径 | 输入 | 用途 / 主要返回 |
| --- | --- | --- | --- |
| POST | `/api/open` | 可选 title | 初始化 / 绑定 Control 后打开本地会话；返回 session、integration；Control 不可用时可独立运行 |
| POST | `/api/close` | sessionId | 关闭本地会话，返回 session |
| POST | `/api/tunnel` | 外部通知或 transcript/voice/activity 事件 | 接收通知并进入本地台账 / 播报队列；transcript 仅允许 assistant/system 且须 sessionId |
| GET | `/api/health` | 无 | 健康、配置、音频、Control 连接及通知状态；安装不等于已配对 / 激活 |
| GET | `/api/notices` | 可选 query sessionId | 查询待完成通知 |
| POST | `/api/voice/session` | 无 | 签发短时一次性 WebRTC ticket，返回 mode/ticket |
| POST | `/api/voice/offer` | ticket、sdp，可选 type=offer | 代理 SDP 交换，返回 answer 的 type/sdp |
| POST | `/api/sessions` | 可选 title | 直接创建本地会话，不执行 `/api/open` 的 Control 初始化流程 |
| GET | `/api/sessions/:id` | 路径会话 ID | 获取本地会话摘要 |
| POST | `/api/sessions/:id/close` | 路径会话 ID | 兼容会话关闭入口 |
| POST | `/api/sessions/:id/chat` | text | 文本对话，返回 turnId/userEvent/assistantEvent；使用配置的 chat provider |
| GET | `/api/sessions/:id/events` | Last-Event-ID 或 query after | SSE：回放当前进程内的会话事件并实时订阅；Last-Event-ID 优先 |
| POST | `/api/sessions/:id/events` | 带 type 的事件，见下表 | 追加转写 / 状态 / 播放回执等；返回 duplicate/event |
| GET | `/api/config/work-mode` | 无 | mode、可选模式 control/market/none |
| PUT | `/api/config/work-mode` | mode | 持久化工作模式；restartRequired=true，下次后端启动生效 |
| GET | `/api/config/triggers` | 无 | 返回 trigger 配置 |
| PUT | `/api/config/triggers` | schemaVersion=1、triggers 数组 | 替换 trigger 配置；每项含 id/enabled/topics，可选 description |
| POST | `/api/triggers/:id/dispatch` | sessionId、noticeId、topic、text，可选 eventId/dedupeKey | 给已启用且订阅该 topic 的 trigger 投递事件 |
| POST | `/v1/chat/completions`、`/chat/completions` | OpenAI-compatible 请求 | LLM 代理；按配置使用 Control / 独立模型及搜索，返回 JSON 或流式 SSE |
| GET / HEAD | `/`、`/index.html`、`/app.js`、`/styles.css` | 无 | 语音页面及静态资源 |

外部通知常用字段为 `eventId, noticeId, topic, text, sessionId, source, payload`；
无 sessionId 时投递给最近打开的本地会话，重复通知按 ID 去重。固定 Codex 会话的
voiceSessionId 与这里的本地会话 ID 是两种标识。
HTTP JSON 请求上限为 1 MiB，来源受同源 / allowedOrigins 校验。
SDK [`sdk/index.mjs`](sdk/index.mjs) 提供 getHealth/open/close/tunnel、
createSession/closeSession/appendEvent/dispatchTrigger/subscribe；未封装全部 HTTP 路由。

Python 音频后端另有内部 `GET /health` 和 `POST /offer`；后者使用 Node 签发的
Bearer ticket，浏览器应经 `/api/voice/offer` 代理，不直接访问内部后端。

### 配置 MCP

入口 `npm run start:mcp`（`node server.mjs`）仅提供配置工具，不负责启动 HTTP / 音频服务。

| 工具 | 输入 | 用途 |
| --- | --- | --- |
| `bridge_chat_voice_config_load` | configPath（绝对路径） | 校验并加载 integration config |
| `bridge_chat_voice_config_update` | 已加载的 configPath、workspace | 原子更新工作区字段；workspace 允许 path/projectKey/voiceSessionId/voiceSessionTitle/initialized |

## WebSocket 事件清单

Voice Center **没有独立 WS 服务端**。Node host 以 `voice-center` 身份连接
Bridge Control 的 WS 服务端，默认订阅 `control.* / task.* / interaction.* / artifact.*`。
Python `work_control` 能力以 `voice-center-runtime` 身份连接同一服务端，转交宿主观察到的
真实用户发言；默认 Control 工作模式由固定 Control 会话负责草稿、补充信息和后续确认。

| Topic | 方向（相对 Voice） | 中文解释 | 用途 / payload |
| --- | --- | --- | --- |
| `voice.initialization.requested` | Node 发送 | 请求启动语音控制初始化 | requestId、configPath、workspacePath、chatTitle；请求初始化 |
| `voice.chat_session.create.requested` | Node 发送 | 请求创建或复用固定语音聊天会话 | requestId、projectKey、workspacePath、chatTitle；请求固定会话 |
| `voice.chat_session.bind.requested` | Node 发送 | 请求校验并绑定已有固定聊天会话 | requestId、projectKey、voiceSessionId；绑定固定会话 |
| `voice.chat.user` | Node 或 Python 发送 | 将真实用户发言提交给固定控制会话 | voiceSessionId、text；真实用户发言；同一次工作转交不再额外 create/confirm |
| `voice.playback.result` | Node 发送 | 上报宿主观察到的通知播放结果 | noticeId、status、message、sessionId；收到宿主 delivery 事件后上报 |
| `control.initialization.started` | 接收 | 初始化会话已启动，尚未完成初始化 | initializationSessionId、skillId、receiptStatus；随后观察 Voice 自有配置变更 |
| `control.initialization.failed` | 接收 | 初始化启动失败 | code、message、initializationSessionId |
| `control.chat_session.ready` | 接收 | 固定聊天会话已创建或复用，可进行绑定 | voiceSessionId、projectKey、workspacePath、title、reused；Voice 自己保存配置 |
| `control.chat_session.failed` | 接收 | 固定聊天会话准备失败 | code、message，可含 candidates |
| `control.chat_session.bound` | 接收 | 固定聊天会话已校验并绑定 | voiceSessionId、title、status、cwd |
| `control.chat.reply` | 接收 | 返回控制会话已完成的助手回复 | voiceSessionId、messageId、turnId、text |
| `control.chat.failed` | 接收 | 本次控制会话对话失败 | code、message |
| `control.playback.recorded` | 接收 | 控制端确认收到播放结果，当前仅回显 | noticeId、status；不是音频实际完成的依据 |
| `control.error` | 接收 | 请求发生通用业务错误或事件不受支持 | 通用业务错误 code/message |
| `task.created` | 接收 | 任务已创建并受理 | 任务创建通知 |
| `task.progress` | 接收 | 任务进度更新 | 任务进度通知 |
| `task.completed` | 接收 | 任务已完成 | 任务完成通知 |
| `task.failed` | 接收 | 任务失败或阻塞，按 outcome 区分 | 任务 failed 或 blocked，依据内层 outcome 区分 |
| `task.interrupted` | 接收 | 任务已中断 | 任务中断通知 |
| `task.stopped` | 接收 | 任务已被主动停止 | 主动停止通知 |
| `interaction.requested` | 接收 | 请求用户回答问题或审批操作 | 问题 / 审批通知及 binding |
| `interaction.answered` | 接收 | 问题或审批已处理 | 问题 / 审批已处理通知 |
| `artifact.ready` | 接收 | 任务产物已就绪 | 产物就绪通知 |

Node 将任务 / 交互 / 产物的 `event.payload` 送入本地 tunnel；它是完整通知对象，
具体业务详情在 `event.payload.payload`。`control.*` 中还可能订阅到
`control.tool.call.completed/failed`，但 Voice 当前没有主动调用 WS 工具网关的路径，
不将它们列为 Voice 自有能力。

WS 的 hello/subscribe/event/event.ack/replay.complete/error 信封、认证、游标及完整
Control topic 表见 [Bridge Control 文档](../bridge-control/README.md#websocket-消息与事件完整清单)。
`event.ack` 只代表接收 / 入库；超时或未知外部写入结果不能作为自动重放任务的理由。
Node 保存 WS cursor 并自动重连；JSONL 是任务通知的兼容补读路径。

## 页面事件：SSE 与 WebRTC DataChannel

以下事件不是 WebSocket topic。SSE 信封含 schemaVersion/eventId/cursor/sessionId/type/
createdAt 及类型字段；事件保存在 Node 内存中，进程重启后不能用旧游标恢复。
这与 Python 自有 SQLite 转写历史、Control 的 SQLite WS 台账各自独立。

| SSE `event` / JSON `type` | 主要字段 | 含义 |
| --- | --- | --- |
| `session.opened` | state=idle、message | 本地会话打开 |
| `session.closed` | state=idle、message | 本地会话关闭 |
| `transcript` | role=user/assistant/system、text | 转写 / 对话文字 |
| `activity` | state=listening/thinking/speaking/working | 活动状态 |
| `voice` | state、可选 event/message | 语音状态；state 另支持 warning/error/idle；event 可为 user_started/user_stopped/bot_started/bot_stopped |
| `trigger` | topic、noticeId、text | 外部通知进入当前页面会话 |
| `delivery` | noticeId、state、message | 播放回执；POST 输入字段为 status=spoken/interrupted/failed，SSE 输出归一化为 state |
| `stream.end` | reason，可含 cursor/event | SSE 结束帧，不是可 POST 的会话事件 |

DataChannel 传递 Pipecat 应用消息，区别于以上 HTTP SSE 信封。

| DataChannel JSON `type` | 方向 | 主要字段 / 含义 |
| --- | --- | --- |
| `transcript` | Python → 页面 | role=user/assistant、text；识别 / 助手文字 |
| `voice` | Python → 页面 | state、event/message；说话开始 / 结束及告警 |
| `task_notice` | 页面 → Python | id、text；后台通知排队播报 |
| `task_notice_cancel` | 宿主 → Python | id；取消尚未播报的通知，后端支持，当前页面未主动发送 |
| `task_notice_ack` | Python → 页面 | id；通知处理回执；页面随后提交 delivery，Node 再发 voice.playback.result |

播放状态由 Voice 的通知台账持久化，Control 不拥有它。spoken/interrupted/failed
必须来源于宿主观察的音频状态；不能把文本生成、WS 入库或 Control 的回显当成播放完成。

实现核对入口：[`http.mjs`](src/http.mjs)、[`server.mjs`](server.mjs)、
[`control-ws-client.mjs`](src/control-ws-client.mjs)、[`main.mjs`](src/main.mjs)、
[`events.mjs`](src/events.mjs)、[`web/app.js`](web/app.js)、
[`work_control`](backend/voice_center_backend/capabilities/work_control/__init__.py)。

## 可选千问全双工模式

默认仍为现有 ASR → LLM → TTS 流水线。以下配置在下次 `npm start` 时生效，
不更改已有 `open/close/tunnel` 和 Control WS 契约，也不增加 Control 工具。
语音模式与 `VOICE_CENTER_WORK_MODE=control/market/none` 相互独立。

```sh
export VOICE_CENTER_VOICE_MODE=qwen-realtime
export VOICE_CENTER_QWEN_REALTIME_URL='wss://你的业务空间.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime'
export VOICE_CENTER_QWEN_API_KEY_FILE='/absolute/private/qwen-api-key'
export VOICE_CENTER_QWEN_MODEL=qwen-audio-3.1-realtime-flash
npm start
```

请按账户 / 地域填写官方提供的真实 WS 地址。Key 仅由 Python 后端读取，不进入
页面、票据或工具参数。千问模式不要求配置原 ASR/LLM/TTS 的服务凭据；切回
`VOICE_CENTER_VOICE_MODE=pipeline`（或不设置该变量）即可恢复原模式。
不在通话中自动切换后端，不自动重连并重放用户音频或任务写入。

实现和全部情感 / 环境策略集中在
[`backend/voice_center_backend/realtime_qwen/`](backend/voice_center_backend/realtime_qwen/README.md)，
包含模块内的浏览器播放器。情绪增强、音色、说话人增强等后续扩展继续限定在这个模块，
共享页面和控制插件只处理通用生命周期与播放结果。

千问模式保留 WebRTC 麦克风输入，以模块内的 DataChannel PCM 播放器输出音频，
用于准确停止排队音频并观察播放完成；现有流水线仍使用原 WebRTC 音频输出。
`/realtime-qwen.js` 是模块浏览器入口。模块私有消息见
[事件协议](../../docs/architecture/events.md#voice-center-optional-qwen-datachannel-2026-11-03)。
真实 API、设备延迟、回声消除、音色效果需要使用自己的账户和麦克风联调，模拟测试不能替代。
