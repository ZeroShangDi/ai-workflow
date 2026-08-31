# w-plan-check 提示词

由 CLI 在 plan 阶段门禁检查步骤调用 `claude -p` 时使用。

## 调用时机

plan 流程最后一步：任务列表已生成，检查产出 state.json 是否符合标准。

## 输入

- `.awf/state.json`（plan 阶段的完整产出）

## 检查项

1. WBS 完整性 — 每个需求都有对应的 WBS 节点
2. 任务粒度 — 是否在合理范围（1-5 文件）
3. 依赖完整性 — 无循环依赖、无断链
4. 验收标准 — 每个任务有可验证的完成条件
5. 门禁任务 — 关键节点已插入门禁
6. 结构化字段 — 每个任务都有 `plannedFiles`、`constraints`、`acceptance`、`deps`；允许为空数组，但字段不可缺失
7. 提示词格式 — 第一行必须是与 `kind` 对应的命令及当前任务 ID，空一行后只写本任务具体要做什么
8. 提示词纯度 — 不得包含 XML 标签、通用执行流程，或重复 `plannedFiles`、`constraints`、`acceptance`、`deps` 的内容
9. 提示词长度 — 正文原则上不超过 200 个中文字符；超出时应拆分任务或将范围、约束、验收信息移回对应字段

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
