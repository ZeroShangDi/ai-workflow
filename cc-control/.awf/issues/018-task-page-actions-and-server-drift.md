---
id: "018"
title: "任务页操作面：三个待做操作 + 按钮全 404（前端先行于 server）"
status: open
labels: [ui, product, server, contract-drift, decision, deferred]
assignee: null
milestone: null
priority: high
created: 2026-09-22
updated: 2026-09-22
deps: []
related: ["004", "016", "017"]
---

# 任务页操作面

**一句话**：任务页现在**没有任何一个能生效的写操作** —— 唯二的两个按钮（解除阻塞 / 重试）
指向的 `POST /tasks/:id/:action` 在 server 上不存在，点下去前端显示 `not found`。
用户裁定按 **「执行中 / 执行结束」**分轴设计操作面，本轮定下执行中三个操作（**现在不做，先登记**），
并把前端先行于 server 的所有落差一并记在此处。

**优先级**：high —— 任务页按钮是死的；cc 模式的项目 / Plan / Run 整条流程在真机上也走不通。

---

## 一、为什么按「执行中 / 执行结束」分轴

分轴切的是**谁持有这个任务**：

- **执行中** = 引擎持有 → 人插手要付协调成本（可能和调度打架），操作面天然要窄
- **执行结束** = 引擎放手 → 随便改，操作面可以宽

按状态枚举（`pending|active|blocked|error|done`）会漏掉这一点：`active` 与 `blocked`
在状态机里是两个格子，但对人都属于"引擎还在管"，能做的事几乎一样。
（这个分轴是用户提的，比按状态枚举准。）

---

## 二、三个待做操作

### 2.1 重新入队 —— 可独立先做

| 字段 | 处理 | 理由 |
|------|------|------|
| `status` | `blocked \| error → pending` | 状态机里唯一的合法回退 |
| `blockedReason` | **清掉** | 它描述的是上一次阻塞，任务已重新入队 |
| `exec` | **保留** | 留着能看"上次为什么失败" |
| `exec.recheck` | **保留** | 门禁轮次是既成事实，清掉等于骗自己没重试过 |

UI：行内按钮标签随状态变（`blocked` → 「解除阻塞」，`error` → 「重试」），同一动作。
这也正是现在那两个死按钮的**真语义** —— 所以 §三 那个端点不是"修"，是**按语义重做**。

### 2.2 跳转到对应决策 —— 卡在一条链上

现在**任务 → 决策 跳不过去**，因为两者之间没有关联字段：

| 关联来源 | 现状 |
|---------|------|
| `decision.subject` | 只有 `{ capability, proposal_id }`，挂在 **proposal** 上，不是 task |
| 动态规划类决策 | proposal 有 `affectedTaskIds`，能**反查**出受影响的任务（这条能通） |
| 执行中 agent 发 `AskUserQuestion` | 决策记录里**没有 taskId** —— 只能靠"当前唯一 active 的任务"猜 |

还有一个现在**完全看不见**的问题：任务卡在决策上时，任务页看不出任何异常，它还是 `active`。

**建议补的字段**：任务等决策时写 `exec.awaitingDecisionId`，决策结清时清掉。收益：

- 任务条能显示"卡在决策"，不用靠猜
- 点击直接跳（dsh 内是同 app 切 view + 选中那条决策，不用跳出 iframe）

依赖：**先补字段，再做跳转**。这是本节唯一需要 server 新增的地方。

### 2.3 门禁轮次可见（只读）

`exec.recheck` server 已经在写（`server/features/gate/closure.js` 的 `spawnGateFixTask`），
UI 没读。要区分两种 `blocked`：

| 情形 | 判断 | 人该做什么 |
|------|------|-----------|
| 门禁在自动重试 | `exec.recheck < MAX_RECHECK` | 不用管，系统在自己派生修复任务 |
| 门禁已放弃，需人工 | `exec.recheck >= MAX_RECHECK`（`保持 blocked，需人工介入`） | 重新入队（2.1）或调整 |

现在这两种在页面上长得一模一样。

---

## 三、现状：任务页没有一个能生效的写操作

任务页只有一处可操作的地方，**两处渲染、同一个端点、都是 404**：

| 位置 | 按钮 | 端点 |
|------|------|------|
| 任务条行内（`blocked`/`error` 时出现） | 解除阻塞 / 重试 | `POST /tasks/:id/:action` |
| 右侧详情面板 | 解除阻塞 / 重试任务 | 同上 |

实测（真 server，选 `T4-001` 阻塞任务点「解除阻塞」）：

```
<p role="status"> 显示：not found      ← server 返回 {"ok":false,"error":"not found"}
任务状态：仍是「阻塞」                  ← 没有发生任何状态变化
```

即：用户看到的是一个**英文原始错误**，然后什么都没有发生。

---

## 四、全部 11 个 404 端点（前端真的在调、server 没有）

| 前端调用 | 端点 | 影响的页面 | 实测 |
|---|---|---|---|
| `taskAction` | `POST /tasks/:id/:action` (`retry`/`unblock`) | **任务页** | 404 |
| `adoptDecision` | `POST /awf/decisions/:id/adopt` | 决策页「采纳」 | 404 |
| `cancelRun` | `POST /run/:id/cancel` | Run 页 | 404 |
| `retryRun` | `POST /run/:id/retry` | Run 页 | 404 |
| `openProject` | `POST /projects/open` | 项目页「添加项目」 | 404 |
| `directories` | `GET /projects/directories` | 项目页 | 404 |
| `readEnvironment` | `POST /workspace/environment/read` | 项目页 | 404 |
| `requirements` | `POST /requirements` | 项目页 | 404 |
| `generatePlan` | `POST /plan/generate` | Plan 页 | 404 |
| `savePlan` | `POST /plan/save` | Plan 页 | 404 |
| `approvePlan` | `POST /plan/approve` | Plan 页 | 404 |

**dsh 四个 view 的读端点是真的**（`/awf/state`、`/awf/decisions`、`/awf/dynamic-planning/proposals` 都在），
所以任务 / 决策 / 动态复审三个页面**能看**；坏的是写操作。

**mock 是唯一实现**：`web/mock/lifecycle.js:63` 实现了 `/tasks/:id/(retry|unblock)`，
`web/mock/server.js` 实现其余。所以 `npm run dev:mock` 下一切正常 ——
**本地开发看不出问题**，这是这类漂移最危险的地方。

---

## 五、error 状态：前端已扩，server 未采纳

| | 前端 | server |
|---|---|---|
| 任务状态枚举 | `active \| pending \| blocked \| error \| done`（`TASK_STATUSES`，`web/src/shared/lib/format.js`） | `awf_task_status` 的 enum 仍是 4 值（`plugin/core/mcp/awf-state/server.cjs:217`） |

用户裁定：**前端先支持，server 到时候再看**。登记在此避免长期不一致。采纳时要一并定：

- `error` 与 `blocked` 的**边界** —— 谁负责把任务标成 `error`？（它不是"失败"的同义词，`blocked` 已经是失败）
- 是否进就绪判据（`server/shared/ready-tasks.cjs`）—— 不进则 `error` 任务永远不会被重试派发
- 门禁回环（`server/features/gate/closure.js`）要不要识别 `error`

另有一处更小的口径：前端 `TASK_SOURCES = ['plan', 'gate_fix', 'dynamic_planning']` 里的 `plan`
是**前端合成的缺省值**，不是 wire value（真实数据里该字段缺省即"原计划"）。
`gate_fix` / `dynamic_planning` 已与 server 一致（`source` 字段，见 `docs/features/state.md`）。

---

## 六、明确不做 / 不打算做

| 操作 | 理由 |
|------|------|
| 跳过、取消 | 状态机里**没有**这两个状态。要加是加状态，不是加操作 |
| 直改 `status` 到任意值 | 绕开语义，等于把状态机交给用户手搓 |
| 增 / 改 / 删任务（改计划结构） | 不属于"任务级操作"，属于**改计划**，走 `awf_dynamic_plan` 提案 + 人工批准。放在任务条上会让人以为和"重试"同级，风险差一个数量级 |
| 手动开工（`pending → active`） | 路由 `POST /run/state/task/active` 已存在，但那是**宿主派发内部**用的。单/多 agent 下开工是宿主的事，人插手会和调度打架 |

---

## 七、未决构想（**未定，不属待办**）

用户提出过"执行结束后点一下、右侧出一个简易对话框调整任务"。方向对（终态任务的调整就是**改计划**），
但它跟动态规划的护栏正面冲突，必须先定分档：

| 改动 | 判据（`server/features/replanning/planner.cjs`） | 结果 |
|------|-----------------------------------------------|------|
| 改 `title` | 不在目标承载字段里 | **自动应用** |
| 新增 `deps` / `plannedFiles` / `constraints` | 只加不减 | **自动应用** |
| 新增任务 / 插前置 | — | **自动应用** |
| 改 `acceptance` / `prompt` / `kind` / `wbsRef` | `changes goal-bearing field` | **转人工决策** |
| 移除依赖 / 文件 / 约束 | `removes …` | **转人工决策** |
| 删除任务 | `delete planned task` | **转人工决策** |
| 波及 active/done 的任务 | 硬护栏 | **直接拒绝** |

两条硬约束：

- **不能直连 `awf_task_update`**：`run`/`pause` 下直接被禁用（`awf-state/server.cjs:605`）；
  `idle` 下能改但绕过护栏。
- 所以对话框只能按风险分档：**低风险即时生效 / 高风险提交后变成一条决策**。
  否则只有两个结局 —— 绕开护栏（护栏白建了），或"简易对话框"点完还要人去批（就不简易了）。

---

## 八、待定：补 server，还是删前端

不是一刀切，要逐项裁定：

| 组 | 建议 | 理由 |
|---|------|------|
| 任务页 / 决策页（`taskAction`、`adoptDecision`） | **补 server** | dsh 内的主视图，按钮存在就该能用 |
| cc 模式 8 个（项目 / Plan / Run） | **先确认这些页面还在不在路线图内** | 若已不在，删掉按钮比补 server 诚实；现在是"看着能用、点了 404" |
| `cancelRun` / `retryRun` | **先定语义** | 现在只有 `/run/submit`；run 的"取消 / 重试"是什么意思没定过 |

---

## 九、判据方法（可复现）

```bash
# 1. 取 server 真实路由集
grep -rhoE "pathname (===|\.match\(|\.startsWith\()[^)]*" server/web/*.cjs server/web/api/*.cjs | sort -u

# 2. 与前端 API 表对照
cat web/src/shared/api/index.js

# 3. 逐条实测 —— 注意两个坑：
#    · 写端点必须带 ?p=，否则被守卫拦成 400（"写类端点缺 ?p"），看不到真实结果
#    · GET 打不存在的路径返回 200 + index.html（SPA 兜底），只看状态码会误判，要看 content-type
curl -s -D- -o /dev/null -X POST -H 'content-type: application/json' -d '{}' \
  "http://127.0.0.1:8787/tasks/T1-001/retry?p=<projectRoot>"
```

---

## 十、关联

- 004：declared-vs-actual drift（同类问题的一般化）
- 016：决策生命周期记录（2.2 的 `awaitingDecisionId` 与那条链同源）
- 017：旧 CLI 未搬能力清单（同类"账要记清"的先例）
- 先例：`.awf/bugs/write-endpoint-missing-p-fell-back-to-boot.md`（T1-110 已修，同类：声明与实现的落差）
