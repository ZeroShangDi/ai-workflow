# ai-workflow

AI 自治开发工作流 monorepo — 将 AI 辅助开发拆分为可独立迭代的子项目。

## 仓库结构

```
ai-workflow/
├── cc-control/                  # Claude Code 控制层
│   ├── cc-plugins/              #   插件集：自定义命令 + 开发 Skill
│   ├── tmux-http/               #   tmux HTTP 服务，持久化 CC 会话控制
│   └── sandbox/                 #   沙箱环境配置
├── pc-control/                  # 计算机控制层
│   ├── pd-control/              #   Parallels Desktop VM 控制 (Python CLI)
│   └── browser-bbx/             #   浏览器自动化 Skill (BBX MCP)
└── .gitignore
```

## 项目概览

| 项目 | 目录 | 技术栈 | 说明 |
|------|------|--------|------|
| **cc-plugins** | `cc-control/cc-plugins/` | Markdown / Claude Code Skills | 从需求规划到交付的全流程自动化命令和技能 |
| **tmux-http** | `cc-control/tmux-http/` | Node.js / tmux | 通过 HTTP 驱动持久化的 Claude Code 会话 |
| **pd-control** | `pc-control/pd-control/` | Python / PyAutoGUI | Windows VM 的鼠标键盘控制和屏幕捕获 |
| **browser-control** | `pc-control/browser-bbx/` | Markdown / Claude Code Skills | 浏览器探索方法论的自动化技能 |

## 分支策略 (Git Flow)

```
main                       ← 稳定发布
develop                    ← 集成分支
├── feature/cc-plugins     ← cc-plugins 开发
├── feature/tmux-http      ← tmux-http 开发
├── feature/pd-control     ← pd-control 开发
├── feature/browser-control← browser-control 开发
└── feature/cc-control     ← cc-control 级别共享开发
```

每个 feature 分支只应修改自己项目目录下的文件。跨项目的变更应在 `develop` 上通过 merge 整合。

## 开发约定

### 文件隔离
- `feature/cc-plugins` → 只改 `cc-control/cc-plugins/`
- `feature/tmux-http` → 只改 `cc-control/tmux-http/`
- `feature/pd-control` → 只改 `pc-control/pd-control/`
- `feature/browser-control` → 只改 `pc-control/browser-bbx/`
- `feature/cc-control` → 只改 `cc-control/`（跨子项目共享文件，如 `cc-control/README.md`）

### 提交规范
- 提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式
- 双语（中/英）提交信息推荐

### 合并流程
1. 在 feature 分支上开发并提交
2. 合并到 `develop` 进行集成验证
3. 发布时从 `develop` 合并到 `main`
