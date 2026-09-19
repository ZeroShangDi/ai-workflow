---
name: awf-run-decision
description: >
  【已停用 2026-09-10】旧决策入口（awf_await_choice / awf_await_input）的处理方案，仅作历史留存。
  awf run 阶段需要决策时改用决策门阀：把问题作为回合最后一段以 <AWF_DECISION_REQUIRED> 包裹输出，
  由决策技能（decision-core）自决产出 Decision Result。见任务 T1-106。
  引用方：（已无）
---

# 运行时决策处理（已停用）

> **2026-09-10 停用**：本技能描述的 `awf_await_choice` / `awf_await_input` 入口不再使用。
> 需要决策时改用决策门阀的决策标记（`<AWF_DECISION_REQUIRED>…</AWF_DECISION_REQUIRED>`），
> 由决策技能自决。本文以下内容仅作历史留存，勿据此执行。

自治执行中遇到需要用户拍板的情况，不能停下来列选项干等——先通过 MCP tool 通知 CLI，由 CLI 收集用户回应。

## 核心规则

- 需要用户决策时，**禁止直接列出选项等待回复**，必须先调 MCP tool 通知 CLI
- 调用后按原方式呈现选项即可，CLI 自动检测并收集用户回应

## 选择题 → awf_await_choice

用户在有限选项中选择时：

```
awf_await_choice({ question, options[], context? })
```

- `question`：需要选择的问题
- `options`：可选项列表（互斥、穷尽）
- `context`：可选，补充背景（任务 ID、相关代码）

## 自由输入 → awf_await_input

需要用户提供自由文本（补充需求、描述细节）时：

```
awf_await_input({ question, context? })
```

## 超时处理

- 调 tool 后 CLI 展示问题并等待用户；用户长时间未响应由 CLI 侧兜底，AI 不自行等待
- 不要对同一决策重复调用 tool

## 记录

- 决策结论通过 awf_task_result 写入 task.exec.result，供后续 session 参考

## 自主决策边界

能自行决策的不打断自治流程。免问 vs 必暂停的边界见 `references/decision-permissions.md`。
