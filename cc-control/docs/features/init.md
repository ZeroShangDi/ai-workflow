# awf init — 需求文档

## 功能描述

`awf init` 是 AI Workflow Framework 的项目初始化命令，将当前目录初始化为可运行 `awf plan` / `awf run` 的工作流项目。插件安装统一在 init 阶段处理（plan/run 无安装逻辑）。

### 初始化流程（4 步）

1. **版本确认** — 调用 `promptVersion()` 交互式选择/输入版本号（**暂时禁用**，`version = undefined`）
2. **前置依赖检查** — 检查 `tmux` 和 `claude` 是否可执行
3. **注册插件** — 默认本地注入：把 `plugin/plugin-code/settings.json` 合并进项目 `.claude/settings.json`（无 exec 安装）
4. **工作区初始化** — 从模板创建 `.awf/` 目录结构
5. **CLAUDE.md 注入** — 检查项目 CLAUDE.md，注入 awf 运行时规则

---

## 输入输出

### 输入

| 输入 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `--force` | CLI flag | `options.force` | 当 `.awf/` 已存在时，补全缺失文件而非跳过 |
| `process.cwd()` | 路径 | 系统 | 目标项目目录（settings.json 注入与 .awf/ 创建处） |
| `plugin/plugin-code/settings.json` | 文件 | 包内 | 本地注册注入模板（`<pkg>` 占位符 → 包根路径） |

### 输出

| 输出 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `.awf/` 目录结构 | 文件系统 | `cwd/.awf/` | 从 `src/templates/awf/` 复制 |
| `state.json` | 文件 | `.awf/state.json` | 从 `state.template.json` 复制，替换 `{{TIMESTAMP}}`；`{{VERSION}}` 因版本禁用保留占位符 |
| `.claude/settings.json` | 文件 | `cwd/.claude/settings.json` | 本地注册：合并 `enabledPlugins` / `extraKnownMarketplaces` / `plugins` 等键 |
| `CLAUDE.md` | 文件 | `cwd/CLAUDE.md` | 创建或追加 awf 规则块 |
| 控制台输出 | stdout | — | 分节报告每步结果（ok/warn/skip/error） |

### 文件系统操作

| 操作 | 目标 | 条件 |
|------|------|------|
| `installProfile` | `plugin/plugin-code/settings.json` → `cwd/.claude/settings.json` | 由 `pluginCommand('install')` 调用（本地 scope） |
| `fs.cp` (递归) | `src/templates/awf/` → `.awf/` | `.awf/` 不存在 |
| `fs.copyFile` | `state.template.json` → `.awf/state.json` | `.awf/state.json` 不存在 |
| `fs.mkdir` (递归) | `.awf/` | 模板缺失时的 fallback |
| `fs.writeFile` | `CLAUDE.md` | 不存在或需要注入 |
| `fs.writeFile` | `.awf/state.json` | 替换 `{{TIMESTAMP}}` 占位符 |
| `mergeMissing` (递归) | 模板 → `.awf/` | `--force` 时补全缺失文件 |

---

## 函数清单

### 导出函数

| 函数 | 说明 |
|------|------|
| `initCommand(options)` | 主入口，编排完整初始化流程 |

### init.js 内部函数

| 函数 | 说明 |
|------|------|
| `checkPrerequisites()` | 检查 tmux/claude 可执行性，返回结果数组 |
| `initWorkspace(paths, force, version)` | 创建/补全 `.awf/` 目录 |
| `initClaudeMd(projectRoot, cwd)` | 检查并注入 awf 规则到 CLAUDE.md |
| `mergeMissing(src, dest)` | 递归比较两个目录，补全缺失文件 |
| `copyStateTemplate(paths, awfDir)` | 复制 state 模板并替换时间戳 |
| `replaceTimestamp(filePath)` | 替换 `{{TIMESTAMP}}` |
| `replaceVersion(awfDir, version)` | 递归替换 `{{VERSION}}`（version 为 undefined 时跳过） |
| `replaceInDir(dir, version)` | 遍历目录替换版本号 |

### 插件安装（src/cli/plugin.js + src/lib/profile.js）

| 函数 | 说明 |
|------|------|
| `pluginCommand(action, {scope})` | 按 scope 分发：local → `localPlugin`，global → `globalPlugin` |
| `installProfile(projectRoot, pkgRoot)` | 本地注册：读取 `plugin/plugin-code/settings.json`，深合并进项目 `.claude/settings.json` |
| `loadPluginsFromProfile(paths)` | 读取 settings.json 的 `plugins` 字段（全局安装清单） |
| `installAllPlugins(paths, plugins)` | 全局安装：注册 marketplace + 逐个 `claude plugin install` |

### 共享 UI（src/lib/ui/）

| 函数 | 说明 |
|------|------|
| `logSection(title)` | 输出节标题 |
| `logStep(label, status, msg)` | 输出单步结果（ok/warn/skip/error） |
| `createSpinner(label)` | 创建动画 spinner |
| `logger` | 通用日志器（info/success/warn/error） |

---

## 依赖

| 模块 | 用途 |
|------|------|
| `node:child_process` (`execSync`) | 检查前置依赖（`command -v tmux/claude`） |
| `node:path` | 路径拼接 |
| `node:fs/promises` | 所有文件 I/O |
| `./paths.js` (`getPaths`) | 获取 `projectRoot`、`claudePlugins` 等关键路径 |
| `./plugin.js` (`pluginCommand`) | 插件注册（本地注入，默认 scope） |
| `../lib/profile.js` (`installProfile`) | 本地注册实现（settings.json 合并） |
| `version-prompt.js` (`promptVersion`) | 交互式版本号选择（**暂时禁用**） |
