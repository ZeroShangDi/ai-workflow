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

## 问题描述

AI 在需要用户决策时（列出选项、请求输入），没有可靠地调用 `awf_await_choice` / `awf_await_input` MCP tool。两次端到端测试中 AI 均直接呈现选项，跳过 tool 调用，导致 CLI 无法检测到决策需求。

server 端点、MCP tool、CLI 轮询代码均正确（单独测试通过）。

## 上下文

- **当前任务**: feature/cc-control-v0.1.3
- **相关文件**: awf-session MCP, server /choice /ask /respond, CLAUDE.md template
- **已尝试**: CLAUDE.md 写规则、裸 /send 测试，均未生效

## 方案 A（推荐）

在 state-machine.md 和 prompts/run/*.md 中嵌入强制规则：「完成后必须调用 MCP tool 等待 CLI 回应」。phase prompt 末尾加短约束。

**影响**：prompt 长度小幅增加
**风险**：长上下文中仍可能丢失

## 方案 B

利用「不调就走不下去」的机制自纠正：AI 不调 → CLI 不发回应 → AI 等不到 → 重试。不依赖记忆。

**影响**：AI 需要多一轮交互，效率略降
**风险**：死循环风险需要控制

## 状态

- [ ] 待决策
- [ ] 已选择方案 A
- [ ] 已选择方案 B
- [ ] 已执行

**决策时间**：
**执行结果**：

## 关联

- 任务: feature/cc-control-v0.1.3
- WBS:
- PR:
