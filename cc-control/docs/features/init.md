# awf init — 需求文档

## 功能描述

`awf init` 是 AI Workflow Framework 的项目初始化命令，将当前目录初始化为可运行 `awf plan` / `awf run` 的工作流项目。

### 初始化流程（4 步）

1. **版本确认** — 调用 `promptVersion()` 让用户交互式选择/输入版本号
2. **前置依赖检查** — 检查 `tmux` 和 `claude` 是否可执行
3. **插件安装** — 安装 `ai-workflow` 自身插件 + `.awf-plugins.json` 中声明的额外插件
4. **工作区初始化** — 从模板创建 `.awf/` 目录结构，注入版本号
5. **CLAUDE.md 注入** — 检查项目 CLAUDE.md，注入 awf 运行时规则

---

## 输入输出

### 输入

| 输入 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `--force` | CLI flag | `options.force` | 当 `.awf/` 已存在时，补全缺失文件而非跳过 |
| `--version` / 交互输入 | string | version-prompt | 通过 @inquirer/prompts 选择或手动输入 |
| `.awf-plugins.json` | 文件 | 项目根目录 | 可选，声明额外需要安装的插件列表 |
| `process.cwd()` | 路径 | 系统 | 目标项目目录 |

### 输出

| 输出 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `.awf/` 目录结构 | 文件系统 | `cwd/.awf/` | 从 `src/templates/awf/` 复制 |
| `state.json` | 文件 | `.awf/state.json` | 从 `state.template.json` 复制，替换 `{{VERSION}}` 和 `{{TIMESTAMP}}` |
| `CLAUDE.md` | 文件 | `cwd/CLAUDE.md` | 创建或追加 awf 规则块 |
| 插件 symlink | 链接 | `~/.claude/plugins/ai-workflow` | `claude plugin install ai-workflow@ai-workflow-dev` |
| 控制台输出 | stdout | — | 分节报告每步结果（ok/warn/skip/error） |

### 文件系统操作

| 操作 | 目标 | 条件 |
|------|------|------|
| `fs.cp` (递归) | `src/templates/awf/` → `.awf/` | `.awf/` 不存在 |
| `fs.copyFile` | `state.template.json` → `.awf/state.json` | `.awf/state.json` 不存在 |
| `fs.mkdir` (递归) | `.awf/` | 模板缺失时的 fallback |
| `fs.writeFile` | `CLAUDE.md` | 不存在或需要注入 |
| `fs.writeFile` | `.awf/` 内文件 | 替换 `{{VERSION}}` 占位符 |
| `fs.writeFile` | `.awf/state.json` | 替换 `{{TIMESTAMP}}` 占位符 |
| `fs.readlink` | `~/.claude/plugins/ai-workflow` | 检查已有 symlink 有效性 |
| `fs.unlink` | 旧 symlink | symlink 无效时清理 |
| `mergeMissing` (递归) | 模板 → `.awf/` | `--force` 时补全缺失文件 |

---

## 函数清单

### 导出函数

| 函数 | 说明 |
|------|------|
| `initCommand(options)` | 主入口，编排完整初始化流程 |

### 内部函数

| 函数 | 说明 |
|------|------|
| `checkPrerequisites()` | 检查 tmux/claude 可执行性，返回结果数组 |
| `loadExtraPlugins(paths)` | 读取 `.awf-plugins.json`，返回额外插件列表 |
| `installAllPlugins(paths, extraPlugins)` | 注册 marketplace + 逐个安装插件 |
| `initWorkspace(paths, force, version)` | 创建/补全 `.awf/` 目录 |
| `initClaudeMd(projectRoot, cwd)` | 检查并注入 awf 规则到 CLAUDE.md |
| `mergeMissing(src, dest)` | 递归比较两个目录，补全缺失文件 |
| `copyStateTemplate(paths, awfDir)` | 复制 state 模板并替换时间戳 |
| `replaceVersion(awfDir, version)` | 递归替换 `.awf/` 内 `{{VERSION}}` |
| `replaceTimestamp(filePath)` | 替换 `{{TIMESTAMP}}` |
| `replaceInDir(dir, version)` | 遍历目录替换版本号 |
| `execAsync(cmd, opts)` | `child_process.exec` 的 Promise 封装 |
| `logSection(title)` | 输出节标题 |
| `logStep(label, status, msg)` | 输出单步结果（ok/warn/skip/error） |
| `createSpinner(label)` | 创建动画 spinner |

---

## 依赖

| 模块 | 用途 |
|------|------|
| `node:child_process` (`exec`, `execSync`) | 检查前置依赖、安装插件、注册 marketplace |
| `node:path` | 路径拼接 |
| `node:fs/promises` | 所有文件 I/O |
| `./paths.js` (`getPaths`) | 获取 `projectRoot`、`claudePlugins` 等关键路径 |
| `./version-prompt.js` (`promptVersion`) | 交互式版本号选择 |
