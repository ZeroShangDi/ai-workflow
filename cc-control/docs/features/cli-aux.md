# CLI 辅助命令（plugin / server / open / attach）— 功能文档

> 对应 WBS：
> 源码：`src/cli/plugin.js`、`src/cli/server.js`、`src/cli/open.js`、`src/cli/attach.js`（命令注册见 `src/awf.js`）
> 相关：`src/lib/version.js`（`promptVersion`，当前禁用）

## 功能描述

`src/awf.js` 注册 7 个命令：`init` / `plan` / `run`（主命令）与 `plugin` / `server` / `open` / `attach`（辅助命令）。本文件覆盖四个辅助命令，另附已禁用返回的 `promptVersion` 辅助面。

| 命令 | 说明 |
|------|------|
| `awf plugin <action>` | 插件注册：本地注入（默认）或全局 `claude plugin install`；`-s, --scope <local\|global>` |
| `awf server <action>` | tmux-http 服务生命周期：start / stop / status |
| `awf open <target>` | 打开 web 可视化页面：dashboard / tree |
| `awf attach` | 接入 tmux session 观看 Claude Code 实时对话 |

---

## 1. awf plugin — 插件管理（两态）

`pluginCommand(action, options)` 按 `scope` 分发（默认 `local`）。

### 本地注册（默认 `--scope local`）

| action | 实现 | 输出 |
|--------|------|------|
| `install` | `installProfile(cwd, projectRoot)` → 项目 `.claude/settings.json`；`installProjectMcp(cwd, projectRoot)` → 项目 `.mcp.json` | success「已本地注册 plugin → <path>」「已写入项目 MCP 注册 → <path>」，失败 warn 不阻断 |
| `uninstall` | `uninstallProfile(cwd, projectRoot)` | success「已移除本地 plugin 注册」或 info「本地 plugin 注册不存在」 |
| 其它 | — | error「未知操作: <action>，可用: install \| uninstall」+ `exit(1)` |

### 全局注册（`--scope global`）

| action | 实现 |
|--------|------|
| `install` | `loadPluginsFromProfile` 读 `plugin/settings.json` 的 `plugins`；`installAllPlugins`：清理早期 symlink → `tooling.buildMarketplaceAdd(plugin/)` 注册市场 → 逐个 `claude plugin install <spec>`（已用户级安装则 skip） |
| `uninstall` | `uninstallAllPlugins` → 逐个 `claude plugin uninstall <spec>` |
| 其它 | error + `exit(1)` |

- 已安装判据：`~/.claude/plugins/installed_plugins.json` 中该 spec 存在 `scope === 'user'` 的条目（**仅用户级**算已装，项目级不算）。
- 安装/卸载经 `tooling.*`（`src/adapters/ports.cjs` 端口契约），`claude plugin ...` 字面不出 CLI。

---

## 2. awf server — tmux-http 服务生命周期

会话名 / 端口 / 路径经 `buildRunContext({ projectRoot, sid: projectSid(cwd) })` 装配（单 server 多项目：请求带 `?p` 路由）。

| action | 流程 |
|--------|------|
| `start` | ① `getStatus(port)` 探测：已有服务 → info「已运行 → 复用」（本项目/他项目均复用）；否则 spawn `node <serverScriptPath>`（detached + unref，输出落 `.awf/logs/server.log`，env 带 `CC_PORT`/`CC_PROJECT`），轮询 30×500ms 等就绪，超时 → error 并 return。② `tmux has-session` 检查，不存在则 `bash <bootstrapScript>`。③ success「环境就绪」 |
| `stop` | ① `tmux kill-session`；② `requestShutdown(port)` POST `/shutdown` 优雅关闭；失败则 `lsof -ti:<port> \| xargs kill` 兜底；③ success「已停止」 |
| `status` | `checkServer` → success「tmux-http 运行中: http://localhost:<port>」/ info「tmux-http 未运行」 |
| 其它 | error「未知操作: <action>，可用: start \| stop \| status」+ `exit(1)` |

---

## 3. awf open — web 可视化页面

打开由常驻 server 静态托管的 React SPA；URL 带项目作用域 `?p=<cwd>`（缺 `p` 会落到 server 的 boot 项目）。

| target | URL |
|--------|-----|
| `tree` | `http://localhost:<SERVER_PORT>/?view=wbs-tree&p=<cwd>` |
| `dashboard` | `http://localhost:<SERVER_PORT>/?p=<cwd>` |
| 其它 | error「未知目标: <target>，可用: tree \| dashboard」+ `exit(1)` |

- **`ui` 目标已废弃**（T1-094，`ui.html` 已删除，不再是 open 目标）。
- **CLI 端 HTML 渲染已移除**（T1-066）：不再生成 `.awf/w-tree.html`，`tree` 直接指向 web 的 WBS-Tree 视图。
- `openBrowser(target)`：`darwin → open` / `win32 → start` / 其它 `→ xdg-open`，`spawn(..., { stdio:'ignore', detached:true })` + `unref()`。

---

## 4. awf attach — 接入 tmux session

1. `buildRunContext({ projectRoot: cwd }).runSessionName` 解析会话名（未带 sid → 基础会话名，缺省 `cc`，可由 `CC_SESSION` 覆盖）；
2. `tmux has-session -t <session>` 检查，不存在 → error「tmux session '<session>' 不存在，请先执行 awf run」+ `exit(1)`；
3. 存在 → info「接入 session '<session>'（Ctrl-B D 脱离）...」+ `tmux attach -t <session>`（`stdio: 'inherit'`）。

---

## 附：version-prompt（已禁用返回）

`src/lib/version.js` 的 `promptVersion(cwd)` 交互式选择/递增版本号，仍在单测覆盖内，但 `awf init` 与 `awf plan` 均已注释停用（`version = undefined`）——故 init 不改写 `{{VERSION}}`，plan 不写 state.version。详见 `docs/features/version-prompt.md`。

## 核心常量 / 配置

| 常量 | 值 | 说明 |
|------|-----|------|
| 默认 scope | `local` | `awf plugin` 缺省范围 |
| server 默认端口 | `8787` | `plugin/config.json` `port`，经 `run-context` 装配 |
| `SERVER_PORT` | `runtimeConfig.getServerPort()` | `src/lib/session/client.js` 导出，open 用 |
| session 基础名 | `cc` | `config.json` `runtime.session`，可由 `CC_SESSION` 覆盖 |
| tmux 尺寸 | `-x 200 -y 50` | bootstrap 创建（server start 间接调用） |

## 函数清单

| 函数 | 说明 | 位置 |
|------|------|------|
| `pluginCommand(action, options)` | 按 scope 分发本地/全局 | `src/cli/plugin.js` |
| `localPlugin(action)` | 本地 install/uninstall（`installProfile`/`installProjectMcp`/`uninstallProfile`） | `src/cli/plugin.js` |
| `globalPlugin(action)` | 全局 install/uninstall（`claude plugin install/uninstall`） | `src/cli/plugin.js` |
| `installAllPlugins` / `uninstallAllPlugins` / `loadPluginsFromProfile` | 全局安装 helpers | `src/cli/plugin.js` |
| `serverCommand(action)` | start / stop / status / 未知 | `src/cli/server.js` |
| `checkServer(port)` / `requestShutdown(port)` | 探测服务 / POST `/shutdown` | `src/cli/server.js` |
| `openCommand(target)` / `openBrowser(target)` | 打开页面 / 跨平台开浏览器 | `src/cli/open.js` |
| `attachCommand()` | tmux 接入 | `src/cli/attach.js` |
| `installProfile` / `uninstallProfile` / `installProjectMcp` | 本地注册实现 | `src/lib/profile.js` |

## 接口 / 依赖

| 模块 | 用途 |
|------|------|
| `src/lib/profile.js` | 本地注册（settings 注入 + 项目 MCP） |
| `src/adapters/ports.cjs` (`tooling`) | 全局安装/市场运维（`buildInstall`/`buildUninstall`/`buildMarketplaceAdd`） |
| `src/lib/run-context.cjs` | session / 端口 / 路径单源装配；`projectSid` |
| `src/lib/session/client.js` (`getStatus`, `SERVER_PORT`) | server 探测、open 端口 |
| `src/lib/server-log.js` | server 启动日志落盘 |
| `src/lib/ui/log.js` | `logger` 输出 |

## 验收标准

- [ ] `awf plugin install`（默认）写项目 `.claude/settings.json` 与 `.mcp.json`，**不**执行 `claude plugin install`
- [ ] `awf plugin install --scope global` 逐个执行 `claude plugin install <spec>`，用户级已装则 skip
- [ ] `awf server start` 存在即复用；不存在则 spawn server + 必要时 bootstrap；`stop` 先优雅关闭再 kill-by-port 兜底
- [ ] `awf open tree`/`dashboard` 打开带 `?p=<cwd>` 的 URL，且不生成 `.awf/w-tree.html`
- [ ] `awf open ui` 报错退出（目标已废弃）
- [ ] `awf attach` session 不存在时报错退出，存在时 `tmux attach`
