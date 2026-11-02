# 语音模型复用插件宿主能力调研

调研日期：2026-11-02。仅调研，本次未切换生产语音模型调用。

## 结论

可以减少语音插件单独配置模型凭据的需要，但 Codex 与 DeepSeek Harness 的官方扩展边界不同，应分别做可选适配器，保留直接 API 模式和独立启动能力。

| 宿主 | 官方入口 | 对本项目的意义 |
| --- | --- | --- |
| Codex | App Server 的 initialize、thread/start 或 thread/resume、turn/start，以及消息增量和完成通知 | 委托一次完整 Agent 会话，使用 Codex 管理的认证；不是插件获得一个通用 Chat Completions 地址 |
| dsh | 进程内插件的 ctx.llm.stream / prepareCall | 复用宿主已注册模型适配器，更接近当前语音 LLM 调用层 |
| dsh 外部进程 | 官方 TypeScript/Python SDK，stdio JSON-RPC | 驱动 Harness 会话；Python SDK 要显式指定 Harness home，不自动发现 ~/.dsh |

依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[dsh 官方 LLM Streaming](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/llm-streaming.md)、[dsh 官方 Python SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/README.md)。

## Codex

官方支持由 App Server 管理 ChatGPT 登录和认证刷新。语音客户端可发送最终转写，并接收 item/agentMessage/delta；中断需映射到 turn/interrupt。它执行 Agent 语义，必须明确工具、工作目录和权限范围。语音闲聊应使用独立受限会话，工作控制仍由可信的固定 Control 会话负责。

本次查阅的官方插件/MCP 文档未确立一个供普通插件任意反向调用当前桌面模型的通用模型 API，不能把 MCP sampling 当作已确认支持的方案。这是证据范围内的结论，不是对所有未来版本的否定。

官方另有 Sign in with ChatGPT 的计划授权 OAuth 集成：应用注册和用户授权之后，App Server 可使用获授权 token 请求 Responses API。该入口不等于读取、复制桌面应用私有凭据；可用模型须通过实际完成的推理请求确认。

依据：[App Server 认证及协议](https://learn.chatgpt.com/docs/app-server)、[MCP 扩展](https://learn.chatgpt.com/docs/extend/mcp)、[官方 OAuth 集成](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。

## dsh

官方架构把模型适配器注册在 ctx.llm。原生 Cordis 插件可消费该服务，传递 provider/model、上下文、工具及取消信号，转译其 StreamChunk 为语音侧输出。宿主继续持有认证和模型适配器，语音插件无需返回或暴露密钥。

Python 音频进程不能直接访问 JavaScript 的 ctx。建议用一个很薄的宿主原生插件提供有认证的本地流式通道，处理取消、工具调用和请求归属。该通道由我们实现，不能宣称是 dsh 内置 OpenAI 兼容 HTTP 服务。选择 provider/model 仍需明确约定，不能假设调用会自动继承某个桌面会话当前的模型。

官方 SDK 是外部驱动完整 Agent 的另一条路径；不等同于直接获得进程内 ctx.llm，也不能假设另起 SDK 进程就会继承桌面插件树与登录状态。Harness 仍处于开发预览，应固定兼容版本。

依据：[官方架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)、[官方 LLM 服务](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/llm-streaming.md)、[SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/README.md)。

## 当前代码与建议顺序

当前 Python pipeline 直接创建 VoiceLLMService，依赖 VOICE_LLM_URL / MODEL / API_KEY。
Node 的 ManagedChatProvider 已能经公共 Control WebSocket 委托固定会话，但当前启动器默认没有把 Python 模型请求指向该代理。

现有代理只抽取最新 user 内容，并在完整回复到达后包装 SSE；它不保留 Python 的完整系统上下文、工具协议，也没有真正的增量输出和取消传播。因此不能仅改 URL 就宣布完成宿主接入。若全部语音都由固定 Control 会话生成，则必须同时关闭 Python 侧再次委托 Control 的工作工具，防止同一转写重复送达。

建议先确定语音侧保留工具执行还是由宿主整体负责：
1. 优先验证 dsh 原生 ctx.llm 适配器，保留现有 Pipecat 工具和角色上下文。
2. Codex 使用官方 App Server 做会话适配；若整体委托，则由宿主负责工具，语音侧仅负责音频与观察到的播放回执。
3. 验收首字延迟、连续轮次、工具调用、用户插话取消、断线和未知写入结果；通过后再决定默认模式。

本次结论是官方接口与现有代码的设计评估，尚未进行宿主模型调用实测。
