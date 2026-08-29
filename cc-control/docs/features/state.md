# State 管理模块 — 需求文档

> 源码文件：`src/lib/state.js` + `plugin/core/mcp/awf-state/server.cjs`

---

## 架构概述

State 管理分为两层：

| 层 | 文件 | 运行环境 | 方式 | 用途 |
|-----|------|---------|------|------|
| CLI 侧 | `src/lib/state.js` | Node ESM | 直接 `fs` 读写 | `awf plan` / `awf run` 内部使用 |
| MCP 侧 | `plugin/core/mcp/awf-state/server.cjs` | 独立子进程 (stdio JSON-RPC) | `fs` 读写 | AI 通过 MCP tools 操作 state |

两层操作同一文件 `.awf/state.json`；写操作通过 `.awf/state.lock` 文件锁串行化，避免并发写坏（见 [3. 并发安全]）。

---

## 1. CLI 侧 (state.js)

### 函数

| 函数 | 说明 |
|------|------|
| `loadState(projectRoot)` | `fs.readFileSync` → `JSON.parse`，失败返回 `null` |
| `saveState(projectRoot, state)` | 自动创建 `.awf/` 目录，写 `lastUpdated`，`JSON.stringify` 缩进 2 空格；写前取 `.awf/state.lock` 锁（与 MCP 共用） |
| `findNextTask(state)` | 取根级 `state.tasks`，找第一个 status=pending 且 deps 满足的任务 |
| `getNextTask(state)` | `findNextTask` 别名 |
| `getCurrentPhase(projectRoot)` | `loadState` → `state?.currentState \|\| null` |
| `isMilestoneDone(state)` | 所有 task status=done 且 tasks.length>0 |
| `backupState(projectRoot)` | run 全部完成后，快照 state.json 到 `.awf/versions/<version>-<ts>.json` |

### 任务/WBS 位置

`tasks` 和 `wbs` 统一放在 state.json **根级**（不再放 `plan` 下）。`plan` 只保留元数据（summary/reqDoc/hasUI/inScope/outOfScope/acceptanceCriteria）。

### 多 agent 调度辅助

| 函数 / 常量 | 说明 |
|------|------|
| `EXCLUSIVE_KINDS` | 独占任务类型集合（`doc` / `commit`），此类任务必须单独成批，不与任何任务并行 |
| `buildScopeIndex(tasks)` | 静态作用域索引：taskId → `{ featureId, moduleId }`。review gate 的 deps 内任务归该 feature（featureId=review gate id），test gate 的 deps 内任务归该 module（moduleId=test gate id）；doc gate（deps=全部任务）不参与 |
| `filesConflict(a, b)` | plannedFiles 冲突判定：路径精确相同，或一方是另一方的目录前缀（如 `src/util/` vs `src/util/math.js`） |
| `peekReadyTasks(state)` | 所有就绪任务（pending 且 deps 全 done），保持 state 原始顺序。不做配额/文件冲突/独占过滤——由滑动窗口调度器运行时判断 |
| `selectReadyBatch(state, config)` | 确定性 greedy 选一批可并行任务：doc/commit 独占成批优先；四级配额（max / maxModules / maxPerModule / maxPerFeature）打包；plannedFiles 冲突过滤；缺失 plannedFiles 且非 review 的任务不进并行批次 |

---

## 2. MCP 侧 (server.cjs)

### 运行时

- CommonJS（`require`）
- `process.stdin` 读 JSON-RPC 行
- `process.stdout` 写 JSON-RPC 响应
- `process.stderr` 写日志
- `AWF_PROJECT_ROOT` 环境变量指定项目根目录（默认 `cwd`）
- 直接文件 I/O，无 HTTP 依赖
- 写操作通过 `.awf/state.lock` 与 CLI 侧共用文件锁（见 [3. 并发安全]）

### JSON-RPC 协议

| method | 说明 |
|--------|------|
| `initialize` | 返回 `protocolVersion: '2024-11-05'` + `capabilities.tools` |
| `tools/list` | 返回 18 个 tool 定义 |
| `tools/call` | 根据 `name` 分发到具体 handler |
| `notifications/initialized` | 客户端就绪通知，无响应 |

### 通用模式

除 `awf_read_state` 外，所有 mutation tool 遵循：

```
readState() → 找到目标对象 → 修改 → writeState(s) → 返回 { ok: true, tool: name }
```

异常统一 catch 返回 `{ ok: false, error: err.message }`。

---

## 3. 并发安全（state.lock）

CLI（`saveState`）与 MCP（`writeState`）可能并发写同一 `state.json`，直接整文件覆写会撕裂 / 竞态。两者共用 `.awf/state.lock` 文件锁串行化写操作：

- **原子创建**：`fs.openSync(LOCK_PATH, 'wx')`（O_EXCL）成功才持有锁；`EEXIST` 说明被占用，进入重试
- **重试**：50ms 间隔轮询，5s 超时抛 `state lock timeout`
- **释放**：`finally` 中 `unlinkSync` 删除锁文件
- **读不持锁**：仅写操作加锁；读改写丢更新由写者收敛兜底（多 agent 下主 Agent 独写）

---

## 4. 18 个 MCP Tools 详解

### 只读

| Tool | 参数 | 行为 |
|------|------|------|
| `awf_read_state` | 无 | 读取并返回完整 state.json |

### 任务管理

| Tool | Required | 行为 |
|------|----------|------|
| `awf_task_status` | `id, status` | 更新 `task.status`，id 不存在→error |
| `awf_task_result` | `id` | 写入 `task.exec.result` 和 `task.exec.files`，id 不存在→error |
| `awf_task_commit` | `id, hash, message` | 追加 `task.commits[]`，id 不存在→error |
| `awf_task_complete` | `id` | 原子完成一个任务：一次提交 status + exec.result + exec.files + commits + verdict（替代多次 status/result/commit 调用，避免落账中间态）。status 缺省 `done`，可选 `blocked`（写 blockedReason）；`verdict`（可选 object）写 `exec.verdict`（门禁判定，如 `{ level: "pass|changes_requested|fail", conclusion: "..." }`）；id 不存在→error |
| `awf_task_create` | `id, title, prompt` | 创建任务，id 重复→error，默认 status=pending、kind=dev；支持 kind（dev/review/test/doc，门禁任务必须标注）与 plannedFiles（规划改动文件，多 agent 冲突过滤用） |
| `awf_task_update` | `id` | 只更新提供的字段（title/kind/plannedFiles/prompt/wbsRef/deps/acceptance，undefined 不覆盖），id 不存在→error |
| `awf_task_delete` | `id` | `splice` 删除，id 不存在→error |

### Plan 配置

| Tool | Required | 行为 |
|------|----------|------|
| `awf_plan_configure` | 无（全可选） | 设置 `plan.summary / reqDoc / hasUI / inScope / outOfScope / acceptanceCriteria` |

### WBS 管理

| Tool | Required | 行为 |
|------|----------|------|
| `awf_wbs_create` | `id, name` | 追加到根级 `wbs[]`，id 重复→error |
| `awf_wbs_update` | `id` | 更新指定字段，id 不存在→error |
| `awf_wbs_delete` | `id` | `splice` 删除，id 不存在→error |

### 里程碑

| Tool | Required | 行为 |
|------|----------|------|
| `awf_milestone_create` | `id, desc` | 追加到 `milestones[]`，id 重复→error，默认 status=active |
| `awf_milestone_update` | `id, status` | status: active/done，id 不存在→error |
| `awf_milestone_delete` | `id` | `splice` 删除，id 不存在→error |

### 全局字段

| Tool | Required | 行为 |
|------|----------|------|
| `awf_phase` | `phase` | 设置 `state.currentState` |
| `awf_mode` | `mode` | 设置 `state.mode`（idle/plan/run） |
| `awf_version` | `version` | 设置 `state.version` |

---

## 5. state.json Schema

```jsonc
{
  "mode": "idle",               // idle | plan | run
  "currentState": "IDLE",       // IDLE | PLAN | DESIGN | CODE | REVIEW | TEST | COMMIT | FINISH | DEBUG
  "version": "0.1.0",           // semver
  "lastUpdated": "ISO8601",     // 自动维护
  "plan": {
    "summary": "项目摘要",
    "reqDoc": "docs/features/xxx.md",
    "hasUI": false,
    "inScope": ["事项1"],
    "outOfScope": ["事项2"],
    "acceptanceCriteria": ["标准1"]
  },
  "wbs": [
    {
      "id": "W1",
      "name": "名称",
      "desc": "描述",
      "acceptance": "验收标准",
      "deps": []
    }
  ],
  "tasks": [
    {
      "id": "T1",
      "title": "任务标题",
      "kind": "dev",            // dev | review | test | doc（门禁任务必须标注）
      "wbsRef": "W1",           // 关联 WBS ID（可选）
      "status": "pending",      // pending | active | done | blocked
      "deps": [],               // 依赖任务 ID
      "acceptance": "验收标准",
      "prompt": "开发 prompt",
      "plannedFiles": ["src/util/a.js"],  // 规划改动文件（相对路径，冲突过滤用）
      "exec": {                 // awf_task_result / awf_task_complete 写入
        "result": "...",
        "files": ["..."],
        "verdict": {            // 门禁任务（review/test）判定，CLI 据 level!=='pass' 派生修复
          "level": "changes_requested", // pass | changes_requested | fail
          "conclusion": "..."
        },
        "recheck": 1            // 门禁复审轮次（spawnGateFixTask 递增，上限 MAX_RECHECK=3）
      },
      "commits": [              // awf_task_commit / awf_task_complete 写入
        { "hash": "abc1234", "message": "feat: ..." }
      ],
      "blockedReason": "..."    // 仅 status=blocked 时写入
    }
  ],
  "milestones": [
    {
      "id": "M1",
      "desc": "里程碑描述",
      "status": "active",         // active | done
      "tasks": ["T1", "T2"]      // 关联任务 ID
    }
  ]
}
```

---

## 6. 依赖

### CLI 侧

| 模块 | 用途 |
|------|------|
| `node:path` | 拼接 `.awf/state.json` 路径 |
| `node:fs` | readFileSync, writeFileSync, existsSync, mkdirSync, openSync/unlinkSync（state.lock 写锁） |
| `./ui/log.js` | 导入 `logger`（当前未直接调用） |

### MCP 侧

| 模块 | 用途 |
|------|------|
| `node:fs` (require) | readFileSync, writeFileSync, openSync/unlinkSync（state.lock 写锁） |
| `node:path` (require) | 拼接 STATE_PATH / LOCK_PATH |
| `process.env.AWF_PROJECT_ROOT` | 项目根目录 |
