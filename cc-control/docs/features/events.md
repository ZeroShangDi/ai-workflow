# 事件总线（events） — 功能文档

> 对应 WBS：W1-028（首批领域事件类型 + 进程内总线）；接缝引用 W3-003/004、W1-031/046
> 源码：`src/lib/events.cjs`

## 功能描述

`events.cjs` 定义 ai-workflow 的**进程内事件总线**与**首批领域事件类型目录**，用于把 run / task / agent / hook 的生命周期统一成可订阅、可分发的领域事件，并为「hook → 事件翻译」「事件 → 落盘 sink」两类接缝提供锚点。

三个关注点：

1. **事件类型目录 `EVENT_DEFS`** — 每个类型声明 `source`（谁产生）、`persist`（落到哪个 sink 类型，可空）、`payloadKeys`（必需载荷键）。
2. **归一化与校验 `createEvent`** — 补齐 `at`/`runId`，缺必需载荷键即抛错。
3. **进程内总线 `createEventBus` / `wirePersist`** — `on(type|'*', fn)` 订阅、`emit(event)` 依注册顺序同步分发、单 handler 异常被吞。

> 现状（以代码为准）：本模块是**已定义、尚未接入生产热路径**的接缝。生产 `/hook`（`src/server/server.cjs`）目前直接按事件名分流，未调用 hook-adapter；`createRunHost`（`src/server/run-host.cjs`）接受可选 `bus`，但 `src/server/server.cjs` 装配时**未传入** `bus`。`createEventBus`/`wirePersist` 当前仅被单测消费。

## 事件信封形状

`createEvent(type, payload = {}, runId)` 返回（`src/lib/events.cjs:54`）：

```js
{ type, at: <ISO 时间戳>, runId: runId ?? null, payload }
```

- `type` — 必须命中 `EVENT_DEFS`，否则抛 `未知事件类型`（`:50`）。
- `at` — `new Date().toISOString()`（归一化时补齐，不由调用方传）。
- `runId` — 顶层字段；`payloadKeys` 里**不含** `runId`。
- `payload` — 业务载荷；缺 `payloadKeys` 中任一键即抛 `缺少必需载荷键 <k>`（`:51-53`）。

**缺口（F8）**：信封**没有版本字段**，`createEvent` 也不校验/携带版本。形状一旦变更，消费方（api/WS、独立构建的 `web/` 前端）无法按版本判定，只能靠「同时升级」的约定，无兼容读路径。此缺口已登记于 `.awf/reports/architecture-discipline-audit.md` §F8（严重度：中，设计缺口非既有缺陷）；处置建议「事件信封加版本字段 + 消费方按版本判形状」待架构终稿（T1-101）定。

## `EVENT_DEFS` 全部类型与必需载荷键

| 事件类型 | source | persist 锚点 | 必需载荷键（payloadKeys） |
|----------|--------|--------------|---------------------------|
| `run.started` | `run.driver` | `log.append` | （无） |
| `run.stopped` | `run.driver` | `log.append` | （无） |
| `run.phase` | `run.driver` | — | `phase` |
| `task.started` | `scheduler` | — | `taskId` |
| `task.done` | `settle` | `meta.patch` | `taskId` |
| `task.blocked` | `settle` | `meta.patch` | `taskId` |
| `agent.started` | `hook.subagent_start` | — | `agentId` |
| `agent.stopped` | `hook.subagent_stop` | — | `agentId`、`taskId` |
| `usage.snapshot` | `statusline/context-usage` | `usage.snapshot` | （无） |
| `metrics.snapshot` | `run.metrics` | `metrics.snapshot` | （无） |
| `decision.record` | `decision.gate` | `decision.record` | `decisionId` |

来源：`EVENT_DEFS`（`src/lib/events.cjs:15-31`）；`EVENT_TYPES = Object.keys(EVENT_DEFS)`（`:45`）。

## hook → 事件映射（`HOOK_EVENT_MAP`）

| Claude Code hook | 领域事件 |
|------------------|----------|
| `SessionStart` | `run.started` |
| `Stop` | `run.stopped` |
| `SubagentStart` | `agent.started` |
| `SubagentStop` | `agent.stopped` |
| `UserPromptSubmit` | `run.phase` |
| `PreToolUse` | `null`（不产出，由决策/权限判断决定） |
| `PostToolUse` | `null` |

来源：`src/lib/events.cjs:34-42`。消费方：`translateHook` / `createHookAdapter`（`src/server/hook-adapter.cjs:59-90`），它把 hook payload 译为事件数组并逐条 `emit`；`FIELD_ANCHORS` 为各 hook 提供最小载荷映射（`hook-adapter.cjs:22-28`）。

## 谁发 / 谁收

| 角色 | 实体 | 依据 |
|------|------|------|
| 事件定义消费（翻译） | `src/server/hook-adapter.cjs`（`translateHook`/`createHookAdapter`，require `HOOK_EVENT_MAP`、`createEvent`） | `hook-adapter.cjs:19` |
| 端口暴露 | `src/adapters/ports.cjs` 导出 `hook: createHookAdapter`；`createCcAdapters({ bus })` 用 `bus.emit` 作为 emit | `ports.cjs:154-158,183` |
| 宿主侧发射 | `createRunHost` 的 `emit(type, runId, payload)`：写入事件环 + 调 `bus?.emit({type,at,runId,payload})`（若注入）+ 通知 subscribers | `run-host.cjs:143-159` |
| 生产装配 | `src/server/server.cjs` 调 `createRunHost` 时**未传 bus** | `server.cjs:662-671` |

> `run-host.cjs` 自身的 `HOST_EVENT_TYPES`（`run.submitted`/`run.started`/`run.phase`/`run.stopped`/`run.error`/`task.started`/`task.done`/`task.blocked`/`gate.fix`，`run-host.cjs:46-56`）与 `EVENT_DEFS` **部分重叠但不相等**：`run.submitted`/`run.error`/`gate.fix` 只在宿主侧，`agent.*`/`usage.snapshot`/`metrics.snapshot`/`decision.record` 只在 `EVENT_DEFS`。

## 与 WS / 前端推送的关系

- `src/server/ws.cjs` 是零依赖的 RFC6455 服务端助手（握手 `upgrade`、`encodeTextFrame`、客户端帧解析），只负责「服务端 → 客户端」文本帧推送（`ws.cjs:1-10`）。
- `src/server/server.cjs` 在 `upgrade` 上仅接受 `/run/events` 路径；握手成功后经 **`pcx.runHost.subscribe(...)`** 订阅宿主事件，用 `encodeTextFrame(JSON.stringify(event))` 推送（`server.cjs:1395-1415`）。
- 因此 **WS 推送的数据源是 run-host 的事件环 / subscriber 集合，不是 `events.cjs` 总线**。run-host 事件形状是 `{ seq, runId, type, at, payload }`（`run-host.cjs:145`，比事件信封多一个单调递增 `seq`），支持按 `afterSeq` 轮询补拉（`GET /run/events` → `runHost.pollEvents`，`server.cjs:1287-1297`）。事件环上限 `EVENT_RING_CAP = 10000`（`run-host.cjs:40`）。

## 核心常量 / 配置

| 常量 | 值 | 说明 |
|------|----|------|
| `EVENT_DEFS` | 11 个类型 | 类型目录：source / persist / payloadKeys（`events.cjs:15-31`） |
| `HOOK_EVENT_MAP` | 7 条 hook 映射 | hook 名 → 事件类型或 null（`events.cjs:34-42`） |
| `EVENT_TYPES` | `Object.keys(EVENT_DEFS)` | 类型集合（`events.cjs:45`） |
| `EVENT_RING_CAP` | `10000` | （宿主侧）事件环上限，超限从头部裁剪（`run-host.cjs:40`） |

## 函数清单

| 函数 | 说明 | 位置 |
|------|------|------|
| `createEvent(type, payload, runId)` | 归一化 + 校验必需载荷键，返回 `{type,at,runId,payload}` | `src/lib/events.cjs:48-55` |
| `persistSinkFor(type)` | 返回事件的 persist sink 类型，无则 `null` | `src/lib/events.cjs:58-61` |
| `createEventBus()` | 返回 `{ on, emit, types }`；`on` 返回取消订阅函数 | `src/lib/events.cjs:67-96` |
| `wirePersist(bus, sinks, { dispatch })` | 订阅 `'*'`，按 persist 锚点把事件派发给 `dispatch`；无锚点忽略 | `src/lib/events.cjs:99-106` |
| `translateHook(payload)` | hook payload → 领域事件数组（消费方实现） | `src/server/hook-adapter.cjs:59-73` |
| `createHookAdapter({ emit })` | `.hook(payload,{runId})` 翻译并逐条 emit，返回事件数 | `src/server/hook-adapter.cjs:79-90` |

## 接口 / 依赖

| 模块 | 用途 |
|------|------|
| `src/lib/events.cjs` | 事件类型目录 + 总线 + persist 锚点（本功能） |
| `src/server/hook-adapter.cjs` | hook → 领域事件翻译接缝（唯一生产代码消费方） |
| `src/adapters/ports.cjs` | 经端口契约暴露 `createHookAdapter` / `createCcAdapters` |
| `src/server/run-host.cjs` | 宿主事件发射，可选把事件转发给注入的 `bus` |
| `src/server/ws.cjs` | 事件流 WS 推送通道（消费宿主事件，非总线） |

## 验收标准

- [ ] `createEvent` 对未知类型抛 `未知事件类型`；对缺必需载荷键抛 `缺少必需载荷键 <k>`。
- [ ] 事件信封恒为 `{ type, at, runId, payload }`，`at` 为 ISO 字符串，`runId` 缺省 `null`。
- [ ] `EVENT_DEFS` 每个类型都声明 `source` 与 `payloadKeys`；`persist` 可空（无锚点事件经 `wirePersist` 被忽略）。
- [ ] `bus.on('*')` 通配订阅与 `bus.on(type)` 定向订阅均触发；`emit` 返回被调用的 handler 数。
- [ ] 单 handler 抛错被吞（`console.error`），不影响后续 handler 与返回值。
- [ ] 测试覆盖：`tests/unit/events.test.js`、`tests/unit/hook-adapter.test.js`。
