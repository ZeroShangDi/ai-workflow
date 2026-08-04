---
id: 001
title: 集成测试未实现：4 个模块（server/tmux/oneshot/bootstrap）+ 2 个模块 integration 部分
version: 0.1.3
status: open
labels: [test-infra]
assignee: null
milestone: M1
priority: high
created: 2026-08-04
updated: 2026-08-04
deps: []
related: []
---

## 问题描述

tests/.awf/state.json 中 6 个任务被 blocked，原因是它们需要真实运行环境（HTTP server、tmux session、claude -p 子进程），而当前测试沙箱只能稳定运行单元测试：

| 任务 | 模块 | 缺失文件 |
|------|------|---------|
| T22 | server（HTTP 路由 + dashboard） | tests/integration/server.test.js |
| T23 | tmux-session（tmux.cjs + awf-session MCP） | tests/unit/tmux.test.js, tests/integration/awf-session.test.js |
| T26 | oneshot（awf-oneshot MCP） | tests/integration/awf-oneshot.test.js |
| T27 | bootstrap（scripts/bootstrap.sh） | tests/integration/bootstrap.test.js |
| T19 | state MCP 侧（awf-state JSON-RPC） | tests/integration/awf-state.test.js |
| T21 | auto-decision（server decision 链路） | tests/integration/decision.test.js |

## 上下文

- **当前任务**: T22/T23/T26/T27（blocked），T19/T21（unit 部分完成、integration 部分未实现）
- **相关文件**: docs/features/server.test.md, tmux-session.test.md, oneshot.test.md, bootstrap.test.md, state.test.md, auto-decision.test.md
- **已尝试**: 单元测试 116 tests 全部通过（10 个文件），集成测试因环境依赖未启动

## 方案 A（推荐）

将集成测试列入下一里程碑（v0.1.4），采用真实环境跑批（tmux + claude -p + 8787 server），
smoke.sh 已有雏形可复用。当前里程碑 M1 只收单元测试。

**影响**：T28-T30 的依赖从 blocked 任务中剔除，awf run 可推进到收尾
**风险**：集成测试延迟，覆盖率缺 6 个模块

## 方案 B

本轮补写 4 个集成测试（需 mock tmux/HTTP/claude 子进程，工作量大）。

**影响**：一次性补齐，但每个模块需额外 mock 基础设施
**风险**：测试易 flaky，开发周期拉长

## 状态

- [x] 待决策
- [x] 已选择方案 A
- [ ] 已选择方案 B
- [ ] 已选择用户方案
- [x] 已执行

**决策时间**：2026-08-04
**执行结果**：已按方案 A 调整 T28 deps（剔除 6 个 blocked 任务），awf run 可推进 T28→T29→T30；集成测试列入下一里程碑。

## 关联

- 任务: T19, T21, T22, T23, T26, T27
- WBS: W4, W5
- PR:
