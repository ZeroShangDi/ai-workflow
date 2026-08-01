---
id: 001
title: AI 决策检测调用可靠性 — tool 调用时机难以通过纯文本 prompt 强制
status: open
labels: [design, workflow]
assignee: null
milestone: v0.1.4
priority: high
created: 2026-08-02
updated: 2026-08-02
deps: []
related: [decision-detection, MCP, prompts]
---

## 描述

AI 在需要用户决策时（列出选项、请求输入），没有可靠地调用 `awf_await_choice` / `awf_await_input` MCP tool。两次端到端测试中 AI 均直接呈现选项，跳过 tool 调用，导致 CLI 无法检测到决策需求。

server 端点、MCP tool、CLI 轮询代码均正确（单独测试通过）。

## 背景

- 在 CLAUDE.md 模板中写了规则：呈现选项前必须先调 MCP tool
- 实测中 AI 没有遵守，裸 `/send` 单句指令不足以强制
- `awf run` 中通过 phase prompt 可能更有效，但尚未验证
- 如果依赖纯文本指令，长上下文中可能丢失；且不调 tool 时无自动检测机制

## 方案建议

- 在 phase prompt 末尾加硬性约束：「完成后必须调用 MCP tool 等待 CLI 回应」
- 考虑在 state-machine.md 和 prompts/run/*.md 中嵌入强制规则
- 长期考虑：利用「不调就走不下去」的机制自纠正，而非完全依赖记忆

## 关联

- 任务: feature/cc-control-v0.1.3
- 模块: awf-session MCP, server /choice + /ask + /respond, CLAUDE.md template
