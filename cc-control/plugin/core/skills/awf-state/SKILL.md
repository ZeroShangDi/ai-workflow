---
name: awf-state
description: >
  awf-state MCP 使用指南 + state.json 数据模型。
  覆盖 MCP 工具的使用场景和 state.json 中任务/WBS/plan 元数据/milestones 字段定义。
  触发条件：需要读写 state.json、调用 awf-state MCP tools、理解状态字段含义时。
---

# awf-state — MCP 使用指南 + 数据模型

## MCP Tools

### 状态 CRUD（直接文件 I/O）

| Tool | 用途 |
|------|------|
| `awf_read_state` | 读取状态（默认完整 state；判断任务状态/exec 时传 `taskId` 单查） |
| `awf_task_status` | 更新任务状态（pending/active/done/blocked） |
| `awf_dynamic_plan` | 运行期提交局部动态规划 proposal，由 server 处理影响与副作用 |
| `awf_dynamic_plan_status` | 查询动态规划 proposal 状态和分析结果 |
| `awf_task_result` | 记录执行结果和产出文件 |
| `awf_task_commit` | 追加 commit 记录 |
| `awf_task_create` | 创建任务；`prerequisiteFor` 可原子插到目标之前并自动连依赖 |
| `awf_task_update` | 更新任务字段；deps 会校验缺失引用、环和 active 任务安全性 |
| `awf_task_delete` | 删除无依赖者的任务 |
| `awf_plan_configure` | 配置 Plan 元数据 |
| `awf_wbs_create` | 创建 WBS 项 |
| `awf_wbs_update` | 更新 WBS 项 |
| `awf_wbs_delete` | 删除 WBS 项 |
| `awf_phase` | 设置工作流阶段 |
| `awf_milestone_update` | 更新里程碑状态 |
| `awf_milestone_create` | 创建里程碑 |
| `awf_milestone_delete` | 删除里程碑 |
| `awf_mode` | 设置运行模式（idle/plan/run/pause） |
| `awf_version` | 更新 state.json 版本号 |

### 使用原则

- state.json 只能通过 MCP tools 修改，禁止直接文件读写
- 每个 tool 有明确的写入范围和校验规则
- 判断任务状态或 exec 时，用 `awf_read_state` 传 `taskId` 单查该任务，不要全量读取整个 state.json
- plan/idle 阶段可用 `awf_task_create({ prerequisiteFor: targetId, ... })`；运行中发现新的前置工作必须提交 `awf_dynamic_plan`，禁止先 append 再单独更新目标 deps
- active 目标不会被系统自动撤销；先由人决定如何停止/重派，再把目标恢复为 pending 后插入前置任务
- run/pause 阶段禁止用 `awf_task_create/update/delete` 拼接结构变更，统一调用 `awf_dynamic_plan`
- 动态规划的执行方式由 `run.dynamicPlanning.mode` 决定：`auto_then_review` 或 `approve_then_apply`
- 返回 `decision_required` 时只报告 proposal/decision ID 并等待人工处理；不得调用普通 approve/reject 或直接改 state 绕过正式 decision

---

## 数据模型

### 任务（task）

任务 schema 的权威定义在 plugin-code 的 `awf-plan-tasks` skill。此处列 state.json 中实际出现的字段：

| 字段 | 说明 |
|------|------|
| `id` / `title` / `kind` / `wbsRef` / `deps` / `plannedFiles` / `constraints` / `acceptance` / `prompt` | 规划时写入（见 awf-plan-tasks） |
| `status` | `pending` / `active` / `done` / `blocked` |
| `exec.result` / `exec.files` | 运行时写入（CODE 阶段） |
| `exec.architecture` | 开发路径判断或架构审查结论（变化轴、权威边界、路径、关键取舍） |
| `commits[]` | 运行时写入（COMMIT 阶段） |

任务数组位置：根级 `tasks`。

### WBS

WBS 数组位于根级 `wbs`。

| 字段 | 说明 |
|------|------|
| `id` / `name` / `desc` / `acceptance` / `deps` | WBS 工作分解项 |

### Plan 元数据

`plan` 只承载规划元数据：`summary` / `reqDoc` / `hasUI` / `inScope` / `outOfScope` / `acceptanceCriteria`

### Milestones

| 字段 | 说明 |
|------|------|
| `id` / `desc` / `status` / `tasks[]` | 里程碑（`status`: `active` / `done`） |
