# 状态管理

通过 awf-state MCP tools 更新 `.awf/state.json`。MCP server 在 tmux session 启动时自动配置，无需手动 curl。

底层端点: `POST http://localhost:8787/awf/state`

## MCP Tools

所有 tools 自动从 `.mcp.json` 中注册，AI 可直接调用，无需记忆 curl 语法。

### awf_read_state
读取当前工作流完整状态（任务、里程碑、WBS、阶段等）
- 参数: 无
- 返回: 完整 state.json 内容

### awf_task_status
更新任务状态
- `id` (string, 必填) — 任务 ID
- `status` (enum, 必填) — `pending` | `active` | `done` | `blocked`

### awf_task_result
记录任务执行结果和产出文件
- `id` (string, 必填) — 任务 ID
- `result` (string, 可选) — 执行结果描述
- `files` (string[], 可选) — 产出文件路径列表

### awf_task_commit
追加 commit 记录到任务
- `id` (string, 必填) — 任务 ID
- `hash` (string, 必填) — git commit hash
- `message` (string, 必填) — commit message

### awf_task_create
创建新任务
- `id` (string, 必填) — 唯一任务 ID
- `desc` (string, 必填) — 任务描述
- `prompt` (string, 必填) — 开发 prompt
- `wbsRef` (string, 可选) — 关联 WBS ID
- `deps` (string[], 可选) — 依赖任务 ID 列表

### awf_task_update
更新任务字段（只更新提供的字段）
- `id` (string, 必填) — 任务 ID
- `desc`, `prompt`, `wbsRef`, `deps` (可选)
- `complexity` (enum, 可选) — `simple` | `medium` | `complex`
- `featureGroup` (string, 可选) — 特性组 ID
- `phases` (string[], 可选) — 显式阶段链，覆盖 complexity 推导

### awf_task_delete
删除任务
- `id` (string, 必填) — 任务 ID

### awf_plan_configure
配置 Plan 元数据
- `summary` (string, 可选) — 项目摘要
- `reqDoc` (string, 可选) — 需求文档路径
- `hasUI` (boolean, 可选) — 是否有 UI
- `inScope` (string[], 可选) — 范围内事项
- `outOfScope` (string[], 可选) — 范围外事项
- `acceptanceCriteria` (string[], 可选) — 验收标准

### awf_wbs_create
创建 WBS 工作分解项
- `id` (string, 必填) — WBS ID
- `name` (string, 必填) — WBS 名称
- `desc`, `acceptance`, `deps` (可选)

### awf_wbs_update
更新 WBS 项
- `id` (string, 必填) — WBS ID
- `name`, `desc`, `acceptance`, `deps` (可选)

### awf_wbs_delete
删除 WBS 项
- `id` (string, 必填) — WBS ID

### awf_phase
设置当前工作流阶段
- `phase` (string, 必填) — `IDLE` | `PLAN` | `DESIGN` | `CODE` | `REVIEW` | `TEST` | `COMMIT` | `FINISH` | `DEBUG`

### awf_milestone_update
更新里程碑状态
- `id` (string, 必填) — 里程碑 ID
- `status` (enum, 必填) — `active` | `done`

### awf_milestone_update
更新里程碑状态
- `id` (string, 必填) — 里程碑 ID
- `status` (enum, 必填) — `active` | `done`

### awf_milestone_create
创建新里程碑
- `id` (string, 必填) — 里程碑 ID
- `desc` (string, 必填) — 里程碑描述
- `status` (string, 可选) — 初始状态，默认 `active`
- `tasks` (string[], 可选) — 关联任务 ID 列表

### awf_milestone_delete
删除里程碑
- `id` (string, 必填) — 里程碑 ID

### awf_mode
设置工作流运行模式
- `mode` (enum, 必填) — `idle` | `plan` | `run`

## 执行流程

每个阶段结束时：

1. 执行阶段工作
2. `awf_task_status` 标记任务为 `done`
3. 若有产出文件 → `awf_task_result` 记录
4. 若有 commit → `awf_task_commit` 追加
5. `awf_phase` 推进到下一阶段

## 只读回退（MCP 不可用时）

```bash
curl -s http://localhost:8787/awf/state
```

仅获取当前完整 state.json，不可通过 curl 做变更。
