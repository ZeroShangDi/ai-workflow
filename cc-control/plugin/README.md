# Plugin — ai-workflow 双插件市场

`plugin/` 是 ai-workflow 的插件市场根目录，声明并承载两个 Claude Code 插件：

| 插件 | 目录 | 定位 |
|------|------|------|
| **ai-workflow-core** | `core/` | 引擎层 — 跨领域通用：MCP（state/session/oneshot）+ hooks + 运行态命令/技能 + awf-worker 子 Agent |
| **ai-workflow-code** | `plugin-code/` | 编程层 — 规划/开发/审查/测试/文档等编程领域命令与技能 |

市场入口由 `plugin/.claude-plugin/marketplace.json` 声明双插件（`ai-workflow-dev`），`settings.json` 为安装清单。

## 目录结构

```
plugin/
├── .claude-plugin/
│   └── marketplace.json        # 双插件市场入口（渲染生成：core + plugin-code）
├── config.json                 # ★ 唯一配置源：port / marketplace / mcpServers / hooks
├── settings.json               # 安装清单（本地注入源 / 全局安装源，含 core + plugin-code）
├── README.md
├── CHECKLIST.md                # 插件验收清单
├── PLAN.md                     # 插件规划文档
├── interview-questions.md
│
├── core/                       # 引擎层插件 ai-workflow-core
│   ├── plugin.json             #   插件声明（含 hooks 字段）
│   ├── .mcp.json               #   3 个 MCP server 声明（相对路径）
│   ├── hooks/
│   │   └── hooks.json          #   7 个 hooks（SessionStart/UserPromptSubmit/Stop/SubagentStart/SubagentStop/PreToolUse/PostToolUse）
│   ├── agents/
│   │   ├── awf-worker.md       #   滑动窗口执行单元子 Agent（禁写 state，RESULT/NEEDS_INPUT 协议）
│   │   ├── awf-monitor-probe.md  # w-monitor 一次性侦查 Agent（只读、PROBE_RESULT 协议）
│   │   └── awf-monitor-repair.md # w-monitor 一次性修复 Agent（单次修复、REPAIR_RESULT 协议）
│   ├── commands/               #   运行态 slash commands
│   │   ├── w-start.md
│   │   ├── w-pause.md
│   │   ├── w-monitor.md
│   │   └── w-state.md
│   ├── skills/                 #   运行态技能（awf-run-* + 通用）
│   │   ├── awf-run-decision/
│   │   │   ├── SKILL.md
│   │   │   └── references/decision-permissions.md
│   │   ├── awf-run-error/
│   │   │   ├── SKILL.md
│   │   │   └── references/issue-escalation.md
│   │   ├── awf-run-reset/SKILL.md
│   │   ├── awf-run-review/SKILL.md
│   │   ├── awf-run-test/SKILL.md
│   │   ├── awf-task-context/SKILL.md
│   │   ├── awf-skill/SKILL.md
│   │   └── awf-state/SKILL.md
│   └── mcp/                    #   MCP server 实现
│       ├── awf-state/          #     18 tools，直接文件 I/O
│       │   ├── server.cjs
│       │   └── state.template.json
│       ├── awf-session/        #     7 tools（tmux 生命周期观测 + pause 闩锁保护的修复介入）
│       │   └── server.cjs
│       └── awf-oneshot/        #     1 tool（无状态 LLM 调用）
│           └── server.cjs
│
└── plugin-code/                # 编程层插件 ai-workflow-code
    ├── plugin.json             #   插件声明（无 hooks 字段）
    ├── prompts.json            #   插件声明提示词模板（plan-start/resume/default + task-wrapup/settle + context-check + batch-*/subagent-dispatch）
    ├── commands/               #   编程领域 slash commands
    │   ├── w-plan.md           #     主规划流程
    │   ├── w-plan-check.md     #     CLI plan 门禁检查
    │   ├── w-plan-wbs.md       #     WBS 空间树
    │   ├── w-plan-tasks.md     #     任务列表（含门禁任务）
    │   ├── w-dev.md            #     开发流程
    │   ├── w-debug.md          #     调试流程
    │   ├── w-review.md         #     审查流程
    │   ├── w-test.md           #     测试流程
    │   ├── w-doc.md            #     文档管理
    │   ├── w-commit.md         #     提交流程
    │   ├── w-ui-design.md      #     设计原型界面
    │   └── w-ui-code.md        #     按设计稿实现静态页面
    └── skills/                 #   编程领域技能
        ├── awf-plan-level/SKILL.md
        ├── awf-plan-norm/SKILL.md
        ├── awf-plan-wbs/SKILL.md
        ├── awf-plan-tasks/
        │   ├── SKILL.md
        │   └── references/task-splitting-heuristics.md
        ├── awf-plan-prompt/SKILL.md
        ├── code-context-onboard/SKILL.md
        ├── code-ask-question/SKILL.md
        ├── code-commit-gitflow/
        │   ├── SKILL.md
        │   └── references/cancommit-gate.md
        ├── code-doc/SKILL.md
        ├── code-retro-point/SKILL.md
        ├── code-dev-rule/SKILL.md
        ├── code-dev-design/SKILL.md
        ├── code-dev-cto/SKILL.md
        ├── code-dev-quality/
        │   ├── SKILL.md
        │   └── references/
        │       ├── code-patterns-candidates.md
        │       └── observability.md
        ├── code-dev-security/SKILL.md
        ├── code-dev-performance/SKILL.md
        ├── code-dev-fallback/SKILL.md
        ├── code-dev-experience-react/SKILL.md
        ├── code-dev-experience-vue/SKILL.md
        ├── code-review-quality/SKILL.md
        ├── code-review-performance/SKILL.md
        ├── code-review-security/SKILL.md
        ├── code-review-simplify/SKILL.md
        ├── code-architecture/SKILL.md
        ├── code-review-architecture/SKILL.md
        └── code-test-case/SKILL.md
```

## 配置源机制

`plugin/config.json` 是**唯一配置源**，集中声明 `port` / `marketplace` / `mcpServers` / `hooks` 四项。运行 `node scripts/render-config.mjs`（`npm run build` 的子集）据此渲染出库内的注册文件：

| 渲染产物 | 来源 |
|---------|------|
| `plugin/.claude-plugin/marketplace.json` | `marketplace` 段（双插件入口，`dir` → `source`） |
| `plugin/core/.mcp.json` | `mcpServers` 段（相对路径，`${CLAUDE_PLUGIN_ROOT}` 占位） |
| `plugin/core/hooks/hooks.json` | `hooks` 段（`__PORT__` → 端口字面量） |
| `plugin/core/plugin.json` | core 插件声明（含 hooks 字段） |
| `plugin/plugin-code/plugin.json` | plugin-code 插件声明（无 hooks 字段） |

命令行模式 `node scripts/render-config.mjs --workdir <dir> [--port <port>]` 渲染独立沙箱文件；`bootstrap.sh` 已不调用该模式，插件/hooks/MCP 统一由 `.claude/settings.json` 注册加载，避免覆盖项目注册。

## 插件构成

### core — 引擎层（ai-workflow-core）

- **MCP 3 server**：`awf-state`（18 tools，状态 CRUD）、`awf-session`（7 tools，tmux 观测 + 受控介入）、`awf-oneshot`（1 tool，无状态 LLM）
- **7 hooks**：`SessionStart` / `UserPromptSubmit` / `Stop` / `SubagentStart` / `SubagentStop` / `PreToolUse`（matcher: AskUserQuestion）/ `PostToolUse`，全部上报 HTTP Session Server
- **运行态命令**：`w-start` / `w-pause` / `w-monitor` / `w-state`
- **运行态技能**：`awf-run-decision` / `awf-run-error` / `awf-run-reset` / `awf-run-review` / `awf-run-test` / `awf-task-context` / `awf-skill` / `awf-state`
- **子 Agent**：`agents/awf-worker.md`（见下）

### plugin-code — 编程层（ai-workflow-code）

- **命令**：`w-plan*` 规划四连（plan/check/wbs/tasks）+ `w-dev` / `w-debug` / `w-review` / `w-test` / `w-doc` / `w-commit` / `w-ui-design` / `w-ui-code`
- **提示词模板**：`prompts.json` 声明 plan 入口（start/resume/default）与任务收尾 wrapup/settle、context-check、subagent-dispatch，runtime 指令由插件声明
- **技能**：`awf-plan-*` 规划技能 + `code-dev-*` 开发技能 + `code-architecture` 架构决策 + `code-review-*` 多维审查（含架构审查）+ `code-test-case` + 通用上下文/提交/文档技能

## awf-worker 子 Agent

`core/agents/awf-worker.md` 声明了 ai-workflow 滑动窗口调度的执行单元 Agent，由主会话通过 Agent 工具按任务窗口后台并行派发，行为协议：

- **只做单一任务** — 只执行 Agent 工具 prompt 参数交给的那一件事，不扩展范围、不派生其他子 Agent、不提交
- **禁写 state** — 只能调 `awf_read_state` 读取上下文；禁止任何写工具（`awf_task_status` / `awf_task_result` / `awf_task_commit` / `awf_task_create` 等），state.json 由主会话 / CLI 更新
- **禁提问** — 不调用交互工具；有歧义按最佳判断执行，遇真正需用户决策用 `NEEDS_INPUT` 上抛
- **结构化输出协议** — 完成时输出 `RESULT: {"taskId", "status", "result", "files"}`（status 取 `done | blocked | failed`）；需决策时输出 `NEEDS_INPUT: {"taskId", "question", "options", "context"}`。taskId 必须使用派发时的任务 ID，不得编造

## w-monitor 子 Agents

- **awf-monitor-probe**：每 3 分钟由 `w-monitor` 新建一次，自行读取 tmux pane、运行日志和 state，与上次紧凑快照比较，只读并返回 `PROBE_RESULT`
- **awf-monitor-repair**：异常确认且 CLI 已暂停后由 `w-monitor` 新建，一次只执行一次场景修复，验证后返回 `REPAIR_RESULT`
- **上下文隔离**：主监控不读取完整 pane；现场、错误堆栈和修复推理随子 Agent 结束释放，主监控只保留结构化摘要、异常指纹和修复次数

## 安装

`awf init` 阶段统一处理插件注册：

- **本地注入**：读 `plugin/settings.json`（含 core + plugin-code）注入到项目 `.claude/settings.json`
- **全局安装**：`awf plugin install --scope global` 按 `settings.json.plugins` 声明的 `ai-workflow-core@ai-workflow-dev` / `ai-workflow-code@ai-workflow-dev` 执行 `claude plugin install`

> 架构原则：插件改动，CLI 零感知。CLI 只通过 `src/lib/plugin-bridge.js` 读插件 `prompts.json` 填充提示词，不写死任何插件命令字符串。
