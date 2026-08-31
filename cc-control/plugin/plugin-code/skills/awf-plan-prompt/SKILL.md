---
name: awf-plan-prompt
description: >
  生成任务执行提示词。触发条件：plan 阶段生成 tasks 时。提示词只包含命令、task ID 和具体目标；范围、约束、验收、依赖保留在任务结构化字段中。
---

# 任务提示词生成

任务 prompt 的唯一内容职责是说明：**这次具体要做什么。**

范围、约束、验收和依赖已经有结构化字段，由对应自定义命令通过 `awf-task-context` 统一处理，不得复制进 prompt。

## kind → 命令

| kind | 命令 |
|------|------|
| `dev` | `/ai-workflow-code:w-dev` |
| `debug` | `/ai-workflow-code:w-debug` |
| `review` | `/ai-workflow-code:w-review` |
| `test` | `/ai-workflow-code:w-test` |
| `doc` | `/ai-workflow-code:w-doc` |
| `commit` | `/ai-workflow-code:w-commit` |
| `ui-design` | `/ai-workflow-code:w-ui-design` |
| `ui-code` | `/ai-workflow-code:w-ui-code` |

## 固定格式

```text
/<命令> <taskId>

<具体要做什么>
```

示例：

```text
/ai-workflow-code:w-dev T2-001

实现登录表单的邮箱密码登录与错误提示。
```

## 正文规则

- 用一句或少量几句直接描述目标结果，通常不超过 200 个中文字符。
- 只保留任务独有、会影响“做什么”的信息。
- 多个不可分割的子目标可用简短列表；不要扩写实施步骤。
- `title` 用于列表扫描，`prompt` 应比 title 更具体，但不重复任务元数据。

prompt 中禁止出现：

- `plannedFiles` 已表达的文件范围
- `constraints` 已表达的硬约束
- `acceptance` 已表达的完成条件或自查清单
- `deps`、前序任务结果或计划时猜测的上下文
- 通用探索、编码、测试、工具调用和任务收尾流程
- “逐项核实”“不要照抄”“完成后自查”等跨任务通用要求
- hooks 数量、工具数量等会随源码变化的事实快照
- XML 标签或固定空章节

若一句话无法精确表达目标，应优先完善任务拆分或结构化字段，而不是把 prompt 扩写成需求文档。
