# State 管理 — 功能文档

> 对应 WBS：W1-010/011（state 持久化核心收敛，T1-015）；state.js 经 store-core 落盘
> 源码：`src/lib/state.js` + `plugin/core/mcp/awf-state/server.cjs`

## 功能描述

State 管理是 `.awf/state.json` 的唯一事实源（任务图 / WBS / plan 元数据 / 里程碑 / 运行模式 / 阶段）。分两层，但**持久化实现已收敛到单一核心** `src/lib/store-core.cjs`（单写锁 + 原子写）：

| 层 | 文件 | 运行环境 | 用途 |
|-----|------|---------|------|
| CLI 侧 | `src/lib/state.js` | Node ESM | `awf plan` / `awf run` 内部读写，含就绪池/调度辅助/门禁闭环 |
| MCP 侧 | `plugin/core/mcp/awf-state/server.cjs` | 独立子进程 (stdio JSON-RPC) | AI 经 20 个 MCP tools 操作 state；动态规划工具只作 server 薄入口 |

另有第三消费方：`src/server/server.cjs`（HTTP Session Server）经 `store` / `store-core` 读写同一份 state（`GET /awf/state`、`/run/state/apply`），三端共用同一 `.awf/state.lock`，跨实现互斥。

state 字段模型见 [核心数据模型](#核心数据模型)；store 层本身见 `docs/features/store.md`。

## 执行流程

### 写路径（单写者收口）

- **CLI**：`loadState` 读 → 业务 mutate → `saveState`（补 `lastUpdated`，锁内整份原子写）。
- **CLI 字段级更新**：`setWorkflowMode` / `markTaskActive` 在锁内**重新读最新 state** 再改单字段，避免用旧任务快照覆盖并发落账（`state.js:31` / `state.js:44`）。
- **MCP**：`tools/call` 分发 → `readState` → mutate → `writeState`，全程在 `withStateLock` 内（`server.cjs:42`）。
- **MCP server 单写者模式**：`CC_AWF_STATE_SERVER=1` 时，MCP 不再直写文件，改为 `GET /awf/state` 读、`POST /run/state/apply` 写；写请求携带读取时的 `lastUpdated` 和 state SHA-256 指纹，server 在 state 锁内比较并写入，陈旧快照返回冲突。缺省关 → 离线/plan/单测沿用锁内直写文件。
- **任务图写保护**：底层 `prerequisiteFor` 原语可将创建、插入目标之前和依赖重连一次完成；deps 更新校验缺失引用与环，active 任务不能新增未完成依赖，有依赖者的任务不能删除。运行期不直接暴露这些组合步骤，统一由动态规划能力调用。
- **动态任务规划能力**：run/pause 阶段的结构变更统一走 `awf_dynamic_plan`，核心位于 `src/server/dynamic-planning/`；MCP 不计算位置或副作用。基础 task CRUD 仅保留给 plan/idle。
- **server**：`pcx.stores.state.readSync()` / `storeCore.readJsonSync(runStateFile(sid))`；写经 `store`（见 store.md）。

### 读路径

- `loadState` / `getCurrentPhase` 直读，**不加锁**；丢更新由写者收敛兜底（单写者收口）。

### run 生命周期与 state

- `awf run` 读取 state → 就绪池筛选 → 派发；任务落账经 `awf-state` MCP 工具（`awf_task_complete` 原子提交）。
- 全部任务 done → 收尾 `backupState` 快照到 `.awf/versions/`。
- `awf plan` 启动时 `archiveOldStateForPlan` 守卫：残留旧 state 先归档再重置为空 plan 模板。

## 核心常量 / 配置

| 常量 | 值 | 说明 | 位置 |
|------|-----|------|------|
| `EXCLUSIVE_KINDS` | `Set(['commit'])` | 独占任务类型：commit 改共享仓库状态，必须单独成批；**doc 已不独占**（按 plannedFiles 正常并行） | `state.js:92` |
| `MAX_RECHECK` | `3` | 门禁复审最大轮次，超过保持 blocked 需人工介入 | `state.js:241` |
| `STATE_FILE` | `'.awf/state.json'` | state 相对路径 | `state.js:7` |
| `DEFAULT_LOCK_TIMEOUT_MS` | `5000` | 锁超时（store-core 提供，50ms 重试间隔） | `store-core.cjs:22` |
| `AWF_PROJECT_ROOT` | env | MCP 侧项目根（缺省 `cwd`） | `server.cjs:10` |
| `CC_AWF_STATE_SERVER` | env `'1'` | 启用 MCP server 单写者模式 | `server.cjs:74` |
| `CC_PORT` | env / config | server 单写者模式端口（缺省 8787） | `server.cjs:75` |
| `CC_SID` / `CC_PROJECT` | env | 单写者模式请求 query：`sid`（命中本 run 槽）/ `p`（多项目路由） | `server.cjs:78-85` |

## 函数清单

### CLI 侧 `src/lib/state.js`

| 函数 | 说明 | 位置 |
|------|------|------|
| `stateLockPath(projectRoot)` | 写锁路径 `.awf/state.lock`（CLI/MCP/server 共用同名锁） | L12 |
| `loadState(projectRoot)` | 读 `.awf/state.json`（缺失/非法 → null，经 `readJsonSync`） | L17 |
| `saveState(projectRoot, state)` | 补 `lastUpdated`，锁内整份覆盖 + 原子写 | L22 |
| `setWorkflowMode(projectRoot, mode)` | 锁内读最新 state 仅改 `mode`；state 缺失返回 false | L31 |
| `markTaskActive(projectRoot, taskId)` | 锁内把 pending 任务标 active（写 `exec.startedAt`，清 `completedAt`）；非 pending/未找到返回 false | L44 |
| `getCurrentPhase(projectRoot)` | 返回 `state.currentState` 或 null | L64 |
| `getNextTask(state)` / `findNextTask(state)` | 首个 pending 且 deps 全 done 的任务 | L70 / L83 |
| `depsDone(task, taskById)`（内部） | deps 是否全部 done（含 deps 缺失 → 不满足） | L75 |
| `buildScopeIndex(tasks)` | 静态作用域索引 taskId → `{featureId, moduleId}`：review gate deps 内任务归该 feature，test gate deps 内任务归该 module；doc gate 不参与 | L100 |
| `filesConflict(a, b)` | plannedFiles 冲突：路径精确相同，或一方是另一方的目录前缀（尾斜杠归一） | L134 |
| `peekReadyTasks(state)` | 全部就绪任务（pending 且 deps 全 done），保持原始顺序；不做配额/冲突/独占过滤 | L159 |
| `selectReadyBatch(state, config)` | 确定性 greedy 选批：commit 独占优先；四级配额（max/maxModules/maxPerModule/maxPerFeature）；plannedFiles 冲突过滤；缺失 plannedFiles 且非 review 的任务不进并行批次（全缺失时取首个单独成批） | L178 |
| `isMilestoneDone(state)` | 全部任务 done 且 tasks.length > 0 | L233 |
| `gateFixMeta(gateTask)` | 门禁修复元数据 `{recheck, fixId}`；非门禁/非 blocked/无 verdict/verdict pass/达上限 → null | L251 |
| `spawnGateFixTask(state, gateTask, prompt)` | 纯 mutate：派生修复任务（kind=dev、pending、复制原 deps、plannedFiles=[]）+ 回退门禁待复审；不落盘（调用方 load/save） | L274 |
| `backupState(projectRoot)` | 快照 state 到 `.awf/versions/<version>-<ts>.json`（无 state/无 version 不备份） | L307 |
| `archiveOldStateForPlan(projectRoot)` | plan 启动守卫：残留旧 state 归档 `state-<ts>.json` 并重置空 plan 模板；run/pause 模式 → `run-active`；空 state → `none` | L330 |

### MCP 侧 `plugin/core/mcp/awf-state/server.cjs`

| 函数 | 说明 | 位置 |
|------|------|------|
| `readState()` / `writeState(s)` | store-core 优先读/写；无 store-core 的纯插件副本回退本地同语义实现 | L26 / L59 |
| `withStateLock(fn)` | 复用 `storeCore.withFileLock`（回退本地 `openSync 'wx'` + 超时） | L42 |
| `apply()` | 锁内 read → switch 分发 mutate → 写 | L402 |
| `handlers['tools/call']` | 只读工具与 mutation 分发，异常统一 catch | L385 |

## 接口 / 依赖

### CLI 侧 `src/lib/state.js`

| 模块 | 用途 |
|------|------|
| `./store-core.js` | `withFileLock`(as withStateLock) / `readJsonSync` / `writeJsonAtomicSync` — 单写序列化 + 原子写 |
| `node:path` / `node:fs` | 路径拼接；`backupState`/`archiveOldStateForPlan` 的 `mkdirSync` / `writeFileSync` |
| `./ui/log.js` | `logger`（当前未直接调用） |

### MCP 侧 `server.cjs`

| 模块 | 用途 |
|------|------|
| `../../../src/lib/store-core.cjs`（动态 require，失败降级） | `readJsonSync` / `writeJsonAtomicSync` / `withFileLock` |
| `node:fs` / `node:path` | 回退实现的读/写/锁；STATE_PATH / LOCK_PATH 拼接 |
| `node:http` | server 单写者模式（`GET /awf/state`、`POST /run/state/apply`） |

### 协议

| method | 说明 |
|--------|------|
| `initialize` | 返回 `protocolVersion: '2024-11-05'` + `capabilities.tools`（protocolVersion 见 `server.cjs:375`） |
| `tools/list` | 返回 20 个 tool 定义（含动态规划提交/查询） |
| `tools/call` | 按 `name` 分发（未知 tool → `{ ok:false, error:'unknown tool: <name>' }`） |
| 未知 method | `-32601 method not found` |

## 核心数据模型

`state.json` 根级字段（枚举值照 `server.cjs` 工具 schema 与 `state.js` 常量核对）：

```jsonc
{
  "mode": "idle",           // idle | plan | run | pause（awf_mode 枚举）
  "currentState": "IDLE",   // IDLE | PLAN | DESIGN | CODE | REVIEW | TEST | COMMIT | FINISH | DEBUG
  "version": "0.2.0",       // semver
  "lastUpdated": "ISO8601", // 写者自动维护
  "plan": {                 // awf_plan_configure（元数据，不含 tasks/wbs）
    "summary": "", "reqDoc": "", "hasUI": false,
    "inScope": [], "outOfScope": [], "acceptanceCriteria": []
  },
  "wbs":       [{ "id": "W1", "name": "", "desc": "", "acceptance": "", "deps": [] }],
  "tasks": [{
    "id": "T1",
    "title": "",
    "kind": "dev",          // dev | debug | review | test | doc | commit | ui-design | ui-code（默认 dev）
    "status": "pending",    // pending | active | done | blocked
    "wbsRef": "W1",         // 可选
    "deps": [],             // 依赖任务 ID
    "acceptance": "",
    "prompt": "",           // 命令 + task ID + 具体要做什么
    "plannedFiles": [],     // 相对路径，多 agent 冲突过滤；缺失 → 保守串行
    "constraints": [],       // 任务专属硬约束
    "exec": {               // awf_task_result / awf_task_complete 写入
      "result": "", "files": [],
      "verdict": { "level": "pass|changes_requested|fail", "conclusion": "" }, // 门禁任务
      "architecture": {},   // 架构判断/审查结论（awf_task_complete）
      "recheck": 1,         // 门禁复审轮次（spawnGateFixTask 递增，上限 MAX_RECHECK）
      "startedAt": "", "completedAt": ""
    },
    "commits": [{ "hash": "", "message": "" }],
    "blockedReason": ""     // 仅 status=blocked
  }],
  "milestones": [{ "id": "M1", "desc": "", "status": "active", "tasks": [] }] // status: active | done
}
```

- `tasks` / `wbs` / `milestones` 均在**根级**（不在 `plan` 下）。
- `kind=doc` 的 id 约束（`awf_task_create` 校验，`server.cjs:481-495`）：文档产出用 `T1-*`；项目文档门禁用 `T4-*` 且必须携带 `wbsRef: 'W4-*'`，同一 W4 只允许一个 T4 门禁。

## 20 个 MCP Tools

| # | Tool | Required | 行为 |
|---|------|----------|------|
| 1 | `awf_read_state` | — | 不传 `taskId` 返回完整 state；传 `taskId` 只返回该任务详情（未找到 → `ok:false`） |
| 2 | `awf_task_status` | `id,status` | 改 status（enum pending/active/done/blocked）；active 写 `exec.startedAt`，done/blocked 写 `exec.completedAt`，pending 清两者 |
| 3 | `awf_task_result` | `id` | 写 `exec.result` / `exec.files` |
| 4 | `awf_task_commit` | `id,hash,message` | 追加 `task.commits[]` |
| 5 | `awf_task_complete` | `id` | 原子提交 status + result + files + commits + verdict + architecture；status 缺省 done（可选 blocked，写 blockedReason） |
| 6 | `awf_task_create` | `id,title,prompt` | 创建任务，默认 status=pending、kind=dev；`prerequisiteFor` 可原子插入并重连目标依赖；kind=doc 走 id/wbsRef 校验 |
| 7 | `awf_task_update` | `id` | 只更新提供的字段；deps 拒绝缺失引用/环及 active 任务新增未完成依赖 |
| 8 | `awf_task_delete` | `id` | 无依赖者时删除；否则拒绝 |
| 9 | `awf_plan_configure` | — | 设置 `plan.*` 六字段（全可选） |
| 10 | `awf_wbs_create` | `id,name` | 追加根级 `wbs[]`，id 重复 → error |
| 11 | `awf_wbs_update` | `id` | 更新指定字段 |
| 12 | `awf_wbs_delete` | `id` | `splice` 删除 |
| 13 | `awf_phase` | `phase` | 设置 `state.currentState`（enum 见工具描述） |
| 14 | `awf_milestone_update` | `id,status` | status: active/done |
| 15 | `awf_mode` | `mode` | enum idle/plan/run/pause |
| 16 | `awf_version` | `version` | 设置 `state.version` |
| 17 | `awf_milestone_create` | `id,desc` | 追加 `milestones[]`，默认 status=active |
| 18 | `awf_milestone_delete` | `id` | `splice` 删除 |
| 19 | `awf_dynamic_plan` | `reason,operations` | server 侧局部动态规划；按配置自动应用或等待批准，高风险变化建立正式 decision_requested 并等待人工 resolve |
| 20 | `awf_dynamic_plan_status` | `proposalId` | 查询 proposal、影响闭包、ready 变化和应用状态 |

## 验收标准

- [ ] CLI/MCP/server 三端写同一 `.awf/state.json` 经同一 `state.lock` 互斥，无撕裂/丢更新
- [ ] server-mode MCP 陈旧整体快照因 CAS 冲突被拒绝，不覆盖其他写者的新状态
- [ ] 动态前置任务原子插到目标之前并自动重连；失败不留下半次 mutation
- [ ] `saveState` / `setWorkflowMode` / `markTaskActive` 的更新落盘后 `lastUpdated` 自动刷新
- [ ] `findNextTask` / `peekReadyTasks` / `selectReadyBatch` 对 deps、配额、plannedFiles 冲突、commit 独占的判定与 `state.js` 实现一致
- [ ] 门禁闭环：`spawnGateFixTask` 仅在 blocked + verdict 非 pass 且未达 `MAX_RECHECK` 时派生
- [ ] MCP `tools/list` 返回 20 个工具，未知 tool/method 分别返回 `ok:false` 与 `-32601`
- [ ] run/pause 阶段 task create/update/delete 不能绕过 server 动态规划能力
- [ ] `kind=doc` 的 `T1-*` / `T4-*` + `W4-*` 约束生效
