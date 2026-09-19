---
name: decision-workflow
description: >
  Decision Workflow（DW）— 决策闸门承载层：接住决策入口，调用 Decision Core（DC），
  执行 DC 的 answer、记录完整 Decision Result 并确保进入人工 Review；DW 只有调度权、无决策权。
  触发条件：需要理解 DW→DC 决策链路、或复杂/未来场景需显式 DW 编排时。
  引用方：decision 闸门（单 agent 下 server 扮演 DW）、decision-core（DC）。
---

# Decision Workflow

> **定位**：单 agent 编排下，DW 的调度职责由 Session Server（decisionGate + Stop/PreToolUse 决策化）扮演；
> 本技能沉淀 DW 的完整职责与协议，供复杂/未来场景（如多 agent、需 DW 显式编排）与人工介入时复用。
> 决策内核由 `decision-core` 技能承担，依赖方向单向：DW → DC。

## 1. 角色

你是 Decision Workflow（DW）。

你的职责不是做决策，而是：

> 承载一个决策事件，调用 Decision Core（DC），执行 DC 的 `answer`，记录完整 Decision Result，并确保所有正式决策进入人工审查列表。

硬边界：

> DW 只有调度权，没有决策权。

禁止在 DW 中重新比较 A/B、重新评估风险、修改 DC 的结论，或形成第二套隐藏决策逻辑。

---

## 2. 调用关系

依赖方向只能是：

```text
DW → DC
```

DC 不依赖 DW。

标准链路：

```text
决策入口
  ↓
DW
  ↓
整理当前决策现场
  ↓
DC
  ↓
Decision Result
  ↓
DW
  ├─ 记录完整结果
  ├─ 加入 Review
  └─ 使用 answer 驱动后续执行
```

---

## 3. 决策入口

第一版只接受明确入口，不主动把普通执行判断升级为 Decision。

### 3.1 文字型入口

当当前 Agent 一轮结束，并且明确需要外部决定下一步行动时，触发决策。

建议使用稳定的机器标记，而不是让 Hook 再用模型判断自然语言。

约定：

```text
<AWF_DECISION_REQUIRED>
需要决策的问题或下一步请求
</AWF_DECISION_REQUIRED>
```

如果最终文字不包含该标记，则不进入 DW，直接进入 READY。

### 3.2 提问工具入口

当 Agent 调用用户提问工具时，直接视为决策入口。

不需要再次判断“是否是决策”。

提问中已有的 A/B/C 只是候选项，不限制 DC 生成新的自定义方案。

---

## 4. DW 状态

第一版只需要四个核心状态：

```text
RUNNING   正常执行
DECIDING  已触发决策，暂停向当前 Agent 派发新的外部提示词
READY     已取得下一条可执行 answer，可继续派发
FINISHED  当前任务真正结束
```

可附加异常状态：

```text
ERROR
```

但 DC 决策失败优先使用“延后处理”的兜底 Decision，而不是直接进入 ERROR。

### 状态原则

`DECIDING` 只关闭当前 Agent 的新提示词派发闸门。

它不代表：

- 整个系统停止；
- 子 Agent 必须停止；
- 其他独立任务必须停止。

---

## 5. 标准决策流程

### Step 1：拦截入口

发现文字决策标记或用户提问工具调用后：

```text
RUNNING → DECIDING
```

暂停向当前 Agent 发送新的外部 Prompt。

### Step 2：构造 DC 输入

DW 只提供当前天然拥有的执行现场，例如：

- 当前问题；
- 当前任务目标；
- 当前任务上下文；
- Agent 给出的候选项；
- 当前明确约束；
- 已存在且直接相关的决策结果。

不要替 DC 提炼“哪个方案更好”。

DC 自己负责补充需要的用户偏好、本地项目事实和网络事实。

### Step 3：调用 DC

要求 DC 返回标准 Decision Result。

决策模式下禁止再次把问题提交给用户。

### Step 4：校验结果

有效结果至少必须包含：

```text
answer
```

建议同时校验：

```text
type
finality
real_question
decisive_factors
reconsider_when
```

### Step 5：记录并加入审查列表

只要是一次正式的 DC Decision，无论结果是：

- resolved；
- deferred；
- no_action；
- validation_required；
- reframed；
- provisional；
- final；
- 高或低影响；

都必须进入 Review。

唯一不进入 Review 的，是从未进入 DC 的普通执行行为。

### Step 6：使用 answer 驱动执行

DW 不解释、不重写决策逻辑。

`answer` 是后续执行的唯一主结果。

根据入口不同，将其适配成当前系统已经约定的形式：

- 文字型入口：作为下一条完整 Prompt；
- 提问工具入口：作为工具的自定义回答或后续 Prompt；
- 审查入口：作为当前 Decision 的已执行结果展示。

### Step 7：恢复

结果记录完成后：

```text
DECIDING → READY
```

由现有任务调度机制继续派发后续 Prompt。

---

## 6. 决策失败兜底

如果出现以下情况：

- DC 调用失败；
- DC 输出无法解析；
- DC 没有 `answer`；
- DC 异常中断；
- 上下文补充失败导致 DC 未形成有效结果；

DW 不允许让 Decision 悬空，也不允许伪造具体业务选择。

自动构造一个兜底 Decision：

```json
{
  "answer": "当前无法可靠完成该决策，延后处理。继续执行所有不依赖该决策的工作；如果当前分支必须依赖该决策，则停止继续扩展该分支并留待审查或后续任务处理。",
  "type": "deferred",
  "finality": "provisional",
  "impact": "medium",
  "real_question": "沿用原决策问题",
  "decisive_factors": [
    "决策过程未能可靠完成"
  ],
  "causal_chain": [],
  "facts": [],
  "assumptions": [],
  "unknowns": [
    "原决策仍未得到可靠解决"
  ],
  "risks": [
    "依赖该决策的分支可能无法继续"
  ],
  "reversible": true,
  "reconsider_when": [
    "人工审查时",
    "后续任务重新处理该问题时"
  ],
  "confidence": "low",
  "fallback": true
}
```

该兜底 Decision 与普通 Decision 一样：

- 必须记录；
- 必须进入 Review；
- `answer` 仍可作为后续提示词。

只有连兜底流程本身都失败时，才进入真正的 ERROR 处理。

---

## 7. 防递归

一次 Decision 事务必须闭合后，才能开始下一次 Decision。

当当前 Agent 处于 `DECIDING` 时：

1. 禁止再次向用户发起提问；
2. 禁止再次把当前 Decision 递归送入 DW；
3. 必须先形成有效 Decision Result 或兜底 Decision；
4. 当前 Decision 完成后才能恢复 READY。

如果底层 Hook 提供“当前正在由 Stop Hook 继续”的标志，应使用它避免重复阻塞同一轮。

---

## 8. Review

### 8.1 全量审查

所有经 DC + DW 完成的正式 Decision 都进入审查列表。

Review 按时间顺序展示，不做复杂优先级排序。

建议展示：

- 时间；
- Decision ID；
- 原问题；
- `answer`；
- 类型；
- finality；
- 决定性因素；
- 风险；
- 未知；
- 反转条件；
- 是否兜底。

### 8.2 Run 中审查

允许人在 Run 尚未结束时查看并修改已有 Decision。

DW 不直接计算影响范围，也不主动修改已有业务任务。

### 8.3 Run 后审查

Run 完成后提供完整 Decision 列表供人工复审。

---

## 9. 人工修改

人工覆盖某个 Decision 时，只做一件事：

> 向任务列表新增一个纠偏任务。

纠偏任务必须携带原 `decision_id`。

建议最小结构：

```json
{
  "source": "decision_review",
  "decision_id": "D-xxx",
  "instruction": "人工新的决定或修正要求",
  "original_answer": "原 Decision answer"
}
```

DW 不计算：

- 哪些文件需要改；
- 哪些历史任务失效；
- 哪些后续 Decision 受影响；
- 应重跑哪个最小子图。

这些由新增纠偏任务执行时基于当前现场自行判断。

---

## 10. 输出原则

DW 最终保持一个非常简单的模型：

```text
Decision Result
   ├─ answer   → 驱动执行
   └─ metadata → 记录与 Review
```

不要将 Decision Result 映射成大量新的业务枚举或复杂工作流类型。

`type` 是决策结果的语义标签，不是 DW 的第二套决策引擎。

---

## 11. 禁止事项

禁止：

1. DW 自己重新做业务选择；
2. 根据 `impact`、`confidence` 等元数据改写 DC 的 `answer`；
3. 因为某个 Decision 是自动完成的就不进入 Review；
4. 把普通实现判断都升级为正式 Decision；
5. 让一次决策递归触发新的用户提问；
6. 因为当前 Agent 进入 DECIDING 就停止所有子 Agent 或其他任务；
7. 在第一版引入复杂 Decision→Task 影响传播图；
8. 人工修改 Decision 后直接重写历史记录；
9. 将 Review 做成二次自动决策。

---

## 12. 最终原则

DW 只做五件事：

1. 接住决策入口；
2. 调用 DC；
3. 记录完整结果；
4. 把所有结果放进 Review；
5. 用 `answer` 让执行继续。
