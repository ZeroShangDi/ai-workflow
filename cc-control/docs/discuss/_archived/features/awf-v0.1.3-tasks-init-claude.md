# Init CLAUDE.md 任务清单

> 对应 Phase 5，依赖 Phase 1（工作流解耦）完成后执行。

## WBS 分解

```
W5 Init CLAUDE.md 自动生成（功能级 → 手动验证）
├── W5.1 注入内容源文件（任务级）
│   └── T5.1 创建 templates/awf-rules.md
├── W5.2 CLAUDE.md 备用模板（任务级）
│   └── T5.2 创建 templates/CLAUDE.md.template
├── W5.3 注入逻辑实现（功能级 → 手动验证）
│   ├── T5.3 实现 checkAndInjectClaudeMd() 函数
│   └── T5.4 处理 CLAUDE.md 不存在时的生成逻辑
└── W5.4 集成到 init 命令（任务级）
    └── T5.5 将注入逻辑接入 initCommand 流程 + 验证
```

## 任务清单

| # | 任务 | WBS | 依赖 | 复杂度 |
|---|------|-----|------|--------|
| T5.1 | 创建 `templates/awf-rules.md`，包含 awf 工作流核心规则（MCP 工具、命令前缀、状态文件路径、阶段约定） | W5.1 | - | simple |
| T5.2 | 创建 `templates/CLAUDE.md.template`，作为无 CLAUDE.md 时的备用生成模板（最小骨架 + 项目占位符） | W5.2 | - | simple |
| T5.3 | 在 `src/cli/commands/init.js` 中实现 `checkAndInjectClaudeMd(cwd)` 函数：检查 CLAUDE.md 是否存在、是否已有 `<!-- awf-rules -->` 标记、按需追加 | W5.3 | T5.1 | medium |
| T5.4 | 实现 `generateClaudeMd(cwd)` 函数：当项目无 CLAUDE.md 时，从 T5.2 模板生成基础文件，再注入 awf 规则（claude /init 非交互不可用，用模板兜底） | W5.3 | T5.2, T5.3 | medium |
| T5.5 | 将注入逻辑接入 `initCommand` 流程（`initWorkspace` 之后调用），在 sandbox 中验证 `awf init` 的 4 种场景 | W5.4 | T5.4 | medium |

## 场景覆盖

| 场景 | 预期行为 |
|------|---------|
| 项目无 CLAUDE.md | 从模板生成 → 追加 awf-rules |
| 项目有 CLAUDE.md，无 awf 标记 | 追加 awf-rules |
| 项目有 CLAUDE.md，已有 awf 标记 | 跳过 |
| `awf init --force` | 覆盖 .awf/ 但不覆盖已存在的 CLAUDE.md（仅追加缺失的 awf 标记） |

## T5.1 详细说明

`templates/awf-rules.md` 内容要点：
- awf 命令前缀约定（`/ai-workflow:`）
- MCP 工具列表（awf-state / awf-session / awf-oneshot）
- 状态文件路径（`.awf/state.json`）
- 阶段约定（DEV → REVIEW → TEST → COMMIT）
- 最小规则，其余由 skills 承载

## T5.2 详细说明

`templates/CLAUDE.md.template` 内容要点：
- 项目名称占位符
- 基础沟通原则
- 技术栈占位符
- 项目结构占位符
- 不包含 awf 规则（由注入逻辑追加）

## T5.3/T5.4 详细说明

实现两个函数并接入 `initCommand`：

```
initCommand 流程变更：
  原：checkPrerequisites → installAllPlugins → initWorkspace → (结束)
  新：checkPrerequisites → installAllPlugins → initWorkspace → initClaudeMd
```

`initClaudeMd(cwd)`：
1. 读 `templates/awf-rules.md`（包内路径，用 `paths.projectRoot` 拼接）
2. 检查 `cwd/CLAUDE.md`
3. 不存在 → 从 `templates/CLAUDE.md.template` 生成 → 追加 awf-rules
4. 存在但无标记 → 追加 awf-rules
5. 存在且有标记 → 跳过
