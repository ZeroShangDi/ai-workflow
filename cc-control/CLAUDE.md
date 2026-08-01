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

  plugin/                  # Claude Code 插件
    plugin.json
    commands/              #   14 个 slash commands
    skills/                #   10 个 skills

  src/                     # 应用代码
    awf.js                 #   CLI 入口（Commander，7 个命令）
    cli/                   #   CLI 命令实现（init, plan, run...）
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

- **PLAN**: Interactive Q&A → requirements doc → prototype → WBS → task list (`/w-plan`)
- **DESIGN**: Generate 3 UI styles → user picks → generate UI incrementally (`/w-design`)
- **CODE**: Loop through tasks sequentially (`/w-dev`)
- **DEBUG**: Systematic debugging when bugs surface (`/w-debug`)
- **REVIEW**: Code review against code-rule-style + code-rule-quality (`/w-review`)
- **TEST**: Inspect test case docs against actual code behavior (`/w-test`)
- **FINISH**: Milestone wrap-up — quality, perf, docs, summary, memory, handoff (`/w-finish`)

Any node can loop back. FINISH is a milestone marker, not project end.

## Slash commands

| Command | Purpose |
|---------|---------|
| `/awf-run` | Autonomous workflow — drives the full state machine |
| `/w-plan` | Task planning: requirements → prototype → WBS → task list |
| `/w-design` | Design lifecycle: style selection, code↔Figma |
| `/w-tree` | Task breakdown tree with dual-view HTML visualization |
| `/w-dev` | Development execution — explore, implement, lint, verify |
| `/w-debug` | Systematic debugging via hypothesis-evidence-elimination |
| `/w-review` | Code review against dual standards (code + quality) |
| `/w-test` | Test case inspection — compare `.test.md` docs against code |
| `/w-ui` | UI restoration from Figma (requires `node-id` in URL) |
| `/w-doc` | Module or requirement-level docs |
| `/w-commit` | Smart commit with conventional commit messages |
| `/w-finish` | Milestone wrap-up: quality/perf/doc/summary/memory/handoff |
| `/w-prompt` | Prompt generator for CLI（被 CLI one-shot 调用） |
| `/w-state` | State management reference（→ src/mcp/awf-state/） |

## Skills

- **`code-rule-design`** — Architecture, data modeling, state management. Applied during PLAN/DESIGN.
- **`code-rule-style`** — Function design, naming, error handling, defensive programming. Applied during CODE/DEBUG.
- **`code-rule-quality`** — Testing pyramid (70/20/10), code review, conventional commits. Applied during REVIEW/TEST/FINISH.
- **`sys-rule-workflow`** — Standards for designing commands and skills.
- **`sys-rule-skill`** — Skill lifecycle management — create, update, delete, organize, audit.
- **`flow-rule-git`** — Git branching and commit conventions.
- **`flow-rule-task`** — Task decomposition rules — how to split work at the right granularity. Applied during PLAN/WBS.
- **`flow-exec-version`** — Version bumping and changelog management.
- **`awf-sys-spec-workflow`** — Autonomous workflow specification format.
- **`awf-sys-spec-task`** — Task schema definition（→ src/mcp/awf-state/）
- **`awf-flow-exec-prompt`** — Prompt generator for awf-run phases（→ src/mcp/awf-state/）

These are invoked automatically by slash commands. Do not invoke them manually unless explicitly requested.

## MCP Tools（3 个 Server）

### awf-state（14 tools）— 状态 CRUD，直接文件 I/O

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

### awf-session（2 tools）— tmux 生命周期观测

| Tool | 用途 |
|------|------|
| `awf_session_status` | 查询 session ready/busy 状态 |
| `awf_capture_pane` | 抓取 tmux pane 内容 |

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

# Claude Code 插件
claude --plugin-dir .     # 临时加载
/plugin install ai-workflow@ai-workflow-dev  # 永久安装
```

## 关键文件

| 文件 | 角色 |
|------|------|
| `src/awf.js` | CLI 入口，命令路由 |
| `src/cli/run.js` | `awf run` 主循环 |
| `src/cli/state.js` | state.json 读写 |
| `src/cli/paths.js` | 路径解析 |
| `src/server/server.cjs` | HTTP Session Server（/send, /cmd, /hook, /status） |
| `scripts/bootstrap.sh` | 启动 tmux session + 渲染 settings + MCP 配置 |
| `src/mcp/awf-state/server.cjs` | 状态 MCP — 14 个 tools，直接文件 I/O |
| `src/mcp/awf-session/server.cjs` | Session MCP — 2 个 tools |
| `src/mcp/awf-oneshot/server.cjs` | OneShot MCP — 1 个 tool |
| `src/prompts/run/state-machine.md` | 自治执行规则（注入给 AI 的运行时指令） |
| `plugin/skills/awf-sys-spec-workflow/SKILL.md` | 核心状态机规范 |
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

