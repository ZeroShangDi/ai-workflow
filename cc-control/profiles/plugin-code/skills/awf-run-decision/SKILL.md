---
name: awf-run-decision
description: >
  当 tmux 的 cc 出现需要决策时的处理方案。
  触发条件：awf run 阶段，AI 调用 awf_await_choice 或 awf_await_input 时。
  引用方：awf-sys-spec-workflow
---

# 运行时决策处理

## TODO

- 选择题的处理流程（选项呈现 → 用户选择 → 继续执行）
- 自由输入的处理流程（问题呈现 → 用户输入 → 注入上下文）
- 决策超时处理（用户长时间未响应）
- 决策记录的保存（后续 session 可参考）
