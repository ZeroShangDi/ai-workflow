---
id: "002"
title: "重构跑偏机制：抽象建了没接线，因为「接线」不是任务"
status: open
labels: [bug, discussion]
assignee: null
milestone: null
priority: high
created: 2026-09-11
updated: 2026-09-11
deps: []
related: ["W3-003", "W3-005", "T1-027", "T1-062", "T1-105", "T3-009", "T3-009-F1"]
---

# 重构跑偏机制：抽象建了没接线，因为「接线」不是任务

**一句话**：v0.2.0 重构里，「建抽象」和「接上 live 路径」被写在同一条任务里，而验收只判「建」。
于是 16 个任务报 done、单测全绿，live 路径一行没变；最后清理任务把骨架当死代码删了。
你在 plan 里反复确认过的目录结构，没有任何任务对**最终形态**负责。

**触发**：用户 2026-09-11 看目录仍乱 → 排查。

---

## 一、对照实验（同一份计划，三支，唯一区别是有没有接线任务）

| 轴 | 建抽象 | 接线任务 | 结果 |
|---|---|---|---|
| 编排（run 域） | T1-035/036/037 | **T1-105「server run-host **接线**：编排 live 迁入 + run 提交/事件端点」** | ✅ 落地 —— `run-host.cjs` 507 行，`server.cjs:661` require，在生产跑 |
| cli / store 薄化 | T1-056…060 | **T1-061「cli 调度写 → server run api」/ T1-062「写侧**下线**」/ T1-065「**删除**」** | ✅ 落地 —— cli 零直写 state，store 在跑 |
| **server 分层（app/api/events/config/host）** | T1-026/027/028/029 —— 标题**全是「骨架」** | **无** | ❌ 骨架删除，`server.cjs` 仍 **1502 行**单体 |

`W3-003` 的计划原文是「server.cjs **拆为** bootstrap/api/events/config/host」——
**目标从来没被推翻，是没人对「拆完了没」负责。**

---

## 二、关键证据：T1-027 把接线推给了一个不存在的任务

T1-027 的 `exec.result` 原文：

> 真实挂接（把 `server.cjs` 内闭包 handler 迁入并 `registerRoutes`）**由 W3-003 server 分层任务执行**；
> 迁移完成后 legacy 别名可退役。

而全图里 `wbsRef=W3-003` 的任务**只有两个**：

| 任务 | 范围 |
|---|---|
| `T1-105` | 「**编排** live 迁入 + run 提交/事件端点」—— 只覆盖编排那一轴 |
| `T1-112` | server 运行日志落盘（2026-09-11 新增） |

**T1-027 指向的"那个任务"根本不存在。** 而且它自己就在 W3-003 这个模块里 ——
「由本模块的任务接线」= 绕回自己 = 无人承接。

---

## 三、真正的差别在验收措辞

| 写法 | 例 | 可判定的只有 | 结果 |
|---|---|---|---|
| 「**建成**」 | T1-027：「api 骨架**建成**…测试 7 例全绿」 | 文件存在 + 单测绿 | 接线留给"后续" |
| 「**下线 / 零引用**」 | T1-062：「lib/state.js 写侧**下线**……**grep 确认** src/cli 下零 import」 | **引用关系变了** | 真的接上了 |

**「建成」型验收，接线永远推得出去；「下线/零引用」型验收，接不上就交不了差。**

**旁证（讽刺）**：T1-027 建 `api.cjs` 时特意实现了接线自检
`assertHandlersComplete(handlerMap,{allow})`，注释写着「**接线期缺漏即抛错**」。
机制都写好了 —— **但那个"接线期"从没到来过，所以它一次也没被调用过。**

---

## 四、量化的漂移面

- `exec.result` 含「待接入 / 留待 / 未接线」类表述的任务：**26 / 133**，其中 **25 个状态是 done**。
- T3-009 门禁报的 6 个零生产引用模块（`run-registry` / `app` / `api` / `layout-migrate` /
  `session-launch` / `persist-pipeline`）已被 T3-009-F1 删除，理由原话：
  「**拆是架构愿望，不是能力缺口**」。
- **同类幸存者至少还有 3 个（T3-009 门禁未覆盖）**：

| 文件 | 自述职责 | 生产引用 |
|---|---|---|
| `src/lib/state-schema.cjs` | "state.json 字段**唯一定义（单源）**" | **零**（含 `plugin/`，只有测试 import） |
| `src/server/statemachine.cjs` | `createStateMachine` / `createStateMachineRegistry`（按 sid 实例） | **零**（只有测试） |
| `src/adapters/ports.cjs` | 7 端口契约（W3-004「外部**只剩 ports 契约**」） | **零** —— 生产逐个直接 require adapter，没走契约层 |

---

## 五、根源

**任务图里没有「接线」这个工作单元。**

每个任务自洽（产出 + 单测）；依赖表达的是「我需要谁的产出**存在**」，
不是「我需要谁的产出**被采用**」。于是流程必然收敛到：

```
建抽象 → done（单测绿）
接线   → 没有任务、没有验收
清理   → 某天门禁发现死代码 → 删除
```

**产出的东西没有消费方，而任务图不表达"消费"。**
plan 阶段能确认的只有「某某模块建成」，确认不到「最终目录长这样」——
因为前者是可判定的验收，后者不是。

---

## 六、修法

1. **接线独立成任务**，且验收写成**引用关系**（可判定）：
   - ✅ `grep 确认 src/cli 下零 import lib/state.js 写函数`
   - ✅ `server.cjs 不再内联端点，全部经 api.cjs 的 registerRoutes`
   - ❌ `api.cjs 建成`
2. **禁止「由后续任务执行」这类指向集合的表述** —— 必须指向具体 task id。
   指向集合 = 空引用（本次更糟：指向的模块连一个接线任务都没有）。
3. **结构目标单独立项**：由一个任务对**最终目录形态**负责，
   而不是 N 个子任务各负责一块、没人看拼起来的图。
4. ~~眼下待裁决：`state-schema.cjs` / `statemachine.cjs` / `ports.cjs` 三个幸存者 —— 接线 or 删除。~~
   **2026-09-11 已裁决（T1-115）**：
   - `state-schema.cjs` —— **删除**。自述「单源」但生产零引用，且内容已**失真**（`PHASES` 缺 `COMMIT`，
     而 live 的 `awf_phase` 工具枚举里有它）——从没被消费过，自然也没人发现它过时。
     枚举实际 live 在各使用点（`state.js` 的 task 状态判定、`server.cjs` 的 mode 校验、MCP 工具 schema）。
   - `statemachine.cjs` —— **删除**。自述即「脚手架近似」，live 的 per-sid 状态机在 `server/run-slot.cjs`
     （`createRunSlot(sid)`：ready/busy + decisionPending + contextReady + waiters），由 `project-context`
     → `handleSidHook` 驱动。
   - `ports.cjs` —— **接线**（不是删除），归 `T1-117`：它是 W3-004 的目标形态本身（外部只剩端口契约），
     只是生产还没改走它。豁免表里仍留着，`--strict` 会盯着。
   - 三者各自专属测试随模块一并删除；`scripts/check-architecture.mjs` 的 `EXEMPTIONS` 同步移除这两条。

---

## 七、关联

- 会话隔离类问题见 `.awf/issues/001-cc-session-isolation.md`（不同主题，分开跟踪）。
- T3-009 门禁报告 §五 N-1/N-2：`.awf/reports/test/w3-009-module-gate.md`
