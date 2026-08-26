# 多 Agent 模式（定稿）

- 日期：2026-08-26
- 状态：**已定稿（方案 C）**，M1 实现中
- 相关分支：feature/cc-control-v0.1.3

## 1. 目标

`awf run` 支持多 agent 并行执行任务；单 / 多 agent 通过 `.awf/config.json` 切换（`run.agents`，默认 `max: 1` = 现状零变化），不加 CLI 旗标。

## 2. 决策记录

- 早期提出两条路线：A（多 tmux + CLI 中央调度）与 B（单 tmux + 原生子 Agent + AI 编排）。
- **关键澄清**：「调用原生子 Agent」≠「调度权交给 AI」。CLI 可以继续掌握调度策略与任务状态机，原生子 Agent 只是执行载体。
- **定稿：方案 C = 单 tmux + 原生子 Agent + CLI 中央调度**。保留路线 B 的单会话、低基础设施改动，同时 DAG / 门禁 / 配额 / 并发策略全部由 CLI 决定。

## 3. 架构

```
CLI（调度权所有者）
 ├─ 读 .awf/config.json → run.agents 配额
 ├─ 按门禁图 + deps + 配额选择 ready 批次（批次屏障：整批结束才调度下一批）
 ├─ 置 active + batchId → 构造 batch 编排 prompt → /send
 └─ 主 Stop 后重读 state → reconcile 整批
          │
          ▼
主 Agent（执行适配器，skill 约束）
 ├─ 按 CLI 清单在同一轮并行调用原生 Agent 工具（每个子 Agent 一个 task）
 ├─ 等所有子 Agent 返回（不得后台遗留）
 ├─ 通过 MCP 统一写回 state（主 Agent 独写）
 └─ 需要决策 → 聚合后经 awf_await_choice/input 问用户 → 落账 → Stop
          │
          ▼
子 Agent（纯执行）
 ├─ 只执行分到的 task.prompt，返回结构化结果
 ├─ 不写 state、不自行选择任务、不直接 AskUserQuestion
 └─ 遇到阻塞 → 返回 needs_input，由主 Agent 上抛
```

## 4. 已确认约束（用户）

1. 同质池，不拆分角色；调度器把任务派给任意空闲 agent。
2. 并行粒度基于 plan 的门禁图：任务级（功能内最多 1 agent）→ 功能 review gate → 模块 test gate；review/test 在各层可并行，但模块内功能全部 review 完才 test。
3. 配置化四级硬限制（`.awf/config.json`）：总 Agent 数 / 同时活跃模块数 / 每模块 Agent 数 / 每功能 Agent 数。示例 `9/3/3/1`。
4. 批次屏障：整批完成后再调度下一批（第一版不做动态补位）。
5. 配置入口仅 `.awf/config.json`。

## 5. 调度模型

### 门禁层级识别

plan 已生成门禁图（普通任务 → review gate → test gate，以 `deps` 表达）。task 新增结构化字段 `kind`（`dev` / `review` / `test` / `doc` / `commit`），CLI 只读结构化字段，不解析任何插件命令字符串。

作用域索引由 `kind` + `deps` 静态构建：
- review gate 的 deps 内 dev 任务 → 属该功能
- test gate 的 deps 内 review gates → 属该模块（其下 dev 任务随之归模块）

### 批次选择（CLI 确定性 greedy）

1. ready 集合 = `pending` 且 `deps` 全部 `done`
2. `doc` / `commit` 独占成批
3. 四级配额打包：`max` / `maxModules` / `maxPerModule` / `maxPerFeature`（保持 state 原始顺序，确定性）
4. 无 ready → 区分「全部完成」与「DAG 死锁」

### 配置 schema

```json
{
  "run": {
    "agents": {
      "max": 9,
      "maxModules": 3,
      "maxPerModule": 3,
      "maxPerFeature": 1
    }
  }
}
```

缺失字段用默认值（均默认 1）；`src/lib/run-config.js` 统一加载/校验。

## 6. 批次协议

- CLI 派发前置选中任务 `active` + 记 `batchId`（防重派 / 超时可恢复），随后发送 batch 编排 prompt（`prompts.json` 模板 + `plugin-bridge` 填充）。
- 子 Agent 返回固定形状：`{ taskId, status: succeeded|blocked|needs_input, result, files, tests, commits }`。
- 主 Agent 聚合后经 MCP 落账；CLI 在主 Stop 后逐任务校验本批，未完成的任务按规则恢复 `pending` 或标 `blocked`（不遗留不可重选的 `active`）。
- 决策：子 Agent 不直接提问，返回 `needs_input` 上抛主 Agent，主 Agent 统一 `awf_await_choice/input`。

## 7. hooks 观测（可观测，非调度必需）

- 生命周期 hook 改 stdin 透传（`?event=` + `-d @-`），server 记录 `mainSessionId`。
- `UserPromptSubmit` / `Stop` 只认主 session_id 驱动 ready/busy 闩锁（**闩锁语义，不做引用计数**——子 Agent busy 永不归零）。
- 注册 `SubagentStart` / `SubagentStop` → 只进 agent registry 观测，不驱动主闩锁。
- `taskId ↔ agent_id` 不做映射（批次屏障下非必需）。

## 8. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1** 调度骨架 ✅ | 本文档定稿 + `run-config.js` + task `kind` + 批次选择器 + runBatchLoop + batch 模板 + eval 全真用例 | `max:1` 零变化；DAG wave 并行；单测/E2E/eval |
| **M2** hooks 观测 ✅ | 生命周期 hook 改 stdin 透传（server 记录 `mainSessionId`）+ `UserPromptSubmit`/`Stop` 只认主 session 驱动闩锁 + 注册 `SubagentStart/Stop` 进 agent registry（不驱动闩锁）+ `/status` 暴露 `mainSessionId`/`activeAgents` | 主 session 隔离；子 agent 事件不影响 ready/busy |
| **M3** 状态原子化 ✅ | awf-state 新增 `awf_task_complete`（一次提交 status+result+files+commits，替代 3 次调用防中间态）+ state 文件锁（CLI `saveState` 与 MCP `writeState` 共用 `.awf/state.lock`）。batch-submit / 批处理 skill 强化延后 | 落账原子化；并发写加锁防丢更新 |
| **M4** plannedFiles 冲突过滤 ✅ | plan 侧 `plannedFiles` 字段（awf-plan-tasks + awf-state MCP）+ 调度按文件集不相交过滤；**缺失即串行**（review 只读门禁天然可并行） | 冲突任务不同批 |
| **M5** 决策上抛（独立） | 子 Agent `needs_input` → 主 Agent 统一 `awf_await_choice/input` 的归属路由机制（单独设计+实现） | 子 Agent 不直接问用户，决策上抛主 Agent |

## 9. 开放问题（M3+）

- 主 Agent 批处理 skill 的可靠性兜底：CLI 心跳 / 超时监督的深度。
- 多 agent 同时 `await_choice/input` 的归属标注与路由（M5 决策上抛的并发面）。
