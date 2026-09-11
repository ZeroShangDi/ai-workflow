# w-state

通过 awf-state MCP tools 更新 `.awf/state.json`。MCP server 在 tmux session 启动时自动配置，无需手动 curl。

底层端点: `POST http://localhost:8787/awf/state`

## MCP Tools

所有 tools 自动从 `.mcp.json` 中注册，AI 可直接调用，无需记忆 curl 语法。

### awf_read_state
读取当前工作流完整状态（任务、里程碑、WBS、阶段等）
- `taskId` (string, 可选) — 任务 ID。传了则只返回该任务完整详情（含 `status` / `exec` / `commits`），判断任务状态或 exec 时用单查，避免全量读取
- 不传 `taskId` → 返回完整 state.json 内容

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
创建新任务；`prerequisiteFor` 是 plan/idle 阶段可用的底层原子插入参数，运行期改用 `awf_dynamic_plan`
- `id` (string, 必填) — 唯一任务 ID
- `title` (string, 必填) — 任务名（一句话）
- `prompt` (string, 必填) — 精简执行提示词（命令 + task ID + 具体要做什么）
- `wbsRef` (string, 可选) — 关联 WBS ID
- `deps` (string[], 可选) — 依赖任务 ID 列表
- `prerequisiteFor` (string, 可选) — 目标任务 ID；新任务插在目标之前并自动加入目标 deps（目标必须 pending）
- `constraints` (string[], 可选) — 任务专属硬约束；通用规则不重复写入
- `acceptance` (string, 可选) — 可验证的完成条件

### awf_dynamic_plan
运行期局部动态规划；一次提交完整变更集，由 server 计算位置、影响闭包和副作用
- `reason` (string, 必填) — 计划缺口及其与原目标的关系
- `operations` (object[], 必填) — `insert_task` / `edit_task` / `delete_task`
- `insert_task` 用 `relation: { type: "prerequisite_for", targetTaskId }` 表达语义位置，禁止传数组下标
- 返回 `applied_review_pending`、`awaiting_approval` 或 `decision_required`；后者会建立正式 decision，AI 只报告 ID 并等待人工 resolve，不得自行批准

### awf_dynamic_plan_status
按 `proposalId` 查询动态规划 proposal、影响分析和应用结果

### awf_task_update
更新任务字段（只更新提供的字段）
- `id` (string, 必填) — 任务 ID
- `title`, `prompt`, `wbsRef`, `deps`, `constraints`, `acceptance` (可选)
- 更新 `deps` 会校验缺失依赖和环；active 任务不能新增未完成依赖

### awf_task_delete
删除任务
- `id` (string, 必填) — 任务 ID
- 仍有任务依赖该任务时拒绝删除
- run/pause 阶段禁止直接调用 task create/update/delete；必须使用 `awf_dynamic_plan`

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

### awf_milestone_create
创建新里程碑
- `id` (string, 必填) — 里程碑 ID
- `desc` (string, 必填) — 里程碑描述
- `status` (string, 可选) — 初始状态，默认 `active`
- `tasks` (string[], 可选) — 关联任务 ID 列表

### awf_milestone_delete
删除里程碑
- `id` (string, 必填) — 里程碑 ID

### awf_version
更新 state.json 版本号
- `version` (string, 必填) — 新版本号，如 `0.1.4`

### awf_mode
设置工作流运行模式
- `mode` (enum, 必填) — `idle` | `plan` | `run` | `pause`

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
