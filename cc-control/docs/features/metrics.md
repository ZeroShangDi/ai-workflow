# 运行指标（run-metrics） — 功能文档

> 对应 WBS：（源码未标注）。消费端 Diagnostics 视图见 T1-089
> 源码：`src/lib/run-metrics.cjs`（CJS 实现）；`src/lib/run-metrics.js`（ESM 壳）

## 功能描述

`run-metrics.cjs` 负责 **run-meta.json 的读写**与 **运行指标（metrics）聚合**：

1. **run-meta 生命周期** — `.awf/logs/run-meta.json` 记录本次 run 的起止时间、主会话 id、子 agent 注册表；提供读 / 重置 / 增量更新，落盘经 store 层 `JsonFileStore`（原子写，单写者 server 无需跨进程锁）。
2. **指标聚合** — 读 `state.json` + `.awf/context/usage.json` + run-meta + transcript（主会话 + 各子 agent 的 `.jsonl`），聚合成 token 用量、产出速度、上下文占用、覆盖范围等。
3. **transcript 定位** — `mainTranscriptPath` 给出主会话 transcript 的绝对路径（收尾协商的「本轮有无产出」探测也用它）。

`src/lib/run-metrics.js` 仅是 ESM 壳：`createRequire` 加载 `.cjs` 并具名重导出 `readRunMetrics/readRunMeta/resetRunMeta/updateRunMeta`（`run-metrics.js:6-11`）。

## run-meta.json 的字段与生命周期

### 文件位置与存储

- 相对路径 `['.awf','logs','run-meta.json']`（`run-metrics.cjs:9`），`runMetaFile()` 拼绝对路径（`:22-24`）。
- 经 `store.createJsonFileStore({ filePath })` 读写（`:27-29`）——原子写。

### 初始形状（`resetRunMeta`，`:38-47`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `projectRoot` | string | 项目根 |
| `startedAt` | string\|null | run 起始 ISO 时间 |
| `endedAt` | string\|null | run 结束 ISO 时间 |
| `mainSessionId` | string\|null | 主会话 id（用于定位主 transcript） |
| `subagents` | object | 子 agent 注册表：key → 条目 |
| `updatedAt` | string | 本次写入的 ISO 时间 |

### 子 agent 条目（在 server 更新时补齐）

`subagents[key]` 由 `src/server/server.cjs` 的 `SubagentStart`/`SubagentStop` hook 写入，字段：

| 字段 | 说明 |
|------|------|
| `agentId` | agent 标识 |
| `sessionId` | 该 agent 的 cc session_id |
| `status` | `running` / `stopped`（诊断恢复时可为 `unknown`） |
| `startedAt` | 首次出现时间（保留原值，不覆盖） |
| `stoppedAt` | 停止时间（停止时写，运行中为 null） |
| `transcriptPath` | 该 agent 的 transcript 绝对路径（可用于 token 聚合） |

来源：`server.cjs:947-963`（start）、`server.cjs:973-989`（stop）。

### 写入点（生命周期）

| 时机 | 行为 | 位置 |
|------|------|------|
| 新会话 SessionStart（session_id 变化） | `resetRunMeta` 重置；写 `startedAt`（首次保留）、`endedAt=null`、`mainSessionId` | `server.cjs:916-930` |
| SubagentStart | 更新对应 `subagents[key]`（status=running） | `server.cjs:947-963` |
| SubagentStop | 更新 `subagents[key]`（status=stopped，写 stoppedAt） | `server.cjs:973-989` |
| 诊断快照恢复 | 从诊断记录恢复 mainSessionId + subagents | `server.cjs:204-211` |
| server 启动 / 会话切换 | 清理 run 态 | `server.cjs:918`、`server.cjs:1455` |

更新统一走 `updateRunMeta(projectRoot, updater)`（读旧值 → updater 返回新值 → 写回，`:31-36`）。

## metrics 聚合口径

入口 `readRunMetrics(projectRoot, runtime)`（`:182-305`）。`runtime` 可含 `nowMs`（默认 `Date.now()`）、`mainSessionId`、`activeAgents`。

### 输入来源

| 来源 | 取用 |
|------|------|
| `.awf/state.json` | 任务 exec.startedAt、mode、currentState（`:184`、`:159-180`、`:300-303`） |
| `.awf/context/usage.json` | 上下文占用百分比、窗口大小、total_input_tokens（`:53-55`、`:259-260`、`:286-293`） |
| `.awf/logs/run-meta.json` | startedAt/endedAt/mainSessionId/subagents（`:49-51`） |
| `.awf/config.json` | `run.agents.max`（判单/多 agent，`:188`、`:249`） |
| 主/子 transcript `.jsonl` | token 用量（`:195-203`、`:79-157`） |

### token 累加（`parseTranscript`，`:79-157`）

- 仅统计 `type === 'assistant'` 且带 `message.usage` 的行；按 `message.id || uuid` **去重**（`:122-125`）。
- 累加 `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`（`:131-134`）。
- 时间轴取该 transcript 最早/最晚消息时间；近 窗口（`RECENT_WINDOW_MS = 60*1000`）内输出 token 计入 `recentOutputTokens`（`:12`、`:140-143`）。
- `type === 'cost-state'` 行的 `startTime` 也参与最早时间推导（`:116-120`）。

### 聚合与派生

- `tokens.total = input + output`（`:270`）；`input`/`output`/`cacheReadInput`/`cacheCreationInput` 为各 transcript 求和。
- **覆盖口径 `coverage`**（`:253-257`）：`usageMessages>0` 时，单 agent → `exact`；多 agent 下若 `activeAgents===0 && missingSubagentTranscripts===0` → `exact`，否则 `partial`；无 usage → `none`。同时给出 `coveredTranscripts`/`totalTranscripts`/`missingSubagentTranscripts`（`:276-278`）。
- `agentMode`：`maxAgents>1 || 有子 agent || activeAgents>0` → `multi`，否则 `single`（`:249`、`:263`）。
- `elapsedMs`：`deriveStartedAtMs`（meta.startedAt → transcript 最早时间 → 任务 exec.startedAt 最小值，`:159-170`）到 `deriveEndedAtMs`（meta.endedAt → state.mode==='idle' 时 state.lastUpdated，`:172-180`）之差，或到 `nowMs`（`:237-238`）。
- **产出速度** `outputSpeed`（`:280-285`）：`currentTokensPerSecond` = 近 60s 输出 token / 观测秒数（`min(60, recentObservedSeconds)`）；`averageTokensPerSecond` = 总 output / 总秒数；`basis` = `recent_60s` | `average` | `none`、`recentWindowSeconds=60`。
- `context`（`:286-293`）：来自 usage.json 的 `usedPercentage`/`remainingPercentage`/`contextWindowSize`/`totalInputTokens`/`ratio`（= `total_input_tokens / context_window_size`）/`updatedAt`。
- `sources`（`:294-299`）：`mainSessionId`/`mainTranscriptPath`/`subagentCount`/`transcriptPaths`（去重）。
- `state`（`:300-303`）：`mode`、`currentPhase`（state.currentState）。

### transcript 路径定位（`mainTranscriptPath`）

`<homedir>/.claude/projects/<projectSlug>/<sessionId>.jsonl`（`:65-68`）；`projectSlug` = `path.resolve(projectRoot).replace(/\//g,'-')`（`:61-63`）。`sessionId` 为空返回 `null`。

## `/awf/metrics` 端点暴露什么

- 路由：`GET /awf/metrics` → `{ ok: true, metrics: getMetricsSnapshot(pcx) }`（`server.cjs:1053-1055`）。
- `getMetricsSnapshot(pcx)`（`server.cjs:174-185`）：
  - 先 `reconcileDiagnosisSession`（必要时从诊断快照恢复会话）；
  - **1 秒缓存**（`Date.now() - pcx.metricsCache.at < 1000` 命中即返回）；
  - 调 `readRunMetrics(projectRoot, { mainSessionId, activeAgents })`。
- 即端点返回的 `metrics` 就是 `readRunMetrics` 的返回对象（`agentMode`/`activeAgents`/`maxAgents`/`startedAt`/`endedAt`/`elapsedMs`/`tokens`/`outputSpeed`/`context`/`sources`/`state`）。
- 相邻端点：`GET /awf/diagnostics` 返回最近一次诊断记录（`server.cjs:1057-1059`）；`POST /awf/diagnostics` 触发诊断（`:1061-1064`），诊断请求会把 metrics 快照 + state + runMeta 一并落盘（`:223-231`）。

## 与前端 Diagnostics 视图的关系

- `web/src/views/Diagnostics.jsx` 并行请求 `GET /awf/metrics` 与 `GET /awf/diagnostics`，用 `toDiagnosticsModel({ metrics, diagnosis })` 建模（`Diagnostics.jsx:14-18`），并轮询刷新；点「触发诊断」走 `POST /awf/diagnostics`（`:36`）。
- 视图展示：指标快照 / AI 诊断结论 / Token / 覆盖范围（`Diagnostics.jsx:1-2`）。
- dashboard 视图也消费同一 metrics 响应（`web/src/views/dashboard-model.js:6-29`）。

## 核心常量 / 配置

| 常量 | 值 | 说明 |
|------|----|------|
| `RUN_META_PATH` | `['.awf','logs','run-meta.json']` | run-meta 文件相对路径（`:9`） |
| `CONTEXT_USAGE_PATH` | `['.awf','context','usage.json']` | 上下文用量文件（`:10`） |
| `CONFIG_PATH` | `['.awf','config.json']` | 运行配置（`:11`） |
| `RECENT_WINDOW_MS` | `60 * 1000` | 「当前速度」近窗口（`:12`） |
| 指标缓存窗口 | `1000ms` | `/awf/metrics` 快照缓存（`server.cjs:176`） |

## 函数清单

| 函数 | 说明 | 位置 |
|------|------|------|
| `readRunMeta(projectRoot)` | 读 run-meta（空文件返回 `{}`） | `src/lib/run-metrics.cjs:49-51` |
| `updateRunMeta(projectRoot, updater)` | 读旧 → updater → 写回，返回新值 | `:31-36` |
| `resetRunMeta(projectRoot)` | 重置为初始形状 | `:38-47` |
| `readRunMetrics(projectRoot, runtime)` | 聚合指标（主入口） | `:182-305` |
| `mainTranscriptPath(projectRoot, sessionId)` | 主会话 transcript 绝对路径 | `:65-68` |
| `readContextUsage` / `readConfig` / `readJson` | usage/config/JSON 读取 | `:14-20,53-59` |
| `parseTranscript(filePath, nowMs)` | JSONL → token 统计 | `:79-157` |
| `deriveStartedAtMs` / `deriveEndedAtMs` | 起止时间推导 | `:159-180` |
| `projectSlug(projectRoot)` | 路径 → slug | `:61-63` |

## 接口 / 依赖

| 模块 | 用途 |
|------|------|
| `src/lib/store.cjs` | `createJsonFileStore`（run-meta 原子读写） |
| `src/lib/run-metrics.cjs` → `src/lib/run-metrics.js` | ESM 壳供 CLI/前端侧具名导入 |
| `src/server/server.cjs` | `/awf/metrics` 端点、run-meta 写入、`getMetricsSnapshot` |
| `src/lib/run-diagnosis.cjs` | 诊断消费 metrics 快照（`buildDiagnosisPrompt`） |
| `web/src/views/Diagnostics.jsx` / `dashboard-model.js` | 前端消费 |

## 验收标准

- [ ] `resetRunMeta` 后 run-meta 含 `projectRoot/startedAt/endedAt/mainSessionId/subagents/updatedAt`。
- [ ] `updateRunMeta` 保留未修改字段，仅覆盖 updater 返回的字段；写盘为原子写（JsonFileStore）。
- [ ] 单 agent：token 聚合等于主 transcript usage 去重后之和；`coverage === 'exact'`。
- [ ] 多 agent 且存在运行中/缺 transcript 的子 agent：`coverage === 'partial'`，`missingSubagentTranscripts` 计数正确。
- [ ] `state.mode === 'idle'` 时 `endedAt` 取 `state.lastUpdated`，`elapsedMs` 固定不再随 nowMs 增长。
- [ ] `mainTranscriptPath(null sessionId)` 返回 `null`；`projectSlug` 把 `/` 全替换为 `-`。
- [ ] `GET /awf/metrics` 返回 `{ ok:true, metrics }`，1s 内重复请求命中缓存。
- [ ] 测试覆盖：`tests/unit/run-metrics.test.js`（含单 agent / 多 agent / 已结束 run 三例）。
