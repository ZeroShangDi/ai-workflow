# 多 Agent 落账链路 Bug 复盘（0.1.3 run）

> 触发：诊断 `.awf/logs/0.1.3-2026-08-28T12-15-08.log` → 4 层根因 → 修复 `src/server/server.cjs` / `src/cli/run-batch.js`
> 关联：`docs/features/server.md §4.1`、`docs/features/run.md`（落账链路）

## 现象

12 个任务（T2-001..T2-012）全部成功落账为 done，但 run 过程中出现 **~13 次伪补发循环**（"RESULT 输出无效 → SendMessage 恢复 → 等待"），污染日志、拖慢节奏、触发 RESEND_MAX。

修复后问题彻底消失，行为正确。

## 四个根因（表层）

| # | 现象 | 根因 |
|---|------|------|
| 1 | 昨天的失败记录整段重放，补发到不存在的 agent | `lastFailedTs=0` + ISO 字符串 `<=` 数字比较恒为 false + 驱动日志跨 run 追加不清 |
| 2 | 幽灵 SubagentStop（`agent_type:""`、无 SubagentStart、无 transcript）被当落账 | server 对 hook 事件信任过度，未做"我先派发才处理"的身份校验 |
| 3 | T2-007 落账成功后仍反复补发，直到 RESEND_MAX | already-done（phantom 先落账/重复 Stop）被当**可恢复失败**写失败记录 → 补发 → 再撞守卫 → 循环 |
| 4 | T2-012 的 `status:"fail"` 被拒为"无有效 RESULT" | 协议（awf-worker.md: `done|blocked|failed`）与实现（server 只收 `done|blocked`）漂移 |

## 系统性归因：为什么是这几个 bug，为什么会一起出现

四个 bug 表面独立，土壤是同一个：**它们全部落在「跨进程异步落账链路」这个新增集成点上**（CLI ↔ Session Server ↔ hooks ↔ 子 Agent），而这条链路的防御没有跟上它的复杂度。

### A. 对外部系统事件信任过度，缺身份/状态校验

`SubagentStop` hook 事件被假定"必对应真实子 Agent、必对应一次 SubagentStart、必是派发过的"。实际 Claude Code 会因后台代理状态检查等产生无 `agent_type`、无对应 Start、无 transcript 的 Stop 事件。

→ 幽灵 Stop 被落账（bug 2）、被写失败记录触发补发到不存在对象。
→ 同时暴露：agents Map 用 `session_id` 做 key，而子 Agent 共享父会话 session_id，**所有 agent 塌缩成一个 key**——观测和校验都失效。

**教训：处理外部系统事件的第一行逻辑是"验明正身"**——未跟踪实体降级为观测，不产生任何副作用；事件处理必须幂等（重复事件无害）。

### B. 游标/增量逻辑假设"从空开始"，没处理存量与类型

`lastFailedTs = 0` 假设"日志一开始是空的"。实际驱动日志（`subagent-failed.jsonl`）是 append-only 且跨 run 累积；且 `rec.ts` 是 ISO 字符串，`rec.ts <= 0` 在 JS 里是字符串转数字（`NaN <= 0` = false），**永远不跳过**——"看起来会跳过、实际全重放"。

**教训：游标类增量处理三件事缺一不可**——①初始化扫存量定起点（不假设空）；②时间戳归一化到同一单位（ms）；③比较用同一类型。并配"跨 run 第二次执行"的测试。

### C. 错误处理一刀切，没先分类再决定重试

settleSubagent 的所有失败一律写失败记录 → CLI 一律补发。但失败分两类：
- **可恢复**（agent 还在、缺 RESULT）→ 补发合理；
- **良性**（already-done = 已经成功；state 不可读）→ 补发是骚扰，循环直到上限。

**教训：任何重试/补发循环，入口必须先做错误分类（可恢复/良性/永久），且良性路径必须无副作用、有终止出口。** 重试逻辑的终止条件不能只靠"次数上限"兜底，那是把死循环推迟，不是避免。

### D. 契约（协议）与实现分离，无单一事实源

RESULT 的 status 枚举写在 `plugin/core/agents/awf-worker.md`，白名单实现在 `server.cjs`，两处各写各的 → 自然漂移。协议类常量没有用测试在两侧之间断言一致。

**教训：协议/契约要单一事实源；跨文件共识至少用一条测试锁定"实现接受协议允许的全部枚举"。**

## 为什么之前没发现

- 单元测试全 mock、集成测试只覆盖 happy path（TC38 落账成功），四个 bug 全在**边界**（重复事件、乱序、残留日志、协议外输入），happy path 测不到。
- 真实 run 是**多回合、跨 run 连续执行**，单次启动的测试模拟不了"第二次 run 读到上次残留"。
- 顺带暴露一个测试自身的问题：`/tmp/proj` 是跨测试文件共享的硬编码路径，单跑通过、全量跑失败（残留记录抬高游标）——**测试共享路径也要防跨 run 残留**，否则测试结果取决于执行顺序。

## 经验教训（可操作清单）

1. **外部事件先验明正身**：未跟踪实体降级为观测，不落账、不写失败记录、不补发。
2. **重试循环必须有"无害出口"**：错误先分类（可恢复/良性/永久），良性不触发重试；终止条件内置在分类里，而非靠次数上限硬兜。
3. **游标增量三件套**：初始化扫存量、时间戳归一化 ms、同类型比较；补"跨 run 第二次执行"测试。
4. **契约单一事实源 + 测试锁定**：协议枚举两侧一致由测试断言。
5. **集成边界补边界测试**：重复事件、乱序、残留日志、协议外输入——happy path 测试保护不了集成点。
6. **驱动型日志（会反过来驱动行为的日志）必须可清、可初始化**：append-only 日志在驱动行为时就是状态，跨 run 会累积污染。

## 落地动作（本次修复）

| 经验 | 落地 |
|------|------|
| A | agents Map 改按 `agent_id` 键控；未跟踪 SubagentStop 仅观测 |
| B | `maxTsFromLog` 初始化游标；比较改毫秒；server 启动 `resetRunLogs` 清驱动日志 |
| C | `recoverable:false`（already-done / state 不可读）→ 不写失败记录 |
| D | parseSubagentResult 接受 `failed/fail`，落账映射为 `blocked`；测试 TC44 锁定 |
| 5 | 新增 TC43（幽灵跳过）/ TC44（failed→blocked）/ 改造 TC39、TC41 契约 |
| 6 | TC-E 幂等化（先清残留 + 记录用当前时间） |
