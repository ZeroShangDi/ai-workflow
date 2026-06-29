# ai-workflow CLI 需求文档

## 背景与目标

当前项目（ai-workflow）包含一套完整的 Claude Code 工作流配置（斜杠命令、技能、标准、模板），但这些配置仅存在于项目本地 `.claude/` 目录中，无法跨项目复用。

**目标**：将当前项目改造为 CLI 工具 + Claude Code 插件，用户只需执行一条命令即可将这套工作流配置注入到 Claude Code 插件系统中，全局生效。

## 用户场景

1. **场景 A：安装插件** — 开发者克隆本项目后，执行 `ai-workflow install`，工作流命令（`/w-plan`、`/w-dev` 等）立即可在任意项目中使用。
2. **场景 B：卸载插件** — 执行 `ai-workflow uninstall`，从 Claude Code 中移除所有工作流配置。

## 功能范围

- **包含（当前里程碑）**：
  - CLI 入口：`ai-workflow install` / `ai-workflow uninstall`
  - install：创建插件清单、符号链接到 Claude Code 插件目录、注册到 installed_plugins.json
  - uninstall：移除符号链接、清理 installed_plugins.json 中的注册项
  - 安装后 Claude Code 可识别并加载所有 commands、skills、templates

- **不包含（后续里程碑）**：
  - 版本管理与更新（update 命令）
  - 插件详情查看（info/list 命令）
  - npm 包发布
  - .zip 打包分发
  - Codex / Cursor 等其他平台适配

## 验收标准

- [ ] `ai-workflow install` 执行后，`claude plugin list` 能看到 `ai-workflow` 插件
- [ ] 安装后，在任意项目执行 `claude` 后可使用 `/w-plan`、`/w-dev` 等所有命令
- [ ] 安装后，skills（code-standards、design-standards、quality-standards 等）自动可用
- [ ] `ai-workflow uninstall` 执行后，插件完全移除，不影响 Claude Code 正常运行
- [ ] CLI 自身代码通过 typecheck 和 lint
- [ ] 安装在 `~/.claude/plugins/` 下以符号链接方式实现，修改源文件即时生效
