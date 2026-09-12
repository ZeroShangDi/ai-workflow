---
id: "012"
title: "doc 门禁判负不派生修复任务，run 静默收尾"
status: open
labels: [bug, runtime, gate, real-run]
assignee: null
milestone: null
priority: high
created: 2026-09-12
updated: 2026-09-12
deps: []
related: ["T4-001", "T3-011", "010"]
---

# doc 门禁判负不派生修复任务，run 静默收尾

**一句话**：`kind=doc` 的门禁判 `changes_requested` 后，门禁闭环不接管 —— 没有派生修复任务，
run 直接以 `done` 收尾，看起来像"跑完了、没别的事"，实际是**最终文档门禁判负后没有人接**。

## 一、现场（2026-09-12 本轮 run）

```
T3-011 ✔ done → T1-120 ✔ done → T4-001 ⚠ blocked（changes_requested）
run default done：153/156 done，1 blocked     ← 没有任何「已派生修复任务」的行
mode → idle
```

对照同一个 run 里 `kind=test` 的门禁：`T3-010` 判非 pass 时日志明确打出
`✔ 门禁 T3-010 非 pass → 已派生修复任务`，随后跑 `T3-010-F2` / `F3` 两轮才通过。

## 二、机制

`src/lib/state.js:337 gateFixMeta()`：

```js
if (gateTask.kind !== 'review' && gateTask.kind !== 'test') return null;   // ← doc 门禁在此被排除
```

`runGateHook` 只在拿到 meta 时派生修复任务，于是 doc 门禁判负 = 无人接管。

## 三、影响

1. **收尾链断在这里**：T4-001 是链尾（`T1-106` / `T1-113` 都 deps 它），它 blocked ⇒ 下游全不可就绪
   ⇒ 宿主无任务可派 ⇒ 正常收尾。整条链的"最后一公里"停在一个人工动作上，而 run 的输出是 `done`。
2. **两个信号互相掩盖**：同一时刻 `npm test` 是**红的** ——
   `tests/unit/check-architecture.test.js` 的「豁免表责任任务可达性」读**真实 `.awf/state.json`**，
   `T4-001` blocked 即判「登记的责任任务不可达」。run 说 done、单测说红，任一方单独看都会得出错误结论。
3. 本轮 T4-001 的 findings 是实打实的 8 条（D-1..D-8：Issue 编号冲突 / `.awf/README.md` 落后于
   `awf init` 分发的模板 / CHANGELOG 三处数字过期 / [Unreleased] 缺用户可见面变更 / 两处状态 banner
   自述「已校对」而内容已错 …），详见 `.awf/reports/test/t4-001-doc-completeness-gate.md`。

## 四、待裁决（未定）

- **doc 门禁要不要纳入门禁闭环**（派生 `T4-001-F1` 并回退复审）？
  纳入的好处是链路自洽；不纳入的理由是"项目文档完整性"最终该由人裁决。
- 若决定不纳入，则 run 收尾时必须**显式声明**「有 blocked 门禁待人工处置」，而不是静默 `done`
  —— 至少让 CLI 输出与证据 JSON 里带一条「N 项 blocked 待人工」。
- 顺带确认：`check-architecture` 的责任可达性测试读真实 state 是有意为之（T3-009-F2 的机器出口），
  但它意味着**任何门禁 blocked 都会让单测变红**。这条耦合要不要在 run 收尾时一并提示，同样待裁决。

## 五、当前决议

- 只登记，不在本轮修；本轮已把 T4-001 的报告与修复要求归档，等人工（或下一轮任务）处置。
