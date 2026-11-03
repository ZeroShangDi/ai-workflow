# Qwen realtime module

独立的可选语音后端。**千问相关的情感控制、环境感知、说话人策略及其后续扩展，全部留在本目录。**
Control、公共 HTTP 配置和人物资料不承担千问特定策略。

## 模块职责

| 文件 | 职责 |
| --- | --- |
| `__init__.py` | 模式选择及惰性加载入口 |
| `config.py` | 凭据、模型、音色、情绪增强、智能轮次和说话人增强配置 |
| `client.py` | 认证 WS、连续 PCM、会话配置握手、关闭；不自动重连重放 |
| `session.py` | 转写、真实用户轮次绑定、既有能力调用、通知和播放状态 |
| `pipeline.py` | Pipecat 麦克风接入，复用本地历史和 capability host |
| `browser.js` | PCM 播放、清空排队音频、自然结束与中断回执 |

共享代码只负责选择运行时、启动校验、提供静态 JS 和连接通用页面回调。
没有本地 VAD / ASR 截断：16kHz/16bit/mono PCM 连续送给千问，由千问判断轮次。
输出为 24kHz/16bit/mono，通过现有有序 DataChannel 送往本模块播放器。
使用 AudioBufferSourceNode.onended 和生成结束标记共同判断播放完成。

## 配置（重启生效）

| 环境变量 | 默认 / 含义 |
| --- | --- |
| `VOICE_CENTER_VOICE_MODE` | `pipeline`；设置 `qwen-realtime` 启用本模块 |
| `VOICE_CENTER_QWEN_REALTIME_URL` | 必填；账户对应的无凭据 `wss://` 地址，可含 model 查询参数 |
| `VOICE_CENTER_QWEN_API_KEY_FILE` | 私有凭据文件绝对路径；推荐 |
| `VOICE_CENTER_QWEN_API_KEY` | 凭据环境变量；优先于文件 |
| `VOICE_CENTER_QWEN_MODEL` | `qwen-audio-3.1-realtime-flash`，也支持 `qwen-audio-3.1-realtime-plus`；未显式配置时可从 URL model 读取 |
| `VOICE_CENTER_QWEN_VOICE` | `longanqian_v3.1`；云端支持的音色 ID，不能直接填本地人设 ID |
| `VOICE_CENTER_QWEN_EMOTION` | `true`；输出情绪增强，不代表用户情绪分类标签 |
| `VOICE_CENTER_QWEN_TURN_DETECTION` | `smart_turn_v2`；也可选 smart_turn/server_vad |
| `VOICE_CENTER_QWEN_HISTORY_TURNS` | `10`；1～50，限制历史成本 |
| `VOICE_CENTER_QWEN_SPEECH_RATE` | `1`；0.5～2 |
| `VOICE_CENTER_QWEN_VOICEPRINT_URLS` | `[]`；最多五个 HTTPS 预录说话人音频 URL 的 JSON 数组，仅 smart_turn/smart_turn_v2 可用 |

千问模式无需原 ASR/LLM/TTS 的凭据，Python / Pipecat / WebRTC 运行依赖仍需安装。
已有 websockets 依赖足够，无新增第三方运行依赖。

## 工具和授权

复用 PluginHost 提供的 voice_history/web_search 和所选 work capability。
千问 Function Calling 映射到已有工具，不给模型新增创建 / 审批权限。
收到 function call 后，等待该轮最终转写；只有最新宿主观察到的用户轮次才能调用工具。
不使用模型传入的 user_quote、情绪、环境音或旁人声音作为授权依据。
Control 的固定会话继续负责完整任务草稿、补充信息和后续显式确认。
同一 call_id 只执行一次，未知结果返回失败提示并要求查询，不重试外部写入。

输出生成完成不是已播放。后台通知在对话及播放空闲后触发，禁止通知触发工具调用。
用户插话时立即停止本模块已排队音频，旧回复不再触发工具续轮。
本地 SQLite 只记录最终用户转写和已完整播放的助手文本，不把未播放的完整回复记为已听到。
不额外输出结构化情绪 / 环境事件；这类后续处理在本模块内扩展。

## 验证

在插件根目录执行 `npm test`；测试 Python 应为项目要求的 3.12，可用 `PYTHON` 指定路径。
新增测试不需要真实千问、Control 或 ASR/TTS 凭据。真实双工节奏、设备回声和输出延迟
需要单独联调，特别是 DataChannel 输出在弱网下的表现。

协议依据：[客户端事件](https://help.aliyun.cn/zh/model-studio/fun-audiochat-client-events)、
[服务端事件](https://help.aliyun.com/en/model-studio/qwen-audio-realtime-server-events)。
