# State 管理 — 测试用例

> 对应功能文档：`docs/features/state.md`
> 源码：`src/lib/state.js` + `plugin/core/mcp/awf-state/server.cjs`
> 测试文件：`tests/unit/state.test.js`、`tests/unit/state-mode.test.js`、`tests/unit/state-plan-reset.test.js`、`tests/unit/backup.test.js`、`tests/integration/awf-state.test.js`（MCP 协议全链路）；相关：`tests/unit/gate-fix.test.js`、`tests/unit/scheduler.test.js`（门禁闭环）

## 测试场景总览

### CLI 侧 `tests/unit/state.test.js`

| # | 场景 | 类别 |
|---|------|------|
| TC1 | loadState：正常读取 | 正常 |
| TC2 | loadState：文件不存在 → null | 正常 |
| TC3 | loadState：非法 JSON → null | 正常 |
| TC4 | saveState：写入（目录创建 + lastUpdated + 2 空格缩进） | 正常 |
| TC4b | saveState：加写锁且无 `state.lock` 残留 | 并发 |
| TC-m1 | markTaskActive：pending → active，写 `exec.startedAt`，不影响其他任务 | 正常 |
| TC-m2 | markTaskActive：不覆盖已进终态的任务（返回 false） | 边界 |
| TC5 | findNextTask：首个 pending 无 deps | 正常 |
| TC6 | findNextTask：deps 未满足 → 跳过 | 依赖 |
| TC7 | findNextTask：deps 全满足 → 返回 | 依赖 |
| TC8 | findNextTask：全部 done → null | 边界 |
| TC9 | findNextTask：tasks 在根级 / 无 tasks | 边界 |
| TC10 | isMilestoneDone：全 done / 部分 / 空 | 边界 |
| TC-B1 | selectReadyBatch：无 deps 按 max 截断，保持顺序 | 调度 |
| TC-B2 | selectReadyBatch：deps 未满足不 ready | 调度 |
| TC-B3 | selectReadyBatch：doc 参与并行、commit 独占 | 调度 |
| TC-B4 | selectReadyBatch：maxPerFeature=1 → 功能内串行、跨功能并行 | 调度 |
| TC-B5 | selectReadyBatch：maxPerModule=1 → 每模块一个 | 调度 |
| TC-B6 | selectReadyBatch：maxModules=1 → 单模块活跃 | 调度 |
| TC-B7 | selectReadyBatch：review gate deps 全 done 后 ready | 调度 |
| TC-B8 | selectReadyBatch：全完成 / 无 tasks → 空批次 | 边界 |
| TC-B9 | selectReadyBatch：max=1 等价 findNextTask 语义 | 调度 |
| TC-B10 | selectReadyBatch：缺失 plannedFiles 保守串行（全缺失取首个） | 调度 |
| TC-B11 | selectReadyBatch：plannedFiles 冲突 → 不同批 | 调度 |
| TC-B12 | selectReadyBatch：目录前缀冲突（`src/util/` vs `src/util/math.js`） | 调度 |
| TC-G1 | spawnGateFixTask：blocked + verdict 非 pass → 派生 + 回退门禁 | 门禁 |
| TC-G2 | spawnGateFixTask：verdict pass → 不派生 | 门禁 |
| TC-G3 | spawnGateFixTask：无 verdict → 不派生 | 门禁 |
| TC-G4 | spawnGateFixTask：非 blocked → 不派生 | 门禁 |
| TC-G5 | spawnGateFixTask：非门禁 kind → 不派生 | 门禁 |
| TC-G6 | spawnGateFixTask：达 `MAX_RECHECK` → null（保持 blocked） | 边界 |
| TC-G7 | spawnGateFixTask：第二轮 id `-F2`、deps 追加、recheck=2 | 门禁 |
| TC-G8 | spawnGateFixTask：传入 prompt 原样落盘 | 门禁 |
| TC-p1 | getCurrentPhase：正常 / state 缺失 / 无字段 → null | 正常 |

### 其它单测

| # | 场景 | 文件 | 类别 |
|---|------|------|------|
| TC-m3 | setWorkflowMode：只改最新 state 的 mode，不覆盖其他字段 | `state-mode.test.js` | 并发 |
| TC-p2 | archiveOldStateForPlan：残留旧 plan → 归档 + 重置空模板 | `state-plan-reset.test.js` | 守卫 |
| TC-p3 | archiveOldStateForPlan：空 state → none，不归档 | `state-plan-reset.test.js` | 守卫 |
| TC-p4 | archiveOldStateForPlan：mode=run → run-active，不动文件 | `state-plan-reset.test.js` | 守卫 |
| TC-p5 | archiveOldStateForPlan：state 不存在 → none | `state-plan-reset.test.js` | 边界 |
| TC-b1 | backupState：备份到 `versions/<version>-<ts>.json` | `backup.test.js` | 正常 |
| TC-b2 | backupState：state 不存在 → 不创建 | `backup.test.js` | 边界 |
| TC-b3 | backupState：无 version → 不创建 | `backup.test.js` | 边界 |
| TC-b4 | backupState：两次备份时间戳不同 | `backup.test.js` | 边界 |

### MCP 侧 `tests/integration/awf-state.test.js`

| # | 场景 | 类别 |
|---|------|------|
| TC27 | initialize 协议握手（protocolVersion/capabilities/serverInfo） | 协议 |
| TC28 | tools/list 返回 **18** 个 tools | 协议 |
| TC30 | 未知 method → -32601 | 协议 |
| TC11 | awf_read_state 返回完整 state，且 state 不变 | 正常 |
| TC11d | awf_read_state 传 taskId → 只返回该任务详情 | 正常 |
| TC11e | awf_read_state 传不存在 taskId → ok:false | 异常 |
| TC12 | awf_task_status：pending → active，写 `exec.startedAt`，刷新 lastUpdated | 正常 |
| TC13 | awf_task_status：id 不存在 → ok:false 且 state 不变 | 异常 |
| TC14 | awf_task_result：写 `exec.result` + `exec.files` | 正常 |
| TC15 | awf_task_commit：追加两条 commit | 正常 |
| TC33 | awf_task_complete：一次原子提交 done + result + files + architecture + commits | 正常 |
| TC34 | awf_task_complete：blocked + blockedReason | 正常 |
| TC35 | awf_task_complete：非法 status / 不存在 id → ok:false 且 state 不变 | 异常 |
| TC16 | awf_task_create：默认值（pending/deps=/plannedFiles=/constraints） | 正常 |
| TC16b | awf_task_create：kind 枚举 = dev/debug/review/test/doc/commit/ui-design/ui-code | 契约 |
| TC17 | awf_task_create：id 重复 → ok:false | 异常 |
| TC17b | T1 文档产出 / T2 定级拒绝 / T4 门禁需 W4 / 同 W4 唯一 | 契约 |
| TC18 | awf_task_update：部分字段更新，未传不覆盖 | 正常 |
| TC19 | awf_task_delete：删除后 tasks=[T1] | 正常 |
| TC20 | awf_plan_configure：配置全部元数据 | 正常 |
| TC21 | awf_wbs_create/update/delete 链路 | 正常 |
| TC22 | awf_wbs_create：id 重复 → ok:false | 异常 |
| TC23 | awf_phase：设置 currentState | 正常 |
| TC24 | awf_mode：设置 run / pause | 正常 |
| TC25 | awf_version：设置 version | 正常 |
| TC26 | awf_milestone_create/update/delete 链路 | 正常 |
| TC29 | 未知 tool name → ok:false | 异常 |
| TC31 | state.json 不存在 → ok:false + ENOENT | 异常 |
| TC32 | tasks 在根级：create 落到根级 tasks，`plan.tasks` undefined | 边界 |

## 详细测试用例

### TC4b: saveState — 写锁无残留

**前置条件**：空临时目录
**执行**：`saveState(tmpDir, { mode:'idle', version:'0.1.0' })`
**断言**：
- `.awf/state.lock` 不存在（`withStateLock` finally 清理）
- `.awf/state.json` 内容 `mode='idle'`

### TC-m1: markTaskActive — 原子标 active

**前置条件**：state.tasks = [T1 pending, T2 done]
**执行**：`markTaskActive(tmpDir, 'T1')`
**断言**：返回 `true`；T1.status='active' 且 `exec.startedAt` 匹配 ISO 前缀；T2 不变

### TC-B1: selectReadyBatch — max 截断保持顺序

**前置条件**：T1/T2/T3 均 pending 且各有 plannedFiles
**执行**：`selectReadyBatch(state, { agents: { max: 2 } })` / `{ max: 1 }`
**断言**：分别返回 `['T1','T2']` / `['T1']`

### TC-B3: selectReadyBatch — doc 并行 / commit 独占

**前置条件**：D1/D2 kind=doc 各有 plannedFiles；追加 C1 kind=commit
**执行**：`selectReadyBatch(state, { agents: { max: 9 } })`
**断言**：doc 两任务 `['D1','D2']`；含 commit 时返回 `['C1']`（独占优先）

### TC-B10: selectReadyBatch — 缺失 plannedFiles 保守串行

**前置条件**：T1（缺失）、T2（有 `a.js`）、T3（缺失）
**执行**：`selectReadyBatch(state, { agents:{ max:9 } })`
**断言**：返回 `['T2']`；全缺失时取首个 `['A']`

### TC-B11 / TC-B12: plannedFiles 冲突

**前置条件**：两任务同文件 / 一方为目录前缀
**执行**：`selectReadyBatch(state, { agents:{ max:3 } })`
**断言**：冲突者留到下一批，返回 `['T1','T3']`

### TC-G1: spawnGateFixTask — 派生修复 + 回退门禁

**前置条件**：R1 kind=review、status=blocked、verdict.level='changes_requested'、deps=['T1']
**执行**：`spawnGateFixTask(state, state.tasks[0], prompt)`
**断言**：
- 返回 `'R1-F1'`；修复任务 kind=dev、status=pending、deps=['T1']、plannedFiles=[]、constraints=[]、acceptance=`门禁 R1 复审通过`、prompt 原样
- 门禁回退：R1.status='pending'、deps=['T1','R1-F1']、`exec.recheck=1`、verdict 保留

### TC-G6: spawnGateFixTask — 达轮次上限

**前置条件**：`exec.recheck = MAX_RECHECK`
**执行**：`spawnGateFixTask(...)`
**断言**：返回 `null`，门禁保持 blocked

### TC33: awf_task_complete — 原子提交

**前置条件**：T1 存在
**执行**：`awf_task_complete({ id:'T1', status:'done', result, files, architecture, commits:[2 条] })`
**断言**：
- T1.status='done'；`exec` 含 result/files/`completedAt`(ISO)/architecture
- `T1.commits` 两条；`blockedReason` undefined

### TC17b: 文档任务 id / wbsRef 契约

**前置条件**：baseState
**执行**：依次 create `T1-900`(doc) / `T2-900`(doc) / `T4-001`(doc,W4-001) / `T4-002`(doc,W4-001)
**断言**：T1-900 ok；T2-900 error 含 `T1-*`；T4-001 ok；T4-002 error 含 `already has documentation gate T4-001`

### TC34: awf_task_complete — blocked

**前置条件**：T1 存在
**执行**：`awf_task_complete({ id:'T1', status:'blocked', result:'卡住', blockedReason:'需外部依赖' })`
**断言**：T1.status='blocked'、blockedReason='需外部依赖'、`exec.result='卡住'`

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| CLI `node:fs` | 真实 fs + `fs.mkdtempSync()` 临时目录 | 每用例隔离，`afterEach` 清理 |
| CLI 锁 | 真实 `state.lock`（store-core） | 断言锁文件无残留（TC4b） |
| MCP `node:fs` | 真实临时文件（`writeState`/`readState` 直写 `.awf/state.json`） | 每用例 `beforeEach` 重置为 baseState |
| MCP 传输层 | `spawn` 子进程 + stdio JSON-RPC 客户端（`AWFStateClient`） | 测试完整协议交互；5s 请求超时防挂起 |
| `backupState` 时间戳 | `vi.useFakeTimers()` + `vi.advanceTimersByTime` | 制造不同时间戳文件（TC-b4） |
| 环境变量 | spawn 时注入 `AWF_PROJECT_ROOT` | 隔离项目根，缺省 `CC_AWF_STATE_SERVER` 未设 → 直写文件路径 |
