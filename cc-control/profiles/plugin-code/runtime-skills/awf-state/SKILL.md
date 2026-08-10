---
name: awf-state
description: >
  awf-state MCP 使用指南 + state.json 数据模型解释说明。
  覆盖 MCP 工具的使用场景和数据模型中核心字段/扩展字段/运行时字段/关联字段的定义。
  触发条件：需要读写 state.json、调用 awf-state MCP tools、理解状态字段含义时。
  引用方：awf-flow-exec-prompt, awf-sys-spec-workflow
---

# awf-state — MCP 使用指南 + 数据模型

## MCP Tools

### 状态 CRUD（直接文件 I/O）

| Tool | 用途 |
|------|------|
| `awf_read_state` | 读取完整 state.json |
| `awf_task_status` | 更新任务状态（pending/active/done/blocked） |
| `awf_task_result` | 记录执行结果和产出文件 |
| `awf_task_commit` | 追加 commit 记录 |
| `awf_task_create` | 创建任务 |
| `awf_task_update` | 更新任务字段 |
| `awf_task_delete` | 删除任务 |
| `awf_plan_configure` | 配置 Plan 元数据 |
| `awf_wbs_create` | 创建 WBS 项 |
| `awf_wbs_update` | 更新 WBS 项 |
| `awf_wbs_delete` | 删除 WBS 项 |
| `awf_phase` | 设置工作流阶段 |
| `awf_milestone_update` | 更新里程碑状态 |
| `awf_milestone_create` | 创建里程碑 |

### 使用原则

- state.json 只能通过 MCP tools 修改，禁止直接文件读写
- 每个 tool 有明确的写入范围和校验规则

---

## 数据模型

### 核心字段

TODO: 待 awf-sys-spec-task 定稿后填入

### 扩展字段

TODO

### 运行时字段

TODO

### 关联字段

TODO
