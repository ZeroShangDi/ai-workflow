# awf plugin / server / open / attach — 需求文档

> 源码文件：`src/cli/plugin.js`, `src/cli/server.js`, `src/cli/open.js`, `src/cli/attach.js`

---

## 1. awf plugin — 独立插件管理

### 功能描述

手动管理 `ai-workflow` 插件的符号链接，不依赖 `claude plugin` CLI。

### 命令

| 命令 | 说明 |
|------|------|
| `awf plugin install` | 创建 symlink: `plugin/` → `~/.claude/plugins/ai-workflow` |
| `awf plugin uninstall` | 移除 symlink 或目录 |

### 流程

**install**：
1. 确保 `~/.claude/plugins/` 目录存在
2. 检查 `~/.claude/plugins/ai-workflow` 是否已存在 → 已存在则跳过
3. 创建 symlink: `plugin/` → `~/.claude/plugins/ai-workflow`

**uninstall**：
1. 检查目标是否存在 → 不存在则跳过
2. 判断是 symlink 则 `unlink`，是目录则 `rm -rf`
3. 输出 "已卸载"

**无效 action** → 输出错误并 `process.exit(1)`

### 依赖

| 模块 | 用途 |
|------|------|
| `node:fs/promises` | mkdir, stat, symlink, unlink, rm |
| `./paths.js` | getPaths → projectRoot, claudePlugins |
| `./logger.js` | 控制台输出 |

---

## 2. awf server — tmux-http 服务生命周期

### 功能描述

管理 HTTP Session Server 和 tmux session 的启动/停止/状态查询。

### 命令

| 命令 | 说明 |
|------|------|
| `awf server start` | 启动 HTTP server + 确保 tmux session |
| `awf server stop` | 清理 tmux session + 释放端口 |
| `awf server status` | 检查 server 是否运行中 |

### 流程

**start**：
1. `check()` 检查 8787 端口是否已有服务
2. 未运行 → spawn `node src/server/server.cjs`（detached + unref），轮询 30 次最多 15s 等待就绪
3. 检查 tmux session 是否存在：
   - 存在 → 跳过
   - 不存在 → 执行 bootstrap.sh 创建
4. 输出环境就绪信息

**stop**：
1. `tmux kill-session` 清理 session
2. `lsof -ti:8787 | xargs kill` 释放端口
3. 输出 "已停止"

**status**：
1. `check()` HTTP GET `/status`
2. 运行中 → 输出 URL
3. 未运行 → 输出提示

**check()**：HTTP GET `http://127.0.0.1:8787/status`，2s 超时，返回 boolean。

### 依赖

| 模块 | 用途 |
|------|------|
| `node:child_process` (spawn, execSync) | 启动/停止 server、管理 tmux |
| `node:http` | 健康检查 GET /status |
| `./paths.js` | tmuxServer、bootstrapScript、projectRoot |
| `./logger.js` | 控制台输出 |

---

## 3. awf open — 可视化页面

### 功能描述

打开 AI Workflow 的可视化页面（dashboard 或任务树）。

### 命令

| 命令 | 说明 |
|------|------|
| `awf open dashboard` | 浏览器打开 `http://localhost:8787` |
| `awf open ui` | 同 dashboard |
| `awf open tree` | 渲染 WBS 任务树 HTML 并打开 |

### 流程

**tree**：
1. 读取 `.awf/state.json`
2. 若 `state.wbs` 为空 → 报错退出
3. 内嵌 HTML 模板 + `state.wbs` JSON 数据 → 渲染页面
4. 写入 `.awf/w-tree.html`
5. `openBrowser()` 在默认浏览器打开

**dashboard/ui**：
1. 构造 `http://localhost:8787` URL
2. `openBrowser()` 打开

**openBrowser(target)**：根据平台选择 `open` / `start` / `xdg-open`，spawn detached + unref。

### 依赖

| 模块 | 用途 |
|------|------|
| `node:child_process` (spawn) | 打开浏览器 |
| `node:fs/promises` | 读写 state.json 和 HTML |
| `./paths.js` | projectRoot |
| `./logger.js` | 控制台输出 |

---

## 4. awf attach — 接入 tmux session

### 功能描述

连接到正在运行的 tmux session，观看 AI 工作流执行过程。

### 流程

1. 读取 `CC_SESSION` 环境变量或默认 `cc`
2. `tmux has-session -t {session}` 检查是否存在
3. 不存在 → 报错退出，提示先执行 `awf run`
4. 存在 → `tmux attach -t {session}`（stdio inherit，用户交互）

### 依赖

| 模块 | 用途 |
|------|------|
| `node:child_process` (execSync) | tmux has-session / attach |
| `./logger.js` | 控制台输出 |
| `process.env.CC_SESSION` | session 名称 |
