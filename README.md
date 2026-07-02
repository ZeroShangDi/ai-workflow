# ai-workflow

Claude Code 插件 — AI 自治开发工作流，从需求规划到交付的全流程自动化。

## 安装

**开发调试（临时加载）：**
```bash
claude --plugin-dir .
```

**本地永久安装：**
```
/plugin marketplace add ./
/plugin install ai-workflow@ai-workflow-dev
```

## 包含的命令

| 命令 | 用途 |
|------|------|
| `/awf-run` | 自治工作流 — 驱动完整状态机 |
| `/w-plan` | 任务规划：需求 → 原型 → WBS → 任务列表 |
| `/w-design` | 设计生命周期：风格选择、Figma 联动 |
| `/w-tree` | 任务拆解树，双视图 HTML 可视化 |
| `/w-dev` | 开发执行 — explore → implement → lint → verify |
| `/w-debug` | 系统化调试：假设 → 证据 → 排除 |
| `/w-review` | 代码审查（code-standards + quality-standards） |
| `/w-test` | 测试用例排查 — 对比 .test.md 与实际代码 |
| `/w-ui` | 从 Figma 还原 UI |
| `/w-doc` | 功能模块文档（需求 + 测试用例 + 开发日志） |
| `/w-commit` | 智能提交，conventional commit 消息 |
| `/w-finish` | 里程碑收尾：质量/性能/文档/总结/记忆/交接 |

## 包含的技能

| 技能 | 用途 |
|------|------|
| `design-standards` | 架构、数据建模、状态管理、composable 抽取 |
| `code-standards` | 函数设计、命名、错误处理、防御性编程 |
| `quality-standards` | 测试金字塔(70/20/10)、代码审查、conventional commits |
| `workflow-standards` | 工作流约定 |
| `git-flow` | Git 分支和提交规范 |
| `version-management` | 版本升级和 changelog 管理 |
| `testdoc` | 测试用例文档规范 |
| `awf-spec` | 自治工作流规范格式 |

## 目标项目

Vue 3 + TypeScript 浏览器扩展（pnpm monorepo, Element Plus, UnoCSS）。
