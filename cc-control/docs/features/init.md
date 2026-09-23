# awf init — 功能文档

> 对应 WBS：
> 源码：`cli/commands/init.cjs`（`initCommand`）；插件注册复用 `cli/commands/plugin.cjs` + `server/adapters/cc/profile.cjs`

## 功能描述

`awf init` 把当前目录初始化为可运行 `awf plan` / `awf run` 的工作流项目，只做三件事：

1. **前置检查** — `tmux`（warn）/ `claude`（error）；
2. **本地注册插件** — 把 `plugin/settings.json` 注入项目 `.claude/settings.json`，并按 `plugin/config.json` 写入项目级 `.mcp.json`；
3. **工作区初始化** — 生成 `.awf/` 精简骨架，条件性注入 CLAUDE.md。

**全局安装不由 init 负责**：需要把插件装到用户级（`~/.claude/plugins`）时，另走 `awf plugin install --scope global`（`claude plugin install` 方案）。init 默认走本地 scope。

## 执行流程

```
initCommand(options)
  ├─ 0. 版本确认（暂时禁用，version = undefined）
  ├─ 1. 前置依赖检查 checkPrerequisites()
  │       tmux  → warn 「未安装 — brew install tmux」（缺失不阻断）
  │       claude → error「未安装 — npm install -g @anthropic-ai/claude-code」
  │       任一 error → 打印「缺少必要依赖」+ process.exit(1)
  ├─ 2. 注册插件 pluginCommand('install')   # 默认本地 scope
  │       installProfile(cwd, projectRoot)    → 项目 .claude/settings.json
  │       installProjectMcp(cwd, projectRoot) → 项目 .mcp.json
  ├─ 3. 初始化项目 initWorkspace(paths, force, version)
  ├─ 4. 初始化 CLAUDE.md initClaudeMd(...)
  └─ 5. 引导输出（awf plan / awf run 提示）
```

### 步骤 2：本地注册写了哪些文件

| 文件 | 写入函数 | 内容 |
|------|----------|------|
| `<cwd>/.claude/settings.json` | `installProfile`（`server/adapters/cc/profile.cjs`） | 把 `plugin/settings.json` 深合并进去：`plugins` / `enabledPlugins` / `extraKnownMarketplaces`；`<pkg>` 占位替换为包根绝对路径 |
| `<cwd>/.mcp.json` | `installProjectMcp`（`server/adapters/cc/profile.cjs`） | 由 `plugin/config.json` 渲染的 `awf-state` / `awf-session` / `awf-oneshot` 三个 server；每个 server 带 `env.AWF_PROJECT_ROOT = projectRoot` |

- **合并语义**：`installProfile` 数组去重追加、对象递归合并，**不覆盖**用户已有的其它键（如 `figma@claude-plugins-official` 等第三方项原样保留）。
- **路径形态**：自托管（目标项目 == cc-control 包根）→ `.mcp.json` 用相对路径 `plugin/core/...`（可移植、git 干净）；跨项目 → 绝对路径。
- **幂等**：`.mcp.json` 只覆盖 awf-* 同名 server（保证指向当前安装位置），保留项目其它 server。

### 步骤 3：`.awf/` 精简骨架

`initWorkspace` 先 `mkdir` 运行时目录，再对缺失文件从 `server/templates/` 复制（不覆盖用户已改过的）：

```
.awf/
├── README.md              # ← server/templates/awf-README.md（缺失时）
├── config.json            # ← server/templates/awf-config.jsonon（缺失时）
├── state.json             # ← plugin/core/mcp/awf-state/state.template.json（缺失时；替换 {{TIMESTAMP}}）
├── context/
│   └── architecture.md    # ← server/templates/architecture.md（缺失时）
├── bugs/                  # 运行时缺陷记录
├── issues/                # Issue 跟踪
├── decisions/             # AI 运行期决策记录
├── dynamic-planning/      # 动态规划 proposal / 事件扩展边界
│   └── proposals/
├── logs/                  # awf run 全量运行日志
├── versions/              # 版本归档
└── reports/
    ├── lint/  ├── test/  ├── review/  ├── perf/  └── summary/
```

> 目录清单取自 `init.js` 的 `dirs` 数组（与 `server/templates/awf-README.md` 的目录说明一致）。
> 真机回归只校验 8 个顶层目录存在：`bugs / issues / decisions / dynamic-planning / context / logs / reports / versions`。

### `--force` 与幂等语义

| 场景 | 行为 |
|------|------|
| `.awf/` 不存在 | `ensureSkeleton()`，logStep `ok` 「已创建」 |
| `.awf/` 已存在、无 `--force` | **不动任何文件**，logStep `warn` 「已存在，使用 --force 补全缺失文件」 |
| `.awf/` 已存在、带 `--force` | `ensureSkeleton()` 补齐缺失目录/文件，logStep `ok` 「已补全缺失文件」；已有文件不被覆盖 |

`state.json` / `README.md` / `config.json` / `architecture.md` 均「目标不存在才复制」，故 `--force` 不会改写已有内容。

### 步骤 4：CLAUDE.md 注入（已弃用）

`initClaudeMd` 读 `server/templates/CLAUDE.md.template`：

- 模板缺失 → warn 「模板文件不存在，跳过注入」；
- **模板内容为空 → skip「awf 规则模板已弃用（内容为空），跳过注入」**（当前模板为 0 字节，即新项目不再被写入 awf 规则段）；
- 模板非空时：CLAUDE.md 不存在 → 创建；存在但无 `<!-- awf-rules start -->` 标记 → 追加；已含标记 → skip。

> 弃用原因：原模板把「需要用户决策时必须调 `awf_await_choice`」写进项目 CLAUDE.md，与决策门阀（决策技能自决）互斥。保留函数与模板文件仅为兼容既有安装。

## 核心常量 / 配置

| 常量 | 值 | 说明 |
|------|-----|------|
| 骨架目录 | `bugs, issues, decisions, dynamic-planning/proposals, context, logs, reports/{lint,test,review,perf,summary}, versions` | `init.js` `dirs` 数组 |
| CLAUDE.md 标记 | `<!-- awf-rules start -->` | 判定是否已注入 |
| state 模板路径 | `plugin/core/mcp/awf-state/state.template.json` | 经 `stateTemplatePath()`（`plugin-bridge.js`）解析 |
| 默认 scope | `local` | `pluginCommand` 缺省 scope |

`.awf/config.json` 模板（`server/templates/awf-config.jsonon`）字段：

| 字段 | 默认 | 说明 |
|------|------|------|
| `run.agents.max` | `1` | 全局并发 agent 上限 |
| `run.agents.maxModules` | `1` | 模块级并发上限 |
| `run.agents.maxPerModule` | `1` | 单模块内并发上限 |
| `run.agents.maxPerFeature` | `1` | 单特性内并发上限 |
| `run.decision.enabled` | `false` | AWF 决策闸门开关（缺省关） |
| `run.dynamicPlanning.mode` | `approve_then_apply` | 动态任务规划执行模式；也可设 `auto_then_review` |
| `run.dynamicPlanning.extensions` | `{}` | 未来 reviewer/notifier/policy adapter 的配置空间，核心当前透传记录 |
| `docs.enabled / types / reports` | `true / [...] / [...]` | 文档体系开关 |

## 函数清单

| 函数 | 说明 | 位置 |
|------|------|------|
| `initCommand(options)` | 主入口：前置检查 → 注册插件 → 工作区 → CLAUDE.md | `cli/commands/init.cjs` |
| `checkPrerequisites()` | 检查 tmux（warn）/ claude（error），返回结果数组 | `cli/commands/init.cjs` |
| `initWorkspace(paths, force, version)` | 创建/补全 `.awf/`，内部闭包 `ensureSkeleton` | `cli/commands/init.cjs` |
| `copyStateTemplate(awfDir)` | 目标不存在时从 `state.template.json` 复制 | `cli/commands/init.cjs` |
| `replaceTimestamp(filePath)` | 替换 `{{TIMESTAMP}}` | `cli/commands/init.cjs` |
| `replaceVersion` / `replaceInDir` | 递归替换 `{{VERSION}}`（version 为 undefined 时整体跳过） | `cli/commands/init.cjs` |
| `initClaudeMd(projectRoot, cwd)` | 条件性注入 awf 规则到 CLAUDE.md | `cli/commands/init.cjs` |
| `pluginCommand(action, {scope})` | 按 scope 分发：local（默认）/ global | `cli/commands/plugin.cjs` |
| `installProfile(projectRoot, pkgRoot)` | 本地注册：合并 `plugin/settings.json` → 项目 `.claude/settings.json` | `server/adapters/cc/profile.cjs` |
| `installProjectMcp(projectRoot, repoRoot, port?)` | 渲染并合并 awf-* server → 项目 `.mcp.json` | `server/adapters/cc/profile.cjs` |
| `projectMcpJson(repoRoot, port, projectRoot)` | 按自托管/跨项目选择路径形态，渲染 mcpServers | `server/shared/plugin-render.cjs` |

## 接口 / 依赖

| 模块 | 用途 |
|------|------|
| `node:child_process` (`execSync`) | 前置检查 `command -v tmux` |
| `server/adapters/ports.cjs` (`tooling`) | `tooling.claudeAvailable` 检查 claude（不直连 adapter 文件） |
| `cli/commands/plugin.cjs` (`pluginCommand`) | 触发本地注册 |
| `server/adapters/cc/profile.cjs` | 本地注册实现（settings 注入 + 项目 MCP 注册） |
| `server/shared/prompts.js` (`stateTemplatePath`) | state 模板路径解析（插件边界唯一模块） |
| `server/shared/project-paths.cjs` (`getPaths`) | 解析 `projectRoot` 等 |
| `server/templates/*` | 骨架模板（README / config / architecture / CLAUDE.md.template） |
| `（已删除：TTY 表现层，见 .awf/issues/017）` | `logSection` / `logStep` 分节分步输出 |

## 验收标准

- [ ] 未装 claude → `process.exit(1)`；未装 tmux → warn 但继续
- [ ] `.awf/` 不存在时创建完整骨架（含 11 个目录 + README/config/state/architecture）
- [ ] `.awf/` 已存在且无 `--force` → 文件 mtime 不变；带 `--force` → 补缺失但不覆盖已有
- [ ] `.claude/settings.json` 含声明的插件且均 enabled，marketplace 的 `source.path` 存在于磁盘
- [ ] `.mcp.json` 含三个 awf-* server：绝对/相对路径存在、`AWF_PROJECT_ROOT` 指向本项目、`awf-session` 的 `AWF_BASE` 带端口
- [ ] 重跑 init → `.claude/settings.json` 与 `.mcp.json` 内容不漂移（幂等）
- [ ] 默认模板为 0 字节时，新项目**不**生成含 awf 规则的 `CLAUDE.md`
