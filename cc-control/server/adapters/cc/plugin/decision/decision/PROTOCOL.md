# AWF Decision Protocol

本文只定义 DC 与 DW 之间的最小机器协议。

## 1. Decision Request

DW 调用 DC 时建议提供：

```json
{
  "decision_id": "D-0001",
  "question": "当前需要解决的决策问题",
  "task_goal": "当前任务目标",
  "context": "当前执行现场摘要",
  "options": [],
  "constraints": [],
  "related_decisions": []
}
```

字段说明：

- `decision_id`：由 DW 生成；
- `question`：当前明确的决策问题；
- `task_goal`：当前任务最终要达到的目标；
- `context`：当前 Agent 已经拥有且与该问题直接相关的现场；
- `options`：已有候选项，可为空；
- `constraints`：当前用户、计划、任务中的明确约束；
- `related_decisions`：直接相关的历史 Decision，可为空。

DW 不应在 Request 中替 DC 写“推荐方案”。

---

## 2. Decision Result

标准结果：

```json
{
  "decision_id": "D-0001",
  "answer": "下一步应该做什么",
  "type": "resolved",
  "finality": "final",
  "impact": "medium",
  "real_question": "真正被解决的问题",
  "decisive_factors": [],
  "causal_chain": [],
  "facts": [],
  "assumptions": [],
  "unknowns": [],
  "risks": [],
  "reversible": true,
  "reconsider_when": [],
  "confidence": "high",
  "fallback": false
}
```

### 必填字段

- `decision_id`
- `answer`
- `type`
- `finality`
- `real_question`
- `decisive_factors`
- `reconsider_when`

### 执行字段

只有：

```text
answer
```

直接驱动下一步执行。

### 审查字段

其余字段用于：

- 解释；
- Review；
- 人工修改；
- 后续重新决策。

---

## 3. Type

允许值：

```text
resolved

deferred

no_action

validation_required

reframed
```

`type` 只描述结果语义，不决定工作流。

---

## 4. Finality

```text
final
provisional
```

- `final`：当前已知条件下没有计划中的关键待确认前提；
- `provisional`：当前 answer 可执行，但仍依赖未解决的重要条件。

---

## 5. Impact

```text
low
medium
high
critical
```

仅用于审查展示和未来扩展。

第一版 DW 不基于该字段计算影响范围。

---

## 6. Confidence

```text
high
medium
low
```

低置信度不允许产生“没有 answer”的结果。

---

## 7. Fallback

普通结果：

```json
"fallback": false
```

当 DC 无法正常完成 Decision 时，由 DW 生成兜底结果：

```json
"fallback": true
```

兜底语义固定为：

> 当前无法可靠完成该决策，延后处理；继续所有不依赖该决策的工作，依赖该决策的当前分支停止扩展，并进入人工审查。

---

## 8. Review Record

建议每个正式 Decision 最少记录：

```json
{
  "decision_id": "D-0001",
  "run_id": "RUN-xxx",
  "task_id": "TASK-xxx",
  "created_at": "ISO-8601",
  "request": {},
  "result": {},
  "source": "text | ask_user_question",
  "status": "pending_review | reviewed | overridden"
}
```

所有经 DC + DW 的正式 Decision 必须存在 Review Record。

---

## 9. Review Override

人工修改不覆盖原 Decision。

产生一条新的纠偏任务：

```json
{
  "source": "decision_review",
  "decision_id": "D-0001",
  "instruction": "人工修正后的要求",
  "original_answer": "原 answer"
}
```

影响范围由该任务执行时自行判断。
