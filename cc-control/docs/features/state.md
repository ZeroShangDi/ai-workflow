# State 管理模块 — 需求文档

> 源码文件：`src/cli/state.js` + `src/mcp/awf-state/server.cjs`

---

## 架构概述

State 管理分为两层：

| 层 | 文件 | 运行环境 | 方式 | 用途 |
|-----|------|---------|------|------|
| CLI 侧 | `src/cli/state.js` | Node ESM | 直接 `fs` 读写 | `awf plan` / `awf run` 内部使用 |
| MCP 侧 | `src/mcp/awf-state/server.cjs` | 独立子进程 (stdio JSON-RPC) | `fs` 读写 | AI 通过 MCP tools 操作 state |

两层操作同一文件 `.awf/state.json`，互不感知。

---

## 1. CLI 侧 (state.js)

### 函数

| 函数 | 说明 |
|------|------|
| `loadState(projectRoot)` | `fs.readFileSync` → `JSON.parse`，失败返回 `null` |
| `saveState(projectRoot, state)` | 自动创建 `.awf/` 目录，写 `lastUpdated`，`JSON.stringify` 缩进 2 空格 |
| `findNextTask(state)` | 双位置兼容：取 `state.plan.tasks` \|\| `state.tasks`，找第一个 status=pending 且 deps 满足的任务 |
| `getNextTask(state)` | `findNextTask` 别名 |
| `getCurrentPhase(projectRoot)` | `loadState` → `state?.currentState \|\| null` |
| `isMilestoneDone(state)` | 所有 task status=done 且 tasks.length>0 |

### 双位置兼容

`findNextTask` 和 `isMilestoneDone` 均按优先级读取：

```
state.plan.tasks → state.tasks → []
```

`state.plan.tasks` 优先（v0.1.3+ 新格式），`state.tasks` 为旧格式兼容。

---

## 2. MCP 侧 (server.cjs)

### 运行时

- CommonJS（`require`）
- `process.stdin` 读 JSON-RPC 行
- `process.stdout` 写 JSON-RPC 响应
- `process.stderr` 写日志
- `AWF_PROJECT_ROOT` 环境变量指定项目根目录（默认 `cwd`）
- 直接文件 I/O，无 HTTP 依赖

### JSON-RPC 协议

| method | 说明 |
|--------|------|
| `initialize` | 返回 `protocolVersion: '2024-11-05'` + `capabilities.tools` |
| `tools/list` | 返回 17 个 tool 定义 |
| `tools/call` | 根据 `name` 分发到具体 handler |
| `notifications/initialized` | 客户端就绪通知，无响应 |

### 通用模式

除 `awf_read_state` 外，所有 mutation tool 遵循：

```
readState() → 找到目标对象 → 修改 → writeState(s) → 返回 { ok: true, tool: name }
```

异常统一 catch 返回 `{ ok: false, error: err.message }`。

---

## 3. 17 个 MCP Tools 详解

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
| `awf_task_create` | `id, desc, prompt` | 创建任务，id 重复→error，默认 status=pending, complexity=medium |
| `awf_task_update` | `id` | 只更新提供的字段（undefined 不覆盖），id 不存在→error |
| `awf_task_delete` | `id` | `splice` 删除，id 不存在→error |

### Plan 配置

| Tool | Required | 行为 |
|------|----------|------|
| `awf_plan_configure` | 无（全可选） | 设置 `plan.summary / reqDoc / hasUI / inScope / outOfScope / acceptanceCriteria` |

### WBS 管理

| Tool | Required | 行为 |
|------|----------|------|
| `awf_wbs_create` | `id, name` | 追加到 `plan.wbs[]`，id 重复→error |
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

## 4. state.json Schema

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
    "acceptanceCriteria": ["标准1"],
    "wbs": [
      {
        "id": "W1",
        "name": "名称",
        "desc": "描述",
        "acceptance": "验收标准",
        "deps": []
      }
    ],
    "tasks": [                    // v0.1.3+ 主位置
      {
        "id": "T1",
        "desc": "任务描述",
        "prompt": "开发 prompt",
        "status": "pending",      // pending | active | done | blocked
        "complexity": "medium",   // simple | medium | complex
        "deps": [],               // 依赖任务 ID
        "wbsRef": "W1",           // 关联 WBS ID（可选）
        "featureGroup": null,     // 特性组 ID（可选）
        "phases": null,           // 显式阶段链（可选）
        "exec": {                 // awf_task_result 写入
          "result": "...",
          "files": ["..."]
        },
        "commits": [              // awf_task_commit 写入
          { "hash": "abc1234", "message": "feat: ..." }
        ]
      }
    ]
  },
  "tasks": [],                   // 旧格式兼容（v0.1.2 及之前）
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

## 5. 依赖

### CLI 侧

| 模块 | 用途 |
|------|------|
| `node:path` | 拼接 `.awf/state.json` 路径 |
| `node:fs` | readFileSync, writeFileSync, existsSync, mkdirSync |
| `./logger.js` | 无（CLI 侧 state.js 不依赖 logger） |

### MCP 侧

| 模块 | 用途 |
|------|------|
| `node:fs` (require) | readFileSync, writeFileSync |
| `node:path` (require) | 拼接 STATE_PATH |
| `process.env.AWF_PROJECT_ROOT` | 项目根目录 |
