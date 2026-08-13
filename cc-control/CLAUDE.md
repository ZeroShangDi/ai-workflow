# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this project.

## 沟通原则

- 直接执行，不解释你打算做什么
- 不复述用户已知道的信息
- 不为修改附加合理性辩护，除非被问
- 除非遇到阻塞，否则只输出结果，不输出过程
- 优先用结构化格式（表格、列表、diff）代替大段叙述

## What this project is

**ai-workflow** 是一个 Claude Code 插件 + CLI 工具，给 AI 加上持久记忆、工作流编排和自主推进能力。它不是让 Claude Code 变聪明，是让它变持久。

```
cc-control/
  package.json             # npm 包

  plugin/                  # 插件市场（.claude-plugin/marketplace.json 注册）
    plugin-code/           #   插件本体：15 命令 + 30 技能 + 5 hooks + 3 MCP
      commands/            #     15 个 slash commands
      skills/              #     30 个 skills
      hooks/               #     5 个 hooks
      plugin.json          #   插件清单
      settings.json        #   安装清单（本地注入源 / 全局安装源）
      .mcp.json            #   3 个 MCP server 声明

  plugin_old/              # 旧插件归档（plugin/ 更名前的版本，不再使用）

  src/                     # 应用代码
    awf.js                 #   CLI 入口（Commander，7 个命令）
    cli/                   #   CLI 命令实现（init, plan, run, plugin...）
    server/                #   HTTP Session Server
    mcp/                   #   3 个 MCP Server（state, session, oneshot）
    prompts/               #   阶段 prompt 模板
    templates/             #   init 模板

  scripts/                 # 开发命令（bootstrap, test, lint, build, eval）
  tests/                   # unit / integration / eval / fixtures
  sandbox/                 # 测试沙箱（gitignored）
  docs/                    # features/issues/bugs/logs/discuss 五类项目文档
```

## 核心编排流程

用户三步：

```bash
awf init          # 初始化 .awf/ 目录 + 安装插件
awf plan "需求"    # 交互式规划 → 产出 .awf/state.json
awf run           # 自主执行：遍历任务，逐阶段推进
```

`awf run` 内部：
```
CLI 读取 .awf/state.json
  → 启动 HTTP Session Server (:8787)
  → 创建 tmux session（bootstrap.sh 加载插件 + MCP servers）
  → 对每个 task 按复杂度执行阶段链：
      simple:  DEV → COMMIT
      medium:  DEV → TEST → COMMIT
      complex: DEV → DOCS → REVIEW → TEST → COMMIT
      ↑                           ↓
      └── DEBUG（按需）───────────┘
  → FINISH 收尾
```

阶段驱动关键设计：
- **每个阶段前**，CLI 通过 `claude -p` 生成优化后的 prompt，再发往 tmux session
- **Session Server** 通过 Claude Code Hooks（`SessionStart`/`Stop` → ready，`UserPromptSubmit` → busy）感知状态
- **阶段间上下文天然断裂** — 每个阶段的 prompt 重新构造，不依赖上一阶段对话历史
- **AI 通过 MCP tools 更新 state.json**（`awf_task_status`、`awf_task_result`、`awf_phase` 等），不再需要 curl

## Development workflow state machine

```
PLAN → DESIGN (if UI) → CODE (loop per task) → REVIEW → TEST → FINISH
                          ↑                      ↑
                          └── DEBUG ←────────────┘
```

- **PLAN**: Interactive Q&A → requirements doc → prototype → WBS → task list (`/w-plan`, CLI 门禁/WBS/任务步骤走 `/w-plan-check` `/w-plan-wbs` `/w-plan-tasks`)
- **DESIGN**: Generate 3 UI styles → user picks → generate UI incrementally (`/w-ui-design` → `/w-ui-code`)
- **CODE**: Loop through tasks sequentially (`/w-dev`)
- **DEBUG**: Systematic debugging when bugs surface (`/w-debug`)
- **REVIEW**: Code review against code-review-* skills (`/w-review`)
- **TEST**: Inspect test case docs against actual code behavior (`/w-test`)
- **FINISH**: Milestone wrap-up — quality, perf, docs, summary, memory, handoff（无独立 slash 命令，由 CLI 收尾）

Any node can loop back. FINISH is a milestone marker, not project end.

## Slash commands（15 个，位于 plugin/plugin-code/commands/）

| Command | Purpose |
|---------|---------|
| `/w-plan` | 主规划流程 — 需求 → 规范化 → WBS → 任务列表 |
| `/w-plan-check` | CLI plan 门禁检查（claude -p 调用） |
| `/w-plan-wbs` | 生成 WBS 空间树（claude -p 调用） |
| `/w-plan-tasks` | 生成任务列表，插入门禁任务（claude -p 调用） |
| `/w-dev` | 开发流程 — 按任务列表逐个执行 |
| `/w-debug` | 调试流程 — 系统化定位和修复 bug |
| `/w-review` | 审查流程 — 对开发产出多维审查 |
| `/w-test` | 测试流程 — 验证开发产出 |
| `/w-doc` | 文档管理 — 需求/测试/问题/Bug/决策五类文档 |
| `/w-commit` | 提交流程 — 常规提交 |
| `/w-ui-design` | 设计原型界面（UI 设计稿流程） |
| `/w-ui-code` | 按原型设计稿实现静态页面 |
| `/w-start` | 标记 state.json 进入 awf 运行模式（plan/run），awf run 入口触发 |
| `/w-pause` | 标记暂停 awf 模式，进入人工介入状态 |
| `/w-monitor` | loop 检测 — 非 tmux 调用的 cc 监测 tmux 中 cc 状态 |

## Skills（30 个，位于 plugin/plugin-code/skills/）

**Plan 阶段（awf-plan-*）**
- **`awf-plan-norm`** — 需求规范化：原始需求 → 结构化目标/边界/场景/验收标准
- **`awf-plan-wbs`** — 生成 WBS 空间树（任务拆分）
- **`awf-plan-tasks`** — 生成任务列表（插入门禁任务）
- **`awf-plan-prompt`** — 执行提示词生成（填入任务）

**Run 阶段（awf-run-*）**
- **`awf-run-decision`** — 运行中需决策时的处理方案
- **`awf-run-error`** — 运行异常时的处理方案
- **`awf-run-review`** — 审查结果处理方案
- **`awf-run-test`** — 测试结果处理方案
- **`awf-run-reset`** — 反复失败重开：回撤判定、精确撤销、复盘后重探

**通用**
- **`awf-skill`** — Skill 生命周期管理（创建/修改/聚合/拆分/审计）
- **`awf-state`** — awf-state MCP 使用指南 + state.json 数据模型（→ src/mcp/awf-state/）
- **`code-context-onboard`** — 跨阶段上下文传递格式 + 压缩规则
- **`code-ask-question`** — 问题描述规范
- **`code-commit-gitflow`** — Git 使用 + 版本管理
- **`code-doc`** — 文档体系规范（五类文档）
- **`code-retro-point`** — 项目复盘（Stable/Improve/Experiment）

**开发（code-dev-*）**
- **`code-dev-rule`** — 开发原则（通用行为准则）
- **`code-dev-design`** — 设计与实现决策
- **`code-dev-cto`** — 技术选型决策方法
- **`code-dev-quality`** — 高质量代码标准
- **`code-dev-security`** — 防御性编程与安全实践
- **`code-dev-performance`** — 性能优化最佳实践
- **`code-dev-fallback`** — 渐进增强与优雅降级
- **`code-dev-experience-react`** / **`code-dev-experience-vue`** — 框架实践取舍

**审查（code-review-*）**
- **`code-review-quality`** — 代码质量审查（正确性/可读性/可维护性）
- **`code-review-performance`** — 性能分析审查
- **`code-review-security`** — 安全漏洞检查
- **`code-review-simplify`** — 代码简化（重复/过度抽象）

**测试**
- **`code-test-case`** — AI 生成测试用例方法论

These are invoked automatically by slash commands. Do not invoke them manually unless explicitly requested.

## MCP Tools（3 个 Server）

### awf-state（17 tools）— 状态 CRUD，直接文件 I/O

| Tool | 用途 |
|------|------|
| `awf_read_state` | 读取完整 state.json |
| `awf_task_status` | 更新任务状态（pending/active/done/blocked） |
| `awf_task_result` | 记录执行结果和产出文件 |
| `awf_task_commit` | 追加 commit 记录 |
| `awf_task_create` | 创建任务 |
| `awf_task_update` | 更新任务字段 |
| `awf_task_delete` | 删除任务 |
| `awf_plan_configure` | 配置 Plan 元数据 |
| `awf_wbs_create` | 创建 WBS 项 |
| `awf_wbs_update` | 更新 WBS 项 |
| `awf_wbs_delete` | 删除 WBS 项 |
| `awf_phase` | 设置工作流阶段 |
| `awf_milestone_update` | 更新里程碑状态 |
| `awf_milestone_create` | 创建里程碑 |
| `awf_milestone_delete` | 删除里程碑 |
| `awf_mode` | 设置运行模式（idle/plan/run） |
| `awf_version` | 更新 state.json 版本号 |

### awf-session（4 tools）— tmux 生命周期观测

| Tool | 用途 |
|------|------|
| `awf_session_status` | 查询 session ready/busy 状态 |
| `awf_capture_pane` | 抓取 tmux pane 内容 |
| `awf_await_choice` | 通知 CLI 需要用户做选择 |
| `awf_await_input` | 通知 CLI 需要用户自由输入 |

### awf-oneshot（1 tool）— 无状态 LLM 调用

| Tool | 用途 |
|------|------|
| `awf_oneshot` | spawn `claude -p`，返回 stdout |

## 常用命令

```bash
# CLI
awf init                  # 初始化项目
awf plan "需求描述"        # 规划
awf run                   # 执行（--auto 跳过等待，--local 跳过 one-shot）
awf server start          # 启动 Session Server
awf attach                # 附加到 tmux session

# 开发
npm test                  # 跑测试
npm run lint              # 语法检查
npm run build             # 打包验证
npm run eval              # AI 质量评测（占位）

# Claude Code 插件（安装统一在 init 阶段处理）
awf init                  # 本地注入 plugin/plugin-code/settings.json 到 .claude/settings.json
awf plugin install --scope global   # 全局安装 settings.json.plugins 声明的插件（claude plugin install）
```

## 关键文件

| 文件 | 角色 |
|------|------|
| `src/awf.js` | CLI 入口，命令路由 |
| `src/cli/run.js` | `awf run` 主循环 |
| `src/cli/init.js` | `awf init` — 前置检查 + 本地注册插件 + 工作区初始化 |
| `src/cli/plugin.js` | 插件管理 — 本地注入 / 全局 claude plugin install |
| `src/lib/profile.js` | 本地注册实现（settings.json 注入/清理） |
| `src/cli/state.js` | state.json 读写 |
| `src/cli/paths.js` | 路径解析 |
| `src/server/server.cjs` | HTTP Session Server（/send, /cmd, /hook, /status） |
| `scripts/bootstrap.sh` | 启动 tmux session + 渲染 settings + MCP 配置 |
| `src/mcp/awf-state/server.cjs` | 状态 MCP — 17 个 tools，直接文件 I/O |
| `src/mcp/awf-session/server.cjs` | Session MCP — 4 个 tools |
| `src/mcp/awf-oneshot/server.cjs` | OneShot MCP — 1 个 tool |
| `src/prompts/run/state-machine.md` | 自治执行规则（注入给 AI 的运行时指令） |
| `plugin/plugin-code/settings.json` | 插件安装清单（本地注入源 / 全局安装源） |
| `docs/discuss/architecture-notes.md` | 架构决策记录 |

## 用户配置（`.claude/user/`）

Personal preferences stored in the target project's `.claude/user/`, NOT committed:
- `style-preferences.md` — UI style choices
- `awf-run-requirements.md` — Original requirements for awf-run

## 文档系统

```
docs/
├── features/    # w-doc 产出的需求文档 + 测试用例 + WBS + 原型
├── issues/      # 阻塞问题、待决策事项
├── bugs/        # 缺陷记录、根因、修复方案
├── logs/        # 开发日志、变更记录、路线图
└── discuss/     # 讨论记录、方案对比、架构决策、方法论
```

- **`.claude/issues/`** — Issue escalation: AI creates issues here for human-needed decisions


<!-- awf-rules start -->

## awf 模式

读取 `state.json` 的 `mode` 字段确定当前模式：

| mode | 含义 |
|------|------|
| `plan` | awf plan 规划中 |
| `run` | awf run 执行中 |
| `idle` | 无 awf 进程 |

### plan和run通用规则

- `.awf/state.json` 只能通过 `awf-state` MCP 工具修改，禁止直接文件读写

### awf-plan 模式

### awf-run 模式

- 需要用户决策时，禁止直接列出选项等待回复。必须先调 MCP tool 通知 CLI：
  - 选择题 → `awf_await_choice({question, options[], context?})`
  - 自由输入 → `awf_await_input({question, context?})`
  调用后按原有方式呈现选项即可，CLI 会自动检测并收集用户回应。

<!-- awf-rules end -->
