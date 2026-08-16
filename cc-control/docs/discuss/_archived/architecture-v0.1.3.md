# ai-workflow 架构文档 v0.1.3

> 记录于 2026-07-30，重构前基线。

## 一、项目定位

**ai-workflow** 是一个 Claude Code 插件 + CLI 工具（npm 包 `ai-workflow`），给 AI 加上持久记忆、工作流编排和自主推进能力。

- **npm 包版本**: 0.1.1
- **插件版本**: 2.0.0（独立于 npm 版本）
- **唯一运行时依赖**: commander ^12.1.0
- **包类型**: ESM（`"type": "module"`）

## 二、三层架构

```
┌─────────────────────────────────────────────────────────┐
│  CLI 层 (bin/awf.js + src/cli/)                         │
│  用户入口：awf init → awf plan → awf run                │
│  读写 .awf/state.json，启动 Server + tmux，驱动循环      │
├─────────────────────────────────────────────────────────┤
│  编排层 (src/server/)                                    │
│  HTTP Server :8787，桥接 CLI ↔ tmux 内的 Claude Code    │
│  ready/busy 状态机，由 Claude Code Hooks 驱动            │
├─────────────────────────────────────────────────────────┤
│  AI 工具层 (tools/ + commands/ + skills/ + prompts/)     │
│  作为 Claude Code 插件加载到 tmux session               │
│  AI 通过 slash commands 执行阶段                         │
│  通过 MCP tools 持久化状态到 state.json                  │
└─────────────────────────────────────────────────────────┘
```

### 2.1 CLI 层

**入口**: `bin/awf.js` — Commander-based，7 个子命令：

| 命令 | 处理器 | 职责 |
|------|--------|------|
| `awf init` | `src/cli/commands/init.js` | 初始化 .awf/ 目录 + 安装插件 |
| `awf plan [desc]` | `src/cli/commands/plan.js` | 启动规划 session（spawn claude） |
| `awf run [task]` | `src/cli/commands/run.js` | 核心循环：读 state → 启 server → 启 tmux → 遍历任务执行阶段链 |
| `awf plugin <install\|uninstall>` | `src/cli/commands/plugin.js` | 插件 symlink 管理 |
| `awf server <start\|stop\|status>` | `src/cli/commands/server.js` | tmux-http server 生命周期 |
| `awf open <tree\|ui\|dashboard>` | `src/cli/commands/open.js` | 打开可视化页面 |
| `awf attach` | `src/cli/commands/attach.js` | 附加到 tmux session |

**CLI 工具层** (`src/cli/utils/`):

| 模块 | 职责 |
|------|------|
| `paths.js` | 路径解析 + `PLUGIN_NS = 'ai-workflow'` + `pluginCmd()` 辅助 |
| `state.js` | state.json 读写 + `findNextTask()` + `isMilestoneDone()` |
| `logger.js` | ANSI 彩色 console 日志 |

### 2.2 编排层

**HTTP Session Server** (`src/server/server.cjs` + `tmux.cjs`)，端口 8787：

```
┌──────────┐    POST /hook     ┌──────────────┐    tmux send-keys    ┌──────────┐
│  Claude   │ ────────────────→│  Session      │ ──────────────────→│  tmux     │
│  Code     │                  │  Server :8787 │                    │  session  │
│  Hooks    │←────────────────│               │←───────────────────│  "cc"     │
└──────────┘   ready/busy      └──────────────┘   capture / status   └──────────┘
                                       ↑
                                       │ POST /send, /cmd
                                       │ GET /status, /awf/state
                                       ↓
                               ┌──────────────┐
                               │  CLI (awf)   │
                               └──────────────┘
```

**状态机**: `ready` ↔ `busy`，由 Claude Code Hooks 驱动：
- `SessionStart` / `Stop` → `ready`
- `UserPromptSubmit` → `busy`

**端点**:

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/` | 返回 dashboard.html |
| GET | `/ui` | 返回 ui.html |
| POST | `/hook` | Hook 回调，状态转换 |
| POST | `/send` | 等待 ready 后发送文本到 tmux |
| POST | `/cmd` | 同 send，带超时恢复 |
| POST | `/key` | 发送原始 tmux 按键 |
| GET | `/status` | 返回 `{ok, state, session}` |
| GET | `/awf/state` | 读取并返回 state.json |

**tmux.cjs**: `execFileSync` 封装，导出 `hasSession`, `sendText`, `sendEnter`, `sendKeys`, `capture`。

### 2.3 AI 工具层

作为 Claude Code 插件加载到 tmux session，包含三类资源：

**Slash Commands** (14 个，`commands/*.md`):
```
/awf-run     自主工作流驱动（状态机总控）
/w-plan      需求规划（Q&A → 需求文档 → 原型 → WBS → 任务列表）
/w-design    设计生命周期（3 种风格 → 用户选择）
/w-tree      任务分解树 + 双视图 HTML 可视化
/w-dev       开发执行
/w-debug     系统化调试（假设-证据-排除）
/w-review    代码审查（code-rule-style + code-rule-quality）
/w-test      测试用例检查
/w-ui        Figma UI 还原
/w-doc       文档生成
/w-commit    智能提交（conventional commits）
/w-finish    里程碑收尾（质量/性能/文档/总结/记忆/交接）
/w-prompt    Prompt 生成器（被 CLI one-shot 调用）
/w-state     状态管理 MCP tools 参考文档
```

**Skills** (10 个，`skills/*/SKILL.md`):
```
code-rule-design      架构/数据建模/状态管理 → PLAN/DESIGN 阶段
code-rule-style       函数设计/命名/错误处理 → CODE/DEBUG 阶段
code-rule-quality     测试金字塔/代码审查/提交规范 → REVIEW/TEST/FINISH 阶段
awf-sys-spec-workflow 自治工作流引擎完整规范（状态机/阶段/暂停/升级）
awf-sys-spec-task     任务 schema 定义
awf-flow-exec-prompt  Prompt 生成引擎（90+ 方法论文案 + 决策表 + 风格规则）
sys-rule-workflow     设计 commands/skills 的元规则
sys-rule-skill        Skill 生命周期管理
flow-rule-git         Git 分支/提交规范
flow-rule-task        任务分解方法论
flow-exec-version     版本号/Changelog 管理
code-patterns         代码模式目录（进行中，仅 candidates.md）
```

**MCP Servers** (3 个，`tools/*/server.cjs`):

| Server | 工具数 | 职责 |
|--------|--------|------|
| awf-state | 14 | 状态 CRUD，直接文件 I/O 读写 `.awf/state.json` |
| awf-session | 2 | tmux 生命周期观测（状态查询 + pane 抓取） |
| awf-oneshot | 1 | 无状态 LLM 调用（spawn `claude -p`） |

**Phase Prompts** (8 个，`prompts/run/*.md`): 本地 fallback 模板，当 one-shot 不可用时使用。

## 三、核心执行流程

```
awf run
  │
  ├─ 1. 读取 .awf/state.json
  ├─ 2. 启动 HTTP Session Server (:8787)
  ├─ 3. bootstrap.sh → 创建 tmux session "cc"
  │     ├─ 渲染 hooks/settings.json（SessionStart/Stop/UserPromptSubmit → curl /hook）
  │     ├─ 渲染 .mcp.json（awf-state + awf-session + awf-oneshot）
  │     └─ 启动 claude --plugin-dir . --permission-mode bypassPermissions
  │
  └─ 4. 遍历任务，按复杂度执行阶段链：
        simple:   DEV → COMMIT
        medium:   DEV → TEST → COMMIT
        complex:  DEV → DOCS → REVIEW → TEST → COMMIT
                    ↑                        ↓
                    └── DEBUG（按需）────────┘
        └─ FINISH 收尾

每个阶段：
  CLI 通过 claude -p 生成优化 prompt（或使用本地 fallback）
    → POST /send 发往 tmux session
    → 轮询 /status 等待 ready
    → 进入下一阶段
```

**关键设计决策**:
- **阶段间上下文天然断裂** — 每个阶段的 prompt 重新构造，不依赖上一阶段对话历史
- **AI 通过 MCP tools 更新 state.json** — 不再需要 curl
- **阶段驱动** — CLI 主动控制节奏，AI 被动响应每个阶段的 prompt

## 四、目录模块划分

```
cc-control/
├── bin/awf.js                    CLI 入口（Commander，7 命令）
├── package.json                  npm 包（bin + files 双分发）
├── plugin.json                   Claude Code 插件清单
│
├── src/
│   ├── cli/commands/             7 个 CLI 命令实现
│   │   ├── init.js               awf init
│   │   ├── plan.js               awf plan
│   │   ├── run.js                awf run（核心，~600 行）
│   │   ├── plugin.js             awf plugin
│   │   ├── server.js             awf server
│   │   ├── open.js               awf open
│   │   └── attach.js             awf attach
│   ├── cli/utils/                共享工具
│   │   ├── paths.js              路径解析 + 插件命名空间
│   │   ├── state.js              state.json 读写
│   │   └── logger.js             日志
│   └── server/                   HTTP Session Server
│       ├── server.cjs            主程序（ready/busy 状态机）
│       ├── tmux.cjs              tmux 命令封装
│       ├── ui.html               Web UI
│       ├── dashboard.html        Dashboard
│       └── hooks/settings.json   Hook 配置模板
│
├── tools/                        3 个独立 MCP Server（零依赖 CJS）
│   ├── awf-state/server.cjs     状态 CRUD（14 tools）
│   ├── awf-session/server.cjs   Session 观测（2 tools）
│   └── awf-oneshot/server.cjs   无状态 LLM 调用（1 tool）
│
├── commands/                     14 个 slash commands（.md）
├── skills/                       10 个 skills（SKILL.md × 2 语言）
├── prompts/run/                  8 个阶段 prompt 模板
│
├── scripts/                      开发脚本
│   ├── bootstrap.sh             启动 tmux + Claude Code
│   ├── test.sh                  测试
│   ├── lint.sh                  语法检查
│   ├── build.sh                 打包验证
│   └── eval.sh                  AI 评测（占位）
│
├── tests/
│   ├── unit/                    单元测试（空）
│   ├── integration/smoke.sh     E2E 冒烟测试
│   ├── fixtures/                测试数据（chess-state.json, go-game-state.json）
│   └── eval/                    评测（占位）
│
├── docs/
│   ├── features/                需求文档 + WBS + 任务列表
│   ├── issues/                  阻塞问题
│   ├── bugs/                    缺陷记录
│   ├── logs/                    开发日志/路线图
│   └── discuss/                 架构决策/方法论/讨论
│
├── .claude/                     Claude Code 项目配置
│   ├── settings.json            权限配置
│   ├── settings.local.json      本地覆盖
│   ├── templates/               HTML 模板
│   └── user/                    用户偏好
│
├── .claude-plugin/              本地 marketplace 注册
├── sandbox/                     测试沙箱（gitignored）
└── CLAUDE.md                    项目开发指南
```

## 五、数据流

```
                    .awf/state.json
                         ↑
                    ┌────┴────┐
                    │ 读写     │
                    │          │
               CLI 层          AI 工具层
              (state.js)    (awf-state MCP)
                    │          ↑
                    │          │
                    ↓          │
               HTTP Server ────┘
                    │
                    ↓
               tmux session "cc"
                    │
                    ↓
               Claude Code
```

- **CLI** 读 state.json 决定下一个任务/阶段，写 state.json 更新状态
- **AI** 通过 awf-state MCP tools 在执行过程中更新任务状态、结果、commit 等
- **HTTP Server** 作为中间层，CLI 通过它向 AI 发 prompt，AI 通过 hooks 通知 server 状态

## 六、关键文件索引

| 文件 | 行数(约) | 角色 |
|------|----------|------|
| `bin/awf.js` | ~80 | CLI 入口，命令路由 |
| `src/cli/commands/run.js` | ~600 | `awf run` 主循环（最复杂） |
| `src/cli/commands/init.js` | ~200 | 初始化逻辑 |
| `src/cli/utils/state.js` | ~100 | state.json 读写 |
| `src/cli/utils/paths.js` | ~60 | 路径解析 |
| `src/server/server.cjs` | ~250 | HTTP Session Server |
| `src/server/tmux.cjs` | ~80 | tmux 封装 |
| `tools/awf-state/server.cjs` | ~500 | 状态 MCP（14 tools） |
| `tools/awf-session/server.cjs` | ~150 | Session MCP（2 tools） |
| `tools/awf-oneshot/server.cjs` | ~80 | OneShot MCP（1 tool） |
| `scripts/bootstrap.sh` | ~100 | tmux 启动编排 |
| `skills/awf-flow-exec-prompt/SKILL.md` | ~800 | Prompt 生成引擎 |
| `skills/awf-sys-spec-workflow/SKILL.md` | ~600 | 工作流规范 |
| `prompts/run/state-machine.md` | ~200 | AI 运行时指令 |

## 七、技术栈

| 层 | 技术 |
|----|------|
| CLI | Node.js ESM, Commander |
| Server | Node.js CommonJS, 原生 http 模块 |
| MCP Servers | Node.js CommonJS, stdio JSON-RPC |
| 进程管理 | tmux（send-keys, capture-pane） |
| 状态存储 | JSON 文件（.awf/state.json） |
| 插件系统 | Claude Code Plugin API |
| 测试 | node --test, bash smoke tests |
