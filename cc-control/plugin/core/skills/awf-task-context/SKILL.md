---
name: awf-task-context
description: >
  AWF 任务结构化字段消费协议。执行类自定义命令收到 task ID 时使用，统一处理 prompt、plannedFiles、constraints、acceptance 和 deps；非 AWF 交互式调用不触发。
---

# AWF 任务上下文

执行类命令的参数若包含 task ID，调用 `awf_read_state(taskId)` 读取一次任务。读取不到时按普通交互式命令处理，不阻塞用户输入。

## 字段职责

| 字段 | 执行含义 |
|------|----------|
| `prompt` | 唯一任务目标：具体要做什么 |
| `plannedFiles` | 规划影响范围和探索入口，不是禁止访问其他文件的白名单 |
| `constraints` | 本任务硬约束，必须全部满足 |
| `acceptance` | 完成判定；执行结束前逐项验证 |
| `deps` | 调度依赖；仅在当前任务确需前序产出时按需读取，不默认展开全部依赖 |
| `kind` | 任务类型；应与当前自定义命令匹配 |

## 处理规则

1. 直接执行 `prompt`，不要复述或扩写成新需求。
2. 以 `plannedFiles` 确定主要改动范围；确需改动范围外文件时，必须由目标或约束直接导出，并在结果中说明。
3. `constraints` 是硬边界；与目标或验收冲突时停止并标记 blocked，不自行忽略。
4. 以 `acceptance` 做最终验证；未满足不得标记 done。
5. 通用流程、工具选择、质量规则和收尾由当前自定义命令负责，不写回 task prompt。

不要在输出中重复打印整份任务对象，只报告执行结果、实际文件和验证结论。
