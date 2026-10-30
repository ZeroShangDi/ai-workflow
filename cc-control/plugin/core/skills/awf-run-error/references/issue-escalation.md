# Issue 升级格式（待合并）

> 来源：`plugin_old/skills/awf-sys-spec-workflow/SKILL.md` — Issue Escalation 段
> 待合并目标：`awf-run-error/SKILL.md`（运行异常处理）
> 状态：待用户审查，合并后删除本文件

## 触发时机

当任务需要人工介入时（技术阻塞、需外部决策、需求歧义无法自行裁决）。

## Issue 文件结构

AI 在 `.claude/issues/ISSUE-<N>-<short-desc>.md` 创建 Issue，包含 5 段：

1. **问题描述** — 症状、触发条件、影响
2. **当前上下文** — 阶段、任务、相关文件、已尝试的步骤
3. **方案 A（推荐）** — 描述 + 影响 + 风险
4. **方案 B** — 描述 + 影响 + 风险
5. **用户方案槽** — 留空，供用户填写

## 轮询规则

AI 在每次状态转换时扫描 `.claude/issues/`：
- 检查「已决策但未执行」的 Issue
- 汇总待处理 Issue
