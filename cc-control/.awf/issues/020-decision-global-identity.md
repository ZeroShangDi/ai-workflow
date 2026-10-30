---
id: "020"
title: "决策记录的全局身份：project_id / plan_id / decision_id 跨机器"
status: open
labels: [decision, storage, architecture, discussion]
assignee: null
milestone: null
priority: medium
created: 2026-09-30
updated: 2026-09-30
deps: []
related: ["019", "016"]
---

# 决策记录的全局身份

**一句话**：决策记录现在的身份全是「本机 + 本次运行」级的 —— 项目靠绝对路径、运行靠本机时间戳、
决策号靠本机毫秒。文件存储时无所谓（记录就躺在那个项目的 `.awf/` 下），**一旦要多项目合并入库，
这三样都不足以把数据分开**。

**已定（用户 2026-09-30）**：数据库**自己生成主键**（自增或 UUID），我们不管；其余 id 一律降级成
「用来捞数据的索引列」。所以本 issue 不涉及主键设计 —— 它要解决的是**索引列的准确性**：
撞车不会破坏行唯一性，但会让「按项目 / 按计划 / 按决策号捞」捞错或捞漏。

## 三件事（都是入库前必须定案）

### 1. `project_id` —— 与路径无关的项目身份

现在唯一的项目级 id 是 `server/shared/run-context.cjs:150` 的：

```js
projectSid(projectRoot) = 'p' + sha1(绝对路径).slice(0, 12)
```

它自己的注释写着「**仅供命名/路由标签用：不落盘**」—— 因为绑路径，换机器或换 checkout 目录就变。

**方向**：`awf init` 时生成一个 UUID 写进 `.awf/`（`.awf/` 本来就有入库文件，随仓库走）。
备选是从 git remote 派生，但本地无 remote 的仓库没有身份、fork/改 remote 会变，不如前者稳。

**同时明确**：`project_root`（绝对路径）只作展示/排查用，**不做检索键**。

### 2. `plan_id` —— 计划级归因

一次 plan 出来的任务列表**可能经历多次 run**（中断、失败、续跑），所以「这份计划下的所有决策」
不能靠 run 来归堆。

**现状**：根本没有 plan 身份 —— `.awf/plan/` 只有 `tasks.md` / `wbs/` / `discussion/`，
`state.plan` 只有 `summary / reqDoc / hasUI / inScope / outOfScope / acceptanceCriteria`，
全仓搜不到 `planId`。

**要定三件事**：什么时候生成、存在哪、与 `state.version` 什么关系。

### 3. `decision_id` 加不依赖本机的成分

现在 `decision_id = D-<本机毫秒 base36>-<本会话序号>`（`gate.cjs:createDecisionSeq`）。
同一个项目在两台机器上各跑一次，理论上会产出同一个 id。

**注意 `runStamp` 同性质**：`<版本>-<本机时间戳>`。它是归因字段不是主键，撞了不致命
（顶多两行看起来像同一次运行），但要严格也得带机器成分。

## 与已有字段的关系（当前实现层已定，别再改）

| 字段 | 性质 | 进检索键？ |
|---|---|---|
| `decision_id` | 决策身份 | 是（与 `project_id` 组合） |
| `runStamp` | **运行归因**（哪一次运行的产物） | 否 |
| `plan_id` | **计划归因** | 否（可筛） |
| `task_id` | **任务归因**（可空：多 agent 下主会话的决策不属任何单任务） | 否（可筛） |
| `project_root` | 展示/排查 | **否** |

`runStamp` 与 `plan_id` 是**两个不同的问题**（哪次运行 / 哪份计划），不是同一字段的两代 ——
所以将来加 `plan_id` 是**新增**，老记录的 `runStamp` 不作废。

## 落点

与「存储分层」（issue 019）一起做，在**入库前**定案 —— 否则要改一次检索键、迁一次数据。
