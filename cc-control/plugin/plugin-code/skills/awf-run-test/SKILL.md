---
name: awf-run-test
description: >
  当 tmux 的 cc 运行测试时对测试结果的处理方案。
  触发条件：awf run 阶段，TEST 阶段产出测试结果后。
  引用方：awf-sys-spec-workflow
---

# 测试结果处理

## TODO

- 测试结果的分类（通过/部分通过/失败）
- 失败时的重试策略
- 与 w-debug 的衔接
- 测试覆盖率不足时的处理
