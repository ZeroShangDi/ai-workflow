---
name: awf-run-error
description: >
  当 tmux 的 cc 运行异常时的处理方案。
  触发条件：awf run 阶段，Session Server 检测到异常状态时。
  引用方：w-monitor
---

# 运行时异常处理

## TODO

- 异常类型分类（超时、报错、卡死、偏离方向）
- 各种异常的识别方式
- 对应的恢复策略
- 何时自动恢复 vs 何时需要人工介入
