# awf init — 需求文档

## 功能描述

`awf init` 是 AI Workflow Framework 的项目初始化命令，将当前目录初始化为可运行 `awf plan` / `awf run` 的工作流项目。插件注册统一在 init 阶段处理（本地注入，非 exec 安装），同时写入项目级 `.mcp.json` 保证 awf run 会话中 MCP 工具可用。

### 初始化流程

0. **版本确认** — 调用 `promptVersion()` 交互式选择/输入版本号（**暂时禁用**，`version = undefined`）
1. **前置依赖检查** — 检查 `tmux`（warn，缺失不影响启动）和 `claude`（error，缺失则退出）
2. **注册插件** — `pluginCommand('install')` 默认本地 scope，两步：
   - `installProfile` — 把 `plugin/settings.json`（安装清单）深合并进项目 `.claude/settings.json`（**plugin 注册，非 claude plugin install exec 安装**）
   - `installProjectMcp` — 幂等合并项目 `.mcp.json`：只覆盖 awf-* 同名 server（绝对路径，保证路径当前），**保留项目已有 server**
3. **初始化项目** — 生成精简 `.awf/` 骨架：目录结构 + README + config + state（缺失文件从 `src/templates/` 根模板复制，`--force` 补全缺失文件）
4. **初始化 CLAUDE.md** — 检查项目 CLAUDE.md：不存在 → 从模板创建；存在但无 awf 规则 → 追加；已含 → 跳过

### `.awf/` 精简骨架（取代旧 TEMPLATE.md 堆）

init 不再从 `src/templates/awf/` 整目录复制（该目录与 TEMPLATE.md 堆已废弃），改为 `ensureSkeleton` 程序化生成：先 `mkdir` 运行时目录，再缺失补复制三个根模板。运行时目录结构以 `src/templates/awf-README.md` 为准：

```
.awf/
├── state.json        # 运行时状态（awf run 读写）
├── config.json       # 运行配置（run.agents 四级配额，默认单 agent）
├── README.md         # 目录说明（src/templates/awf-README.md）
├── versions/         # 版本归档（每版本一份 state.json 快照）
├── issues/           # Issue 跟踪（等价 GitHub Issues）
├── bugs/             # 运行时缺陷记录
├── decisions/        # AI 运行期决策记录（供人复盘）
├── reports/          # 报告产出
│   ├── lint/         #   Lint 报告
│   ├── test/         #   测试报告
│   ├── review/       #   审查报告
│   ├── perf/         #   性能分析报告
│   └── summary/      #   里程碑汇总报告
└── logs/             # awf run 全量运行日志（按运行时间分目录）
```

### awf-config.json — run.agents 四级配额

init 生成 `.awf/config.json`（模板 `src/templates/awf-config.json`）。`run.agents` 为并发四级配额，默认全部为 1（单 agent 串行）：

| 字段 | 说明 | 默认 |
|------|------|------|
| `run.agents.max` | 全局并发 agent 上限 | `1` |
| `run.agents.maxModules` | 模块级并发上限 | `1` |
| `run.agents.maxPerModule` | 单模块内并发上限 | `1` |
| `run.agents.maxPerFeature` | 单特性内并发上限 | `1` |

另有 `docs` 配置段（`enabled` + 文档类型 + 报告类型），为文档体系开关。

### 项目级 .mcp.json（init 与 run 均执行）

`installProjectMcp` 是 MCP 工具在 awf run 会话中可用的必要条件：enabled-only 插件注册下，插件自带 `.mcp.json` 只连通不暴露工具，项目级 `.mcp.json`（绝对路径）补上这一缺口。

- **幂等**：只刷新 awf-* 同名 server 的绝对路径（保证指向当前安装位置），不触碰项目已有 server
- **触发点**：init（经 `pluginCommand('install')`）与 `awf run`（`startSession` 内，`installProjectMcp(workDir, projectRoot, SERVER_PORT)`）各执行一次，run 时用实际端口覆盖

---

## 输入输出

### 输入

| 输入 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `--force` | CLI flag | `options.force` | 当 `.awf/` 已存在时，补全缺失文件而非跳过 |
| `process.cwd()` | 路径 | 系统 | 目标项目目录（settings/.mcp.json 注入与 .awf/ 创建处） |
| `plugin/settings.json` | 文件 | 包内 | 本地注册注入模板（`<pkg>` 占位符 → 包根路径） |
| `plugin/config.json` | 文件 | 包内 | 项目 MCP 唯一配置源（mcpServers 声明，`projectMcpJson` 渲染绝对路径） |
| `src/templates/awf-README.md` | 文件 | 包内 | `.awf/README.md` 模板（运行时目录结构唯一权威） |
| `src/templates/awf-config.json` | 文件 | 包内 | `.awf/config.json` 模板（run.agents 四级配额） |
| `src/templates/CLAUDE.md.template` | 文件 | 包内 | CLAUDE.md 注入的 awf 规则块 |
| `plugin/core/mcp/awf-state/state.template.json` | 文件 | 包内 | state.json 种子（经 `stateTemplatePath()` 解析） |

### 输出

| 输出 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `.awf/` 目录结构 | 文件系统 | `cwd/.awf/` | 目录 mkdir + README/config/state 三文件（缺失补复制） |
| `state.json` | 文件 | `.awf/state.json` | 从 `state.template.json` 复制，替换 `{{TIMESTAMP}}`；`{{VERSION}}` 因版本禁用保留占位符 |
| `config.json` | 文件 | `.awf/config.json` | 从 `awf-config.json` 复制（缺失时） |
| `README.md` | 文件 | `.awf/README.md` | 从 `awf-README.md` 复制（缺失时） |
| `.claude/settings.json` | 文件 | `cwd/.claude/settings.json` | 本地注册：深合并 `plugins` / `enabledPlugins` / `extraKnownMarketplaces` 等键 |
| `.mcp.json` | 文件 | `cwd/.mcp.json` | 项目级 MCP 注册：幂等合并 awf-* server 绝对路径，保留项目已有 server |
| `CLAUDE.md` | 文件 | `cwd/CLAUDE.md` | 创建或追加 awf 规则块（`<!-- awf-rules -->` 标记） |
| 控制台输出 | stdout | — | 分节报告每步结果（ok/warn/skip/error） |

### 文件系统操作

| 操作 | 目标 | 条件 |
|------|------|------|
| `installProfile` | `plugin/settings.json` → `cwd/.claude/settings.json` | 由 `pluginCommand('install')` 调用（本地 scope） |
| `installProjectMcp` | `plugin/config.json` 渲染 → `cwd/.mcp.json` | init 与 run 各执行一次，幂等合并 |
| `fs.mkdir` (递归) | `.awf/` + 运行时子目录 | `.awf/` 不存在或 `--force` |
| `fs.copyFile` | `awf-README.md` → `.awf/README.md` | 缺失时（不覆盖用户改过的） |
| `fs.copyFile` | `awf-config.json` → `.awf/config.json` | 缺失时（不覆盖用户改过的） |
| `fs.copyFile` | `state.template.json` → `.awf/state.json` | `.awf/state.json` 不存在 |
| `fs.writeFile` | `.awf/state.json` | 替换 `{{TIMESTAMP}}` 占位符 |
| `fs.writeFile` | `CLAUDE.md` | 不存在（创建）或需注入（追加） |

---

## 函数清单

### 导出函数

| 函数 | 说明 |
|------|------|
| `initCommand(options)` | 主入口，编排完整初始化流程（依赖检查 → 插件注册 → .awf 骨架 → CLAUDE.md） |

### init.js 内部函数

| 函数 | 说明 |
|------|------|
| `checkPrerequisites()` | 检查 tmux（warn）/claude（error）可执行性，返回结果数组 |
| `initWorkspace(paths, force, version)` | 创建/补全 `.awf/` 骨架，调用 `ensureSkeleton` |
| `ensureSkeleton()` | 内部闭包：mkdir 运行时目录 + 缺失补复制 README/config/state |
| `initClaudeMd(projectRoot, cwd)` | 检查并注入 awf 规则到 CLAUDE.md（模板不存在则跳过） |
| `copyStateTemplate(awfDir)` | 复制 state 模板并替换时间戳 |
| `replaceTimestamp(filePath)` | 替换 `{{TIMESTAMP}}` |
| `replaceVersion(awfDir, version)` | 递归替换 `{{VERSION}}`（version 为 undefined 时跳过） |
| `replaceInDir(dir, version)` | 遍历目录替换版本号 |

### 插件注册与项目 MCP（src/cli/plugin.js + src/lib/profile.js）

| 函数 | 说明 |
|------|------|
| `pluginCommand(action, {scope})` | 按 scope 分发：local（默认，本地注入）→ `localPlugin`，global → `globalPlugin` |
| `localPlugin(action)` | local install → `installProfile` + `installProjectMcp`；uninstall → `uninstallProfile` |
| `globalPlugin(action)` | global install → `loadPluginsFromProfile` + `installAllPlugins`（claude plugin install） |
| `installProfile(projectRoot, pkgRoot)` | 本地注册：读取 `plugin/settings.json`，深合并进项目 `.claude/settings.json` |
| `uninstallProfile(projectRoot, pkgRoot)` | 本地注销：按注入模板键动态清理注入的键值 |
| `installProjectMcp(projectRoot, repoRoot, port?)` | 项目级 MCP：读 `plugin/config.json` 渲染 awf-* server 绝对路径，幂等合并进 `.mcp.json`，保留已有 server |
| `loadPluginsFromProfile(paths)` | 读取 settings.json 的 `plugins` 字段（全局安装清单） |
| `installAllPlugins(paths, plugins)` | 全局安装：注册 marketplace + 逐个 `claude plugin install`（清早期符号链接） |

### 共享 UI（src/lib/ui/）

| 函数 | 说明 |
|------|------|
| `logSection(title)` | 输出节标题 |
| `logStep(label, status, msg)` | 输出单步结果（ok/warn/skip/error） |
| `createSpinner(label)` | 创建动画 spinner |
| `logger` | 通用日志器（info/success/warn/error） |

---

## CLI 命令全景（src/awf.js，7 个命令）

| 命令 | 说明 | 选项 |
|------|------|------|
| `awf init` | 初始化项目工作流环境（含插件注册） | `-f, --force` 覆盖已有配置 |
| `awf plan [description]` | 启动规划会话（需求对齐 → WBS → 任务列表） | `-r, --resume` 恢复上次规划 |
| `awf run [task]` | 启动自治开发工作流 | `-a, --auto` 全自动；`-r, --resume` 恢复；`-l, --local` 本地提示词 |
| `awf plugin <action>` | 插件管理 install/uninstall | `-s, --scope <local\|global>`（默认 local） |
| `awf server <action>` | tmux-http 服务管理 start/stop/status | — |
| `awf open <target>` | 打开可视化页面 dashboard/tree/ui | — |
| `awf attach` | 接入 tmux session 观看 Claude Code 实时对话 | — |

---

## 依赖

| 模块 | 用途 |
|------|------|
| `node:child_process` (`execSync`) | 检查前置依赖（`command -v tmux/claude`） |
| `node:path` | 路径拼接 |
| `node:fs/promises` | 所有文件 I/O |
| `./paths.js` (`getPaths`) | 获取 `projectRoot`、`claudePlugins` 等关键路径 |
| `./plugin.js` (`pluginCommand`) | 插件注册（本地注入，默认 scope） |
| `../lib/profile.js` (`installProfile` / `installProjectMcp`) | 本地 settings 注册 + 项目级 MCP 注册实现 |
| `../lib/plugin-bridge.js` (`stateTemplatePath`) | state 模板路径解析（插件边界唯一模块） |
| `../lib/ui/log.js` / `colors.js` | 分节/分步日志与着色 |
| `../lib/plugin-config.js` (`projectMcpJson`) | 渲染项目级 MCP server 绝对路径（profile.js 间接引用） |
| `version-prompt.js` (`promptVersion`) | 交互式版本号选择（**暂时禁用**） |
