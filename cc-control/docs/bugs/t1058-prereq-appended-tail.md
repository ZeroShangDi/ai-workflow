# awf 运行中插入前置任务缺少原子重排/重派发协议

- 状态: 核心修复已实现；deferred/superseded 与自动撤销重派仍待产品决策（2026-09-11 更新）
- 关联: T1-058（`run.js 改提交/订阅/应答` 需要一个前置 T1-105）、T3-005（依赖 T1-104）
- 类型: awf 产品缺陷（运行中重规划/任务契约），非单纯数组排序问题

## 现象

1. 规划/执行中发现 T1-058 需要先做前置任务，用 `awf_task_create` 新建（T1-105、T1-104）。
2. `awf_task_create` 只能 **append 到任务数组末尾**，没有插入位置或“替换当前派发”的事务能力。
3. 当时 `T1-058` 已经被派发；即使新增 `T1-105` 并把它写成 `T1-058` 的依赖，当前回合也不会自动撤销并改派前置任务，必须安全结束当前回合并重启/恢复编排器。
4. 为解除阻塞，现场一度把“推迟但未实现”的 `T1-058` 标为 done，导致依赖状态与真实验收不一致。

本次恰好两处，均为队尾任务被前面任务依赖：

- `T1-058 deps[T1-105]`，而 T1-105 在 idx 134（队尾）
- `T3-005 deps[T1-104]`，而 T1-104 在 idx 133（队尾）

手工重排后已无前向依赖（135 任务），当前就绪链为 `T1-105 → T1-058 → T1-059…`。

## 根因

- `awf_task_create` 只 `state.tasks.push`，缺少 `insertBefore`/拓扑重排能力。
- 更关键的是，运行中修改当前任务的依赖没有 CAS/版本检查、撤销当前派发、重新选取 ready task 的协议。
- 任务状态没有 `deferred/superseded` 等不满足依赖但可明确表达计划变更的语义，诱发用 `done` 冒充“已处理”。

复核说明：当前 `findNextTask` 与 `runScheduler` 都会重新扫描所有 pending 且依赖已 done 的任务，因此“队尾前置会被永久跳过”并非当前实现的准确根因；数组顺序只影响 ready task 的优先级。问题发生在已派发回合和状态变更之间缺少原子协调。

## 必改方向（明日确定，选一或多）

1. `awf_task_create`/`awf_task_update` 支持 `insertBefore` 或稳定拓扑重排，并在写入时校验缺失依赖与环。
2. 对“当前 active 任务新增未完成依赖”拒绝写入，或提供原子 `supersede/requeue`：结束当前派发、改回 pending、重排后再选任务。
3. 增加状态版本/CAS，避免 CLI 与会话同时基于旧快照落账。
4. 禁止把未满足 acceptance 的任务标 done；若需要延期，使用明确的计划变更状态或从当前里程碑移出并重连依赖。
5. 增加回归测试：运行中为 active 任务插入前置任务后，下一个执行必须是前置任务，原任务不能提前完成或被静默跳过。

## 2026-09-11 实现结果

本次选择“pending/blocked 目标可原子插入；active 目标拒绝写入”的保守协议，没有自动中断执行者：

- `src/lib/task-graph.cjs` 提供完整图校验、`insertPrerequisiteTask`、安全依赖替换和安全删除；
- `awf_task_create.prerequisiteFor` 将创建、插入目标之前和目标依赖重连合并成一次 mutation；
- `spawnGateFixTaskAtomic` 在统一 `state.lock` 内重新读取并派生修复任务，避免并发生成重复 F 任务；
- `markTaskActive` 在实际派发前校验整张任务图；
- active 任务不能新增未完成依赖，也不能成为 `prerequisiteFor` 的目标；
- server-mode MCP 写入携带 `lastUpdated` 和 state SHA-256 指纹，server 在锁内比较后再写；冲突返回 `409`；
- MCP 工具返回 `ok:false` 时不执行整体回写；
- 回归测试覆盖插入顺序、调度不可越过、缺失依赖、环、重复边、自依赖、active 拒绝、依赖者删除拒绝、门禁并发去重和 stale snapshot CAS。

方向 4 中的 `deferred/superseded` 状态与“原子撤销当前派发再重派”没有在本次自动化；它们会改变执行所有权，需先确定由系统还是人发起。当前不会再用 `done` 伪装这种计划变更，遇到 active 任务前置缺口时会明确失败并要求人工处理。

后续已把上述原语提升为独立的动态任务规划能力：运行期结构变更统一通过 `awf_dynamic_plan → server/dynamic-planning`，由 server 处理位置、影响闭包、副作用、执行模式、proposal 和记录；详见 `docs/discuss/dynamic-task-planning-capability.md`。
