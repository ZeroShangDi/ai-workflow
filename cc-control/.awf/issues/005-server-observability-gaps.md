---
id: "005"
title: "复用 server 时缺 per-project 日志 + RunLogger 静默早退（真机门禁查出，产品侧）"
status: open
labels: [bug, observability]
assignee: null
milestone: null
priority: medium
created: 2026-09-11
updated: 2026-09-11
deps: []
related: ["T1-112", "T3-011", "T3-011-F1", "T1-113"]
---

# 复用 server 时缺 per-project 日志 + RunLogger 静默早退

T3-011 全量真机门禁（见 `.awf/reports/test/t3-011-full-real-gate.md` §三）在归因失败时查出的**两处产品侧观察**。
T3-011-F1 的修复边界是「不改产品代码，仅动测试侧」，故这里如实登记，供产品侧处置。

---

## 1. 复用 server 时，后挂的项目拿不到自己的 `server.log`

**现状**：`T1-112` 在 **spawn 那一刻**把 server 的 stdout/stderr 接到 `<boot 项目>/.awf/logs/server.log`
（`src/cli/run.js` 的 `ensureServer` 与 `src/cli/server.js` 的 `start` 都走 `openServerLog`）。
而 v0.2.0 的 server 是**常驻单实例多项目**：首个项目唤起它，此后所有项目复用。
于是 —— **只有首个项目**有 `server.log`，其余项目（即多数真实场景）在 `.awf/logs/` 下看不到 server 输出。

**影响**：T1-112 的目标是「证明宿主在等什么，不必再靠 transcript 反推」（2026-09-10 事故的核心痛点）。
复用场景下这个能力对**后挂项目**失效：排查 B 项目时，日志在 A 项目的目录里。

**实证**：T3-011 全量连跑中 `pause-release` 的两条 `server.log` 断言失败——它的日志实际落在首个 case（`single`）的项目下。
（测试侧已由 T3-011-F1 用「让本项目自起 server」规避，但**产品行为未变**。）

**可能的修法**（需设计裁决，非单方决定）：
- 把 server 输出的落点按**请求所属项目**分流（每项目一份 `server.log`）；或
- 保持单份日志，但把它的**绝对路径**经 `/status` 暴露出来，使任何项目都能定位（测试与人都能取到）；或
- 明确「server.log 属于 server 而非项目」并在 `.awf/logs/README` 与文档里写清归属。

## 2. `RunLogger._init()` 读不到 version 时静默早退

**现状**：`src/server/run-logger.cjs:28-31`

```js
_init() {
  const root = this._projectRoot;
  const version = this._readVersion();     // 读 <root>/.awf/state.json 的 version
  if (!version) return;                    // ← 直接 return，不打任何日志
  ...
}
```

**影响**：读不到 `state.json` 的 `version` 时，**这一轮的 per-run 日志目录根本不会创建**，
而**没有任何出口**说明这件事发生过。运维/测试只能从「目录不存在」反推（还不知道是谁没建）。
这与「把沉默变成会响的东西」（T1-112 / `.awf/issues/004` 的同一口径）直接冲突。

**实证**：T3-011 的两轮完整跑中，`decision` case **间歇**出现「per-run 日志目录未生成」
（`.awf/logs/` 下只有 `run-meta.json`），导致 `DecisionStore` 的 runStamp 派生回退到「当前时间」。
因为早退无声，这条间歇失败**只能从结果反推机制**。T3-011-F1 已在测试侧加了现场取证
（case 失败时把 `state.json` 可读性 / `logs` 目录清单 / 决策 stamps dump 进证据），
但**根因出口仍在产品侧**。

**修法（很小，建议先做）**：早退前打一行警告（进 server 日志即可），例如
`[run-logger] per-run 日志目录未创建：state.json 缺 version（project=/path）`。
行为不变，只把沉默变成会响。做完后 T3-011 那条间歇失败应当能直接定位。

---

## 建议归属

两处都是 **server 侧可观测性**，与 `T1-113`（A：server 分层 + 未落地补齐）同域，
建议并入该批次的 A 组清单；若需独立立项亦可（代价都很小：第 2 条 1 行日志，第 1 条需一次设计裁决）。
