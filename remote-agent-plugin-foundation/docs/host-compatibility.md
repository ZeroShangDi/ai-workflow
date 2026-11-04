# 宿主接入调研

调研日期：2026-11-04。以下是官方文档所述能力，不代表本工程已经完成这些宿主的实机验收。DSH 指 DeepSeek Harness；豆包一栏主要指豆包工作及其开放平台，不能推广为所有豆包聊天端的能力。

## 结论

| 宿主      | MCP / Skill                                                         | 浏览器授权                                             | 本项目接入方向                                                              |
| --------- | ------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| WorkBuddy | 官方连接器支持 MCP + Skill，也支持单独的 CLI + Skill 方案           | 官方云端 OAuth 支持 DCR 或预注册客户端，凭据由云端管理 | 优先复用 HTTPS MCP、DCR、PKCE 和刷新机制，新增连接器配置包                  |
| 豆包工作  | 官方插件支持远程 Streamable HTTP、SSE 与 Skills；MCP 不支持本地进程 | 文档明确按 MCP 标准完成 OAuth                          | 提供 portable 插件包和 com.doubao 展示扩展，按平台流程验证和审核            |
| DSH       | 官方支持 stdio、Streamable HTTP、Skill provider 和插件注册 MCP      | 当前官方 MCP manager README 明确 No OAuth flow         | 首先验证现有设备码 CLI + stdio MCP；如需原生 OAuth 体验，另评估可复用适配器 |

## WorkBuddy

官方推荐 MCP + Skill；一个连接器只选择 MCP 或 CLI 一种方案，一个连接器只配置一个 MCP Server。OAuth 推荐 `auth_mode: "server-side"`，动态注册对应 `server_auth.auth_type: "mcp_oauth"`，通过 `data.mcp_oauth.server_url` 和可选 `scopes` 发起发现。预注册方式为 `oauth2_code`。Token 由 WorkBuddy 云端托管和注入。

交付包由 `connector-meta.json`、`mcp.json`、图标和可选 `skills/` 组成；示例传输写法为 `type: "streamableHttp"`，与本工程 Codex 兼容包的 `type: "http"` 不同。官方要求授权服务配合其客户端名称与回调域名策略；实际实现时应验证精确回调和注册约束，不能仅信任客户端自报名称。文档要求 HTTPS、OAuth 发现、DCR、S256 PKCE、access/refresh token；本工程已有相关机制，但仍需验证发现路径、回调、续期和撤销。

来源：

- https://open.workbuddy.cn/docs/connector
- https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Connector

## 豆包工作

官方 MCP Server 文档（页面更新 2026-11-02）声明：根目录 `mcp.json` 提供 `mcpServers`；每个服务的 `type` 为 `streamable-http` 或 `sse`，URL 为绝对 HTTPS 地址，不能为 localhost 或回环 IP；只支持远程 MCP，不支持本地进程。

`plugin.json` 的 `extensions["com.doubao"].mcpServers` 提供逐服务展示信息，键必须和 `mcp.json` 一一对应。标准 MCP OAuth 直接由宿主执行，插件包不重复声明授权端点或预注册客户端凭据。静态凭据采用另一套 `com.doubao/auth/<server>.json` 表单配置，不应作为本项目首选路径。

技能使用 `SKILL.md`，外部服务需要通过平台认可的连接器或注册工具接入。开放平台技能指南要求企业认证和审核；插件具体准入与发布权限仍需按账号核验。不能假设普通个人账号可直接向全部豆包终端分发。文档引用 MCP 2026-07-28；我们现有 SDK 对该宿主的实际协议协商/旧版本兼容尚未验证，不凭文档引用就升级整个底座。

来源（动态网页，正文通过浏览器读取）：

- https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/mcp-server-development
- https://open.doubao.com/document/doubao-developer-guide/skill-integration-guide
- https://open.doubao.com/document/doubao-developer-guide/enterprise-qualification-certification

## DSH

官方 `dsh-mcp-client` 支持 stdio 与 Streamable HTTP。官方 manager 支持 Settings 管理的配置和插件生命周期内的 `ctx.mcpManager.register` 注册；凭据以 `${credential:REF}` 引用，可由凭据 provider 提供。Skill 有独立 provider / registry 机制。

关键限制：当前官方 manager README 的 Known Limitations 明确没有 OAuth flow，没有交互式登录和 OAuth token 存储。不能用旧的社区讨论或“支持 HTTP MCP”推断当前有原生 OAuth。社区已有 OAuth 适配器，但本次不将其能力当作官方能力，也未安装或认可具体项目。

最低改动的候选路径是复用本工程现有设备码登录 CLI 和 stdio 服务，由客户端私有保存登录态，DSH 只负责启动 MCP 子进程。它仍需本机 DSH 版本、配置入口、凭据环境继承和重启恢复实测；体验不等同于内置连接按钮。

来源：

- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-manager/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/mcp.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md

## 底座与后续验收

服务端账号、授权、业务 API、数据存储和工具语义保持共用。宿主适配包只处理清单、展示、Skill 工具名称及安装/登录方式，不导入服务端模块私有实现。OpenAI 的 `.app.json` 应用标识不进入其他宿主配置。

建议顺序：WorkBuddy OAuth 连接器 → DSH stdio / 设备码 → 豆包工作插件（并行准备平台资质，不自动提交）。每个宿主单独验证：安装 → 登录授权 → 创建/读取 → 网页核对 → 续期 → 撤销拒绝访问 → 重启恢复。文档支持、包校验通过和真实验收通过分别记录。
