---
id: "008"
title: "两个真机 harness 的 case prompt 仍是旧形态，未跟随提示词约定（5ecfb55）"
status: open
labels: [tooling, eval, regression, legacy]
assignee: null
milestone: null
priority: medium
created: 2026-09-11
updated: 2026-09-11
deps: []
related: ["T3-011", "007"]
---

# 手写 prompt 未跟随提示词约定

**一句话**：`5ecfb55` 把任务提示词收敛成「命令 + task ID + 一句话目标」，范围/约束/验收一律走结构化字段；
但那次改造只落在 **planner**（`awf-plan-prompt` 技能）上，`tests/regression/` 与 `tests/eval/` 的 prompt 是
**手写的**，从来没跟着改 —— 于是新写用例照着老用例抄，旧形态继续传播，且没有任何环节会响。

## 一、约定是什么（`5ecfb55` + `awf-plan-prompt`）

```text
/ai-workflow-code:w-dev T1

<一句话要做什么>
```

- 正文通常 **≤200 中文字符**；只保留任务独有、会影响「做什么」的信息；
- 范围 / 约束 / 验收 / 依赖由 `awf-task-context` 按 task ID 从结构化字段统一读取，**不得复制进 prompt**；
- prompt 中禁止：XML 标签或固定空章节、`plannedFiles`/`constraints`/`acceptance`/`deps` 已表达的内容、
  通用探索/编码/测试/工具调用与**任务收尾流程**、"逐项核实""完成后自查"这类跨任务通用要求。

## 二、现状（2026-09-11 实测）

| 来源 | prompt 长度 | 带 task ID | XML 块 |
|---|---|---|---|
| `tests/eval/cases/review-gate-closure` | T1 **1363** / R1 374 字 | 否 | 是 |
| `tests/eval/cases/multi-task-deps` | T1 225 / T2 293 字 | 否 | 是 |
| `tests/regression` 其他 case（`taskSet()` 助手 + 各 case 手写） | 取自 `taskSet()` 的写法约 130 字，含「完成后用 awf_task_complete…」**通用收尾流程** | 是 | 否 |
| `tests/eval/cases/dynamic-planning`（2026-09-11 新增） | T1 791 / T2 265 / T3 487 字 | **否** | 是 |
| `tests/regression` 的 `dynamic-planning-run`（2026-09-11 新增） | **500** / 132 / 220 字 | 是 | 否 |

后两行是**本次新写用例的复发**：我照着 eval 里的老用例抄，一写就退回改造前的形态。
两个新 case 已于同日按约定改回（eval 侧 89/87/111 字、回归侧 94/59/111 字，均带 task ID、无 XML、
细节进 `constraints`）。

eval 侧尤其糟：prompt **连 task ID 都没有** → `awf-task-context` 取不到结构化字段，
等于绕开整套机制，只能在 prompt 里把 `files`/`constraints`/`acceptance` 再抄一遍。

## 三、待清理清单

1. `tests/eval/cases/` 4 个（`hello-sum` / `multi-task-deps` / `review-gate-closure` / `multi-agent-parallel`；
   `multi-agent-serial-baseline` 继承任务集，自动跟上）。
2. `tests/regression/fullflow-regression.mjs` 的**共用 `dev()` 助手** + 各 case 手写 prompt（15 个 case）。
   注意 blast radius：`dev()` 是共用件，且它那句「完成后用 awf_task_complete 把 X 记录为 done」正是被禁的
   **通用收尾流程**；去掉后要实跑确认 `w-dev` 自己会收尾（流程第 6 步写了会），因此**必须重跑全量**才能收口。

## 四、根因与处置

- 根因与 `007` 同族：**手写副本 + 没有能发现漂移的检查**。插件/约定改了，写死的副本不会自己变，也没人跑全量。
- 建议**并入 eval 清扫那一批一起做**（`007` 要改的就是同一批文件），一次改完、一次重跑全量。
- 防复发：给这类「必须与约定/注册表一致的手写资产」补可判定检查（例：prompt 首行必须匹配
  `^/<命名空间命令> <taskId>$`、长度上限、禁止 XML 标签），与 `007` 修法第 3 点同属一件事。

## 五、当前决议

- 2026-09-11：**只修新写的两个 case**（用户裁定，避免新代码继续传播旧形态），存量清扫留待后续；
- 本条只登记，不在本轮顺手扫。
