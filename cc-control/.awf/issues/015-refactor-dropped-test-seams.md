---
id: "015"
title: "新 server 漏搬测试注入缝：global.__CC_TMUX__ / __CC_RUNLOGGER__ / __CC_RUN_DIAGNOSIS__"
status: fixed-partial
labels: [testability, server, regression-from-refactor]
assignee: null
milestone: null
priority: medium
created: 2026-09-13
updated: 2026-09-13
deps: []
related: ["014", "T1-113"]
---

# 新 server 漏搬测试注入缝

**一句话**：旧 `src/server/server.cjs:11,13,17,39` 有三条测试注入缝（`global.__CC_TMUX__` /
`__CC_RUNLOGGER__` / `__CC_RUN_DIAGNOSIS__`），新树 `server/server.cjs` **一条都没搬** —— 于是靠它
拦 tmux 的 4 个集成用例全部退化成了**真调 tmux**（`Command failed: tmux send-keys …`）。

## 一、现场（2026-09-13 收口）

`tests/integration/{server,run.e2e,single-executor-decision,batch-host}.test.js` 都写了
`global.__CC_TMUX__ = mockTmux`，注释还写着「必须在 import server.cjs 之前注入」。旧树下有效；
指向新树后 `grep -rn __CC_TMUX__ server/` **零命中** —— 全域落到真实 `tmux send-keys`，
断言全红（且真机 tmux 上留了会话）。

## 二、根因

不是「新树改用别的机制」，而是**漏搬**：

- 运行时侧的注入通道**一路都在**：`createProjectRegistry({ tmuxFactory, RunLogger })` →
  `createProjectRuntime({ tmuxFactory, RunLogger })` → `createProjectContext({ tmuxFactory, RunLogger })`
  都收这两个参数；`createMonitor({ oneshot })` 也收诊断端口。
- 唯独**入口** `server/server.cjs` 既没读全局、也没往下传 —— 通道建好了没接线。

## 三、处置

| 缝 | 处置 |
|---|---|
| `global.__CC_TMUX__` | **已恢复**：入口读全局，有值则传 `tmuxFactory: () => injected`，无值传 `undefined`（回落真实 host 端口，生产行为不变） |
| `global.__CC_RUNLOGGER__` | **已恢复**：同上，取 `.RunLogger`；无值回落真实实现 |
| `global.__CC_ONESHOT__` | **已恢复**：入口读全局，经 `createApi({ oneshot })` → `deps` → `web/api/run.cjs` 的 `/oneshot` 用注入端口（缺省真实 adapter）。`deps` 通道本就为入口注入而留（`api/index.cjs:45` 注释「deps 由入口注入」）。 |
| `global.__CC_RUN_DIAGNOSIS__` | **不恢复**（形状已变）：新树诊断走 `features/monitor` 的 **`oneshot` 端口**（`createMonitor({ oneshot })`），不再注入整个 diagnosis 库。相关断言应改为直接测 `createMonitor({ oneshot: 替身 })`，或由 `tests/unit/server-monitor.test.js` 覆盖 |

恢复后：`server.test.js` 17 红 → 3 红，`run.e2e.test.js` 7 红 → 3 红，`batch-host.test.js`、
`single-executor-decision.test.js`、`mcp-fullchain.test.js` 直接转绿。

**判据**：入口只在「全局有值」时改变注入，生产环境全局不存在 ⇒ 行为与零注入完全一致；
`server/runtime/project.cjs` 的 `tmuxFactory` 缺省分支不动。

## 四、教训（可复用的判据）

1. **重构搬入口时，要把「入口读什么全局/环境」当成清单逐条核对** —— 运行时通道齐了不等于接线齐了
   （同 `.awf/issues/014`：能力齐了不等于可测）。
2. 测试注入缝是**能力**，不是测试的私事：删了它，覆盖就静默消失。收口时应当与「生产引用」一起清点。
