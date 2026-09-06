# canCommit 提交门禁职责边界（待合并）

> 来源：`plugin_old/skills/awf-sys-spec-workflow/SKILL.md` — Commit Gate 段
> 待合并目标：`code-commit-gitflow/SKILL.md`（提交流程）或 `awf-run-test/SKILL.md`
> 状态：待用户审查，合并后删除本文件
>
> 说明：原文状态文件路径 `.claude/awf-state.json` 在新版已改为 `.awf/state.json`，且新版由 awf-state MCP tools 读写。合并前需确认 `canCommit` 字段是否已在新版 state.json 数据模型 / MCP tools 中建模；若未建模，此门禁需配套补一个字段或 MCP tool。

## 核心原则

`w-commit` **不拥有**「代码是否可提交」的决策权，它只读一个布尔值 `canCommit`（存于 state.json）。

## 职责边界

| 角色 | 职责 |
|------|------|
| **w-dev / w-review / w-test** | 验证质量，据此设置 `canCommit` |
| **w-commit** | 只检查 `canCommit` — `true` 则继续，`false` 则拒绝 |
| **其他命令** | 可设 `canCommit = false` 阻止提交（如 w-debug） |

## 何时设置

- **设为 `true`**：w-test 全部通过 → 进入 COMMIT 阶段前
- **设为 `false`**：状态初始化时；每次成功提交后（复位）；任何命令检测到需阻止提交的理由时

## 无 state.json 时

`w-commit` 询问用户：「未检测到工作流状态，是否继续提交？」由用户选择。这支持不使用 `/awf-run` 的工作流。

## 提交完成钩子

成功提交后，`w-commit` 将 state 中的 `canCommit` 置回 `false`，下一个任务必须重新赢得该标志。
