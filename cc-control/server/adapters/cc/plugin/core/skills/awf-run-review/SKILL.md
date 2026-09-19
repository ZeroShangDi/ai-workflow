---
name: awf-run-review
description: >
  当 tmux 的 cc 运行审查时对审查结果的处理方案。
  触发条件：awf run 阶段，REVIEW 阶段产出审查结果后。
  引用方：w-review
---

# 审查结果处理

审查结果不是"通过/不通过"两态，按严重等级分流。

## 严重等级分类

| 等级 | 定义 | 后续动作 |
|------|------|---------|
| 通过 | 无问题或仅建议级 | 进入 TEST |
| 修改后重审 | 有需修复的问题，方向正确 | 修复 → 重审 |
| 打回重做 | 方向性错误、设计缺陷 | 回 CODE/DEBUG |

## 各类结果的动作

- **通过** → 进入 TEST，不阻塞
- **修改后重审** → 记录问题 → 修复 → 重新进入 REVIEW
- **打回重做** → 回 CODE 重做该任务；设计缺陷则回 PLAN

## 与 awf-run-reset 的关联

同一任务多次打回、每次修改都引入新问题时，停止修补，改走 awf-run-reset 回撤重开。

## 门禁 verdict 输出（CLI 闭环依据）

审查任务（kind=review）完成后必须输出结构化 `verdict`，CLI 据 `level !== 'pass'` 自动派生修复任务并回退复审：

| 等级 | verdict.level | RESULT status |
|------|--------------|---------------|
| 通过 | `pass` | `done` |
| 修改后重审 | `changes_requested` | `failed` |
| 打回重做 | `fail` | `failed` |

RESULT 末尾一行示例：
```
RESULT: {"taskId": "<任务ID>", "status": "failed", "verdict": {"level": "changes_requested", "conclusion": "工具数过时 + 2 处失效路径引用"}, "result": "审查 FAIL：F1/F2/F3（详见报告）", "files": [".awf/reports/review/review-t2-011-2026-08-28.md"]}
```
报告路径必须写入 `files`（修复任务据此阅读）。

## 记录与追踪

- 审查结论写 task.exec.result（问题 + 严重程度 + 结论）+ exec.verdict（结构化判定）
- 需人工决策的关键问题建 Issue 升级，见 `references/issue-escalation.md`
