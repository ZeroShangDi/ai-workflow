# 动态任务规划能力设计

> 状态：核心实现与自动化测试已通过；**两组真机证据均已落地**（见 §9）。仍未把它标记为「完成」——
> v1 的延后项（§10）与 decision 侧的同等改造尚未收口。
> 日期：2026-09-11

## 主要信息摘要

1. 动态任务规划不是整张计划重做，而是一次“局部动态规划 + 影响闭包计算 + 副作用处理”。
2. 它是与 decision 同级的 server 能力；`awf-state` MCP 只负责向 AI 暴露薄协议。
3. 一次调整是一个原子 proposal，不允许 AI 用连续 create/update/delete 自己拼事务。
4. 支持 `auto_then_review` 与 `approve_then_apply` 两种项目级执行模式。
5. “钩子”按架构预埋点理解：稳定协议、proposal 数据、配置、服务边界、记录目录和可替换扩展上下文均需预留；函数回调只是其中一种实现。
6. 自动模式不等于可以改变目标：删除任务、删除依赖、改变 acceptance/kind/wbsRef/prompt、移除约束或规划文件会进入正式 `decision_requested`，等待人工结论。
7. 当前项目显式配置为 `approve_then_apply`，与本轮全程人工控制要求一致。
8. 单元、集成和构建通过只代表实现可进入实测；新增真实测试通过之前，不得把本功能标记为完成。

## 1. 能力定义

动态任务规划用于已有 `state.json`、任务已经规划完成甚至正在执行时，补齐或调整局部任务计划。调用者表达“需要什么关系”，server 负责：

- 决定任务在稳定任务序列中的位置；
- 计算直接和传递影响任务；
- 调整 dependency、milestone 和 ready 集合；
- 保护 active/done 历史和原始验收目标；
- 按配置自动应用或等待人工批准；
- 留下可供未来复审系统消费的 proposal 与事件记录。

它不负责重新生成整份 WBS，也不允许借“动态规划”降低原始范围或技术目标。

## 2. 为什么是独立能力

历史事故不是单个 `tasks.push()` 的错误，而是没有“补缺口”的能力：

- 缺少模块对接任务时，执行者删除了已经拆好的模块，退回千行单文件，直接损失服务器拆分目标；
- 前端缺依赖和 dist 时，执行者没有补“安装依赖 → 构建 → 验证产物”任务，而是放弃 React 架构、退回 HTML；
- 门禁修复任务追加到队尾、目标依赖未同步，使后续任务越过真实前置任务；
- 多次单点 state 写基于旧快照，存在把其他执行者新状态覆盖掉的风险。

共同根因是：执行者遇到计划缺口时，只能修改代码或调用低层 CRUD，没有一个保护原目标、计算副作用并原子改变计划的正式入口。

## 3. 架构边界

```text
运行中的 AI
  │
  │ awf_dynamic_plan / awf_dynamic_plan_status
  ▼
awf-state MCP（薄传输，不实现规划语义）
  │
  │ HTTP + projectRoot
  ▼
src/server/dynamic-planning/
  ├── config.cjs      两种执行模式与扩展配置空间
  ├── planner.cjs     局部规划、影响闭包和副作用展开
  ├── service.cjs     proposal、执行策略、锁和 CAS
  ├── store.cjs       proposal 与追加事件记录
  ├── decision-port.cjs  到既有 DecisionStore 的适配边界
  └── index.cjs       server 能力出口
  │
  ▼
.awf/state.json + .awf/dynamic-planning/
```

运行或暂停状态下，`awf_task_create/update/delete` 会被拒绝；结构调整必须进入 `awf_dynamic_plan`。plan/idle 阶段保留基础 CRUD，用于初始规划和离线维护。

## 4. 两种执行模式

项目配置：

```json
{
  "run": {
    "dynamicPlanning": {
      "mode": "approve_then_apply",
      "extensions": {}
    }
  }
}
```

### `auto_then_review`

- server 分析并验证 proposal；
- 安全的局部补任务自动原子应用；
- proposal 进入 `applied_review_pending`；
- `review.status=pending`，供未来复审器/UI 接入；
- 高风险调整仍进入 `decision_required`，并自动建立正式 decision，不会因为自动模式而改变原目标。

### `approve_then_apply`

- server 只保存 proposal，状态为 `awaiting_approval`；
- 任务计划本身不变，但会在 state 控制区写入该 proposal 的 execution hold；
- hold 覆盖直接受影响任务及其下游闭包，未受影响的并行任务仍可继续；
- 人工批准端点在锁内做**双检**：先比「受影响闭包的结构指纹 + `plan.acceptanceCriteria`」，
  再基于**最新 state** 用当初的 operations 重放一次，写出去的是重放结果；
- 只有**相关前提真的变了**（闭包内任务被改动、目标不再 pending/blocked、下游已 active/done、图不再合法）
  才进入 `conflicted`，禁止覆盖最新状态；不相关的前进（别的任务结算、`markActive`、阶段与 mode 切换）
  不再阻塞批准。

> 口径修正（2026-09-11，真机 case `dynamic-planning-run` 驱动）：旧口径拿**整份 state 的哈希**做 CAS，
> 而本节第一条恰恰写着「未受影响的并行任务仍可继续」—— 只要 run 在动，哈希必变，于是**运行中发出的
> 提案永远批不过**（实测：proposal 创建后 2 秒 T1 结算，批准即 `conflicted`）。只放宽判据不够：
> 照抄提案创建时的快照会把 run 的新进展回退掉，故必须同时改成锁内重放。

缺省值为 `approve_then_apply`。

## 5. 调整协议

一次请求包含 `reason` 和非空 `operations[]`。第一版支持：

### `insert_task`

调用者声明 `relation.type=prerequisite_for` 和目标任务，不提供数组位置。server 自动：

- 把新任务插在目标之前；
- 在未显式提供时继承目标的 WBS 与原依赖；
- 把新任务加入目标 deps；
- 在包含目标的 milestone 中同步插入；
- blocked 目标可恢复 pending；
- 计算调整前后的 ready 集合与下游影响闭包。

### `edit_task`

只允许修改 pending/blocked 任务。新增依赖、规划文件或约束可以作为普通计划修复；下列变化标记为需要决策：

- 删除已有依赖；
- 修改 `kind`、`wbsRef`、`acceptance` 或 `prompt`；
- 删除已有 `plannedFiles` 或 `constraints`。

### `delete_task`

只允许删除 pending/blocked 任务。server 会把依赖该任务的后续任务重连到被删任务的前置依赖，并从 milestone 移除；active/done 依赖者存在时拒绝。删除规划任务始终标记为 `decision_required`。

## 6. 不变量

两种执行模式都不能绕过：

- task ID、依赖引用和整图合法，无重复边、自依赖或环；
- active/done 任务内容不可被动态规划静默改写；
- 插入任务不能使已经 active/done 的下游历史失效；
- `plan.acceptanceCriteria` 不得被动态规划操作修改；
- 自动路径不得删除任务、删除依赖或改变承载目标的字段；
- 一次 operations 作为整体分析和应用，失败不产生部分 state；
- 人工批准复核「受影响闭包 + `plan.acceptanceCriteria`」的指纹，并在锁内对最新 state 重放 operations；冲突不覆盖；
- 第一版同一项目只允许一个开放 proposal，避免多个 hold 相互制造伪冲突；
- 调度器必须先原子占用任务再派发；hold 与占用共用 state 锁，审批前不会漏派；
- 派发通道失败时只把仍为 active 的占用安全回退 pending，不覆盖已结算状态；
- 应用后明确返回新的 ready task IDs。

## 7. 预埋扩展点

预埋点不局限于函数 hook：

- **协议预埋**：proposal 有 `schemaVersion`、`capability`、`executionMode`、`nextAction`、`review`；
- **配置预埋**：`run.dynamicPlanning.extensions` 原样进入 proposal 的 `extensionContext`，未来可挂 reviewer、notifier、policy adapter；
- **执行控制预埋**：state 中的 `dynamicPlanning.holds` 是调度器可识别的稳定控制面，可扩展为租约、分区暂停或外部编排器适配；
- **持久化预埋**：proposal 独立文件，事件使用追加式 JSONL，未来 UI 无需解析 server 日志；
- **决策转交预埋**：高风险 proposal 的 `nextAction={type:"decision", capability:"decision"}`；
- **正式决策生命周期**：高风险 proposal 自动追加 `decision_requested(status=awaiting_human)`；人工 resolve 后追加同 ID 的 `decision_completed(status=reviewed)`；
- **复审预埋**：自动应用结果进入 `applied_review_pending`，并保留 `review.status`；
- **服务替换预埋**：server 只依赖动态规划服务出口，planner/store/config 可分别替换；
- **代码扩展预埋**：service 提供分析后、应用前和应用后的可选扩展接口，但它们不是“钩子”的全部含义。

这些预埋点同时定义了 decision 能力后续应遵循的共同模式：能力自身只产出可审计结果，是否自动继续由项目策略决定；人工前置模式必须先形成可执行的阻断状态。当前版本只在动态任务规划中完成了这条链路，尚未宣称 decision 已完成同等改造。

## 8. 记录位置

```text
.awf/dynamic-planning/
├── proposals/<proposalId>.json
└── events.jsonl

.awf/decisions/runs/<runStamp>.jsonl
└── decision_requested → decision_completed
```

对外读取不会返回 proposal 内部的 `proposedState`，但本地记录保留它以支持人工批准、冲突判断和未来复盘。高风险 proposal 的 decision ID 使用 `D-<proposalId>`，proposal 与 decision 通过双向 subject/reference 关联。

`decision_required` proposal 不能再调用普通 proposal approve/reject 端点绕过 decision；必须由人工调用 `/awf/decisions/<decisionId>/resolve` 并明确给出 `approve` 或 `reject`。该入口刻意不暴露为 AI MCP tool。这里是工作流权限边界，并非不同操作系统身份之间的安全隔离；同一机器上拥有任意 HTTP/文件写权限的进程仍属于宿主信任域。

## 9. 完成门槛：新增真实测试

本能力不能只复用普通单元/集成测试来宣告完成，必须新增独立 case，并纳入 `npm run test:real -- --case all`。至少保留两组证据：

1. **真实边界链路**：启动真实 server 与真实 `awf-state` MCP，经 JSON-RPC 提交 proposal；确认 proposal 文件、事件日志和 state hold 真正落盘，人工批准端点应用后 hold 解除，MCP 读取到新任务图。
   ✅ **已落地**：`dynamic-planning` case（`tests/regression/fullflow-regression.mjs`，**31 断言**，定向实测 31/31）。除上述外还覆盖：第二个开放 proposal 被拒、hold 不牵连未受影响的并行任务、无关变化放行而相关变化被拒、人工拒绝释放 hold、非 server 模式拒绝本工具。
2. **真实运行链路**：在真 tmux、真 Claude、真 server 的 run 中发现缺失前置任务，由 AI 调用 `awf_dynamic_plan`；批准前目标及下游没有被派发，人工批准后新增任务先于目标执行，最终任务顺序、依赖、产物和审计记录全部收敛。
   ✅ **已落地（全真）**：`dynamic-planning-run` case，**一次 run 走到底，不重提 run**。T1 的 prompt 只给策略不给缺口位置，AI 自己从 state 里找出「T3 要 `src/adder.js` 而无人产出它」并发起提案；钩子扮演人工在 run 进行中批准；断言覆盖 hold 只挡目标、批准前目标从未 active、新任务的 `startedAt` 早于目标、四个任务全部 done、产物齐全。定向实测 22/22，复跑同结论。
   ✅ **同源 eval 用例**：`tests/eval/cases/dynamic-planning/`（`case.json` + `hooks.mjs`），与回归 case 同一场景，走 eval 的声明式评分 + 运行中钩子（`duringRun` / `afterRun`）。
   ✅ **已进全量连跑**：2026-09-12 `--case all --port 8799` → 204/204 全绿、exit 0（15 个 case 一轮 10 分钟）。

> 两套真机体系的定位差异与「至少要区分开」的收口，见 `docs/discuss/real-run-suite-merge.md`（待落地）。

真实 case 必须可定向单跑、可重复、自带沙箱、生成 `evidence-dynamic-planning.json`，并在全量连跑中得到同样结论。只有定向 case 与全量 case 都通过，才将本文状态改为“完成”。

## 10. 当前延后事项

- 自动应用后的人工复审 UI、通知、接受/驳回和补偿性调整尚未实现；
- 正式 decision 已有人工 HTTP resolve 入口，但 Review 页面上的原生批准/拒绝控件尚未实现；
- 通用 Stop 决策闸门仍沿用“AI 结果自动执行后 pending_review”的既有语义；把它也配置成“人工确认后执行”是独立后续改造，不能与本次动态规划 decision 接线混称完成；
- 人工审批晚于当前 run 自然退出时，批准后仍需显式恢复/重新提交 run；自动唤醒留给后续编排接线；
- `after_task`、同级插入、批量模块迁移等更多关系类型尚未开放；
- WBS 新增/删除和 milestone 生命周期调整仍不属于第一版 operation；
- 对自然语言目标是否语义等价仍需 AI/决策能力判断，机器层先保护结构字段和历史状态。
