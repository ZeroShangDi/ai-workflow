---
name: awf-run-test
description: >
  当 tmux 的 cc 运行测试时对测试结果的处理方案。
  触发条件：awf run 阶段，TEST 阶段产出测试结果后。
  引用方：w-test
---

# 测试结果处理

测试是进入提交前的最后一道门，结果决定下一步去向。

## 结果分类

| 结果 | 定义 | 后续动作 |
|------|------|---------|
| 通过 | 全部用例通过、验收达标 | 进入 COMMIT |
| 部分通过 | 核心通过、边缘失败 | 评估失败是否阻塞；非阻塞则记录后放行 |
| 失败 | 关键路径失败 | 回 CODE/DEBUG 修复 |

## 失败时的重试策略

- 先区分"代码缺陷"还是"测试本身错"：断言错误 → 修测试；实现不符 → 修实现
- 修复后重跑，不靠改断言掩盖失败
- 反复失败 → 衔接 awf-run-reset

## 与 w-debug 的衔接

失败定位不清时走 w-debug 系统化排查，而非盲目改。

## 门禁 verdict 输出（CLI 闭环依据）

测试任务（kind=test）完成后必须输出结构化 `verdict`，CLI 据 `level !== 'pass'` 自动派生修复任务并回退复审：

| 结果 | verdict.level | RESULT status |
|------|--------------|---------------|
| 通过 | `pass` | `done` |
| 部分通过（阻塞项） | `changes_requested` | `failed` |
| 失败 | `fail` | `failed` |

RESULT 末尾一行示例：
```
RESULT: {"taskId": "<任务ID>", "status": "failed", "verdict": {"level": "fail", "conclusion": "关键路径用例不通过"}, "result": "测试 FAIL（详见报告）", "files": [".awf/reports/test/test-t2-012-2026-08-28.md"]}
```
报告路径必须写入 `files`（修复任务据此阅读）。非阻塞的部分通过可不触发闭环（仍按 done + pass 处理，或按需标 changes_requested）。

## 覆盖率不足的处理

- 覆盖不足是信号不是硬指标：验收标准涉及的行为必须覆盖
- 边缘用例不足时记录，不阻塞当前任务提交
