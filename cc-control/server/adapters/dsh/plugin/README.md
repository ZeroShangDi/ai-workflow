# AWF DSH 插件

现有 host 插件与浏览器 UI 共用一个安装包。`client.js` 向 `conversation.view`
注册 AWF 页签，排序在「对话 / 轨迹」之后。

当前 iframe 加载本仓库的开发前端 `http://127.0.0.1:5174/`（运行
`npm run dev:mock --prefix web -- --host 127.0.0.1` 可启动模拟数据预览）。
正式使用时将 `client.js` 中的 `frontendUrl` 改为 AWF server 托管前端的地址。

URL 上下文仅三个参数：`mode=dsh`、`pid=<DSH workspaceId>`、`sid=<DSH sessionId>`。
项目 ID 未加载时不挂载 iframe，也不回退到任意项目。

web 的 `HostContextProvider` 统一提供 `useHostContext()`：
`{ mode, pid, sid, projectRoot }`。iframe 就绪时发送 `awf:ready`，插件验证窗口、
来源和三个标识后回复 `awf:context`，附带当前项目路径，供现有 AWF API 的 `p`
作用域使用；没有向 API 的 `sid` 槽位写入 DSH 会话 ID。双方只向指定 origin 发消息。
iframe 设置 origin referrer，用于 web 验证父窗口来源。

CC 直接打开仍支持原来的 `?p=<项目路径>`；也支持 `mode=cc&pid=<项目ID>&sid=<会话ID>`，
其中项目 ID 从 server 项目列表的 projectId/id 映射，现有未提供独立 ID 的项目列表以
projectRoot 为键。未识别的 ID 不回退到 boot 项目。sid 是平台会话 ID，不是 runId。

切换前端视图保留上下文；切换 DSH 会话重新挂载 iframe。DSH 模式项目由宿主决定。
更新插件包后需重启 DSH 网页后台并刷新页面。当前开发服务使用模拟数据，不代表真实 AWF 运行状态。
