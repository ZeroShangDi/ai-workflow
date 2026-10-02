---
description: plan 门禁检查：校验产出 state.json 是否符合标准
argument-hint: <state.json 路径或留空>
hint: <state.json 路径或留空>
---
# w-plan-check 提示词

由 CLI 在 plan 阶段门禁检查步骤调用 `claude -p` 时使用。

## 调用时机

plan 流程最后一步：任务列表已生成，检查产出 state.json 是否符合标准。

## 输入

- `.awf/state.json`（plan 阶段的完整产出）

## 检查项

1. WBS 完整性 — 每个需求都有对应的 WBS 节点
2. 任务粒度 — 是否能独立理解、实施和验证；文件数仅作为调查信号，不作硬阈值
3. 依赖完整性 — 无循环依赖、无断链
4. 验收标准 — 每个任务有可验证的完成条件
5. 门禁任务 — 关键节点已插入门禁
6. 结构化字段 — 每个任务都有 `plannedFiles`、`constraints`、`acceptance`、`deps`；允许为空数组，但字段不可缺失
7. 提示词格式 — 第一行必须是与 `kind` 对应的命令及当前任务 ID，空一行后只写本任务具体要做什么
8. 提示词纯度 — 不得包含 XML 标签、通用执行流程，或重复 `plannedFiles`、`constraints`、`acceptance`、`deps` 的内容
9. 提示词纯度 — 只表达任务目标；过长时检查是否混入范围、约束、验收或通用流程，不以字符数机械判定
10. 文档定级 — 独立文档产出必须是 `T1` + `kind=doc`；每个 `W4` 项目节点必须且只能有一个对应的 `T4` 项目文档门禁，禁止多个 T4 指向同一 `wbsRef`
11. 文档并行信息 — 独立文档产出必须填写各自的 `plannedFiles`；不同任务不得笼统声明同一文档目录

`kind` 与命令的对应关系：

- `dev` → `/ai-workflow-code:w-dev`
- `debug` → `/ai-workflow-code:w-debug`
- `review` → `/ai-workflow-code:w-review`
- `test` → `/ai-workflow-code:w-test`
- `doc` → `/ai-workflow-code:w-doc`
- `commit` → `/ai-workflow-code:w-commit`
- `ui-design` → `/ai-workflow-code:w-ui-design`
- `ui-code` → `/ai-workflow-code:w-ui-code`

## 输出

- 通过 / 不通过
- 不通过时列出具体问题和修复建议
