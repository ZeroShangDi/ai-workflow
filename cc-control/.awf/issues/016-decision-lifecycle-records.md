---
id: "016"
title: "决策生命周期记录：answered 被 requested 静默挡掉 + 挂起时无 WS 推送"
status: fixed
labels: [bug, decision, server, observability]
assignee: null
milestone: null
priority: high
created: 2026-09-14
updated: 2026-09-14
deps: []
related: ["014", "015", "007"]
---

# 决策生命周期记录的两个缺陷

**一句话**：旧树退役收口时发现新树决策记录**半失能** —— ① `decision_answered` 永远落不了盘
（被同 decision_id 的 `decision_requested` 挡掉），② 决策**挂起**时不再推 WS 事件，前端失去刷新依据。

## 一、缺陷①：`decision_answered` 静默丢失

`handler.cjs` 的两个生命周期写入用的是 `DecisionStore.append`，而 `append` 是**按 `decision_id`
跨事件**去重的（`store.cjs` `_hasDecision`）：

```
append(decision_requested, D-1) → appended: true
append(decision_answered,  D-1) → appended: false   ← 静默丢弃
```

于是「谁答的、答了什么」永远查不到 —— 而这正是这轮新增 `decision_requested/answered` 的全部目的。
`appendEvent` 才是为生命周期事件准备的（自述：「同一 decision_id 可以依次拥有 requested/completed，
但同一 event 只写一次」），`features/replanning/*` 一直用的是它。

**为什么单测没拦住**：`tests/unit/decision-routing.test.js` 的 store 替身 `append` 恒返回
`{appended:true}`，把真 store 的去重语义完全抹平了（报告里点名的「假 store 掩盖真 store」）。

**修复**：`recordAsked` / `recordAnswered` 改用 `appendEvent`；并把替身改成**扫已落记录**、
与真 store 同口径（`append` 比 decision_id、`appendEvent` 比 (decision_id, event)），
补一条**判别性用例**（先问后答 → 两条都要在）。

**元验证**（复盘 Experiment#1「给每个验证手段配负面用例」）：把产线改回 `append` → 用例转红；
改为 `appendEvent` → 转绿。替身第一次改完仍不判别（两种键混装在一个 Set 里永不碰撞），
改成扫已落记录后才真正判别 —— 这条过程本身说明「替身像不像真的」必须被验证。

## 二、缺陷②：决策挂起无 WS 推送

旧树 `/choice` / `/ask` 置 `decisionPending` 后会推 `decision.required`（前端订阅刷新依据）。
新树只在决策**完成**时推 `decision.record`，**挂起**信号断了。已恢复：`/choice`、`/ask`
两个端点 + 决策捕获路径（`handler.onAskUserQuestion`，即 PreToolUse deny 那条）都推
`decision.required`（名字沿用旧树，前端契约不变）。

## 三、影响面

- 修复前：`/awf/decisions` 与前端决策页只能看到「问过」，看不到「谁答的」；
  挂起时前端不会自动刷新。
- 修复后：`requested → answered` 两条都在，`answered_by` 区分 human/auto/ai；挂起即推。
