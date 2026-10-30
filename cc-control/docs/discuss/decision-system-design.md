> **归档说明（2026-09-07）**：本文为 v0.2.0「AWF 决策闸门」的早期集成设计稿，原存放于原型目录
> `plugin/awf-decision-system/docs/AWF_DECISION_INTEGRATION.md`（该原型目录已随 v0.2.0 删除）。保留于此仅供追溯，
> 具体实现细节可能与现状有出入。
>
> 现行 as-built 设计以 decision 插件为准：`plugin/decision/`（PROTOCOL / skills / schema / mode-instruction）；
> 架构总览见 [架构笔记：AWF 决策闸门 v0.2.0](./architecture-notes.md#awf-决策闸门-v020)。

---
# AWF 决策流程程序改造文档

## 1. 目标

在现有 AWF 的单 Agent / 多 Agent Run 流程中加入一个“决策闸门”：

```text
Agent 正常执行
    ↓
出现明确决策入口
    ↓
暂停向该 Agent 派发新的外部 Prompt
    ↓
DW 调用 DC
    ↓
取得 Decision Result
    ↓
完整记录并进入 Review
    ↓
使用 answer 作为下一步输入
    ↓
READY
    ↓
继续 Run
```

目标不是重写任务系统，而是在现有 Prompt 派发链路前增加一个非常薄的 Decision Gate。

---

## 2. 第一版边界

第一版只实现：

1. 两种明确决策入口；
2. `RUNNING → DECIDING → READY`；
3. 调用 DC；
4. `answer` 驱动下一 Prompt；
5. 所有 Decision 全量进入 Review；
6. DC 失败自动兜底为 deferred；
7. Review 修改后向任务列表新增纠偏任务；
8. 不做复杂影响图、不做自动依赖传播。

不做：

- Decision → Task 依赖图；
- 自动计算受影响文件；
- 自动回滚；
- 复杂决策优先级；
- 多层 Decision 状态机；
- 商业化/API Provider 抽象。

---

## 3. 决策入口

### 3.1 文字型结束

不要让 Hook 再调用模型判断“这段文字是不是决策”。

让执行 Agent 明确输出机器标记：

```text
<AWF_DECISION_REQUIRED>
下一步应该继续扩展 UI，还是先实现状态机？
</AWF_DECISION_REQUIRED>
```

普通完成不输出该标记。

Stop Hook 只做确定性检测：

```text
有标记  → DECIDING
无标记  → READY / 正常结束
```

### 3.2 AskUserQuestion

`AskUserQuestion` 直接视为 Decision，不做二次判断。

它的候选项作为 `DecisionRequest.options` 传入 DC。

DC 允许选择现有项，也允许输出现有项之外的自定义 answer。

---

## 4. Claude Code Hook 可行性

截至本设计产出时，Claude Code 官方 Hook 支持：

- `Stop`：Agent 完成响应时触发；输入包含 `last_assistant_message`；
- `Stop` 可以通过 `decision: "block"` 或 `additionalContext` 让当前 Claude 继续处理；
- `stop_hook_active` 用于识别当前是否已经因 Stop Hook 被继续，可用于防递归；
- `PreToolUse` 可以拦截工具；
- 对 `AskUserQuestion`，`PreToolUse` 支持 allow / deny / ask / defer，并支持通过 `updatedInput` 程序化补入答案；
- 官方也支持 defer 后恢复同一 session 的模式。

官方参考：

```text
https://code.claude.com/docs/en/hooks
```

推荐第一版优先采用“当前 Session 切换到 DC”的方式，而不是 AWF 再启动一个独立模型 API 调用。

---

## 5. 推荐 Hook 链路

### 5.1 文字决策

```text
Claude 正常 Run
    ↓
最终文字包含 AWF_DECISION_REQUIRED
    ↓
Stop Hook
    ↓
检测 stop_hook_active == false
    ↓
AWF Agent State = DECIDING
    ↓
Stop Hook 返回 additionalContext / block reason
    ↓
告诉当前 Claude：
  - 当前进入 Decision 模式
  - 调用 decision-core Skill
  - 禁止再询问用户
  - 输出标准 Decision Result
    ↓
Claude 完成 DC 决策
    ↓
再次 Stop
    ↓
stop_hook_active == true
    ↓
DW 读取 Decision Result
    ↓
记录 Review
    ↓
State = READY
    ↓
answer 进入下一次 Prompt 派发
```

Claude Code 对 Stop Hook 存在连续继续保护，因此不要使用无限 Stop Hook 循环。

第一版一次 Decision 只允许一次“Stop → 继续 → Decision Result → Stop”的闭环。

---

## 6. Stop Hook 建议协议

### 输入检测

优先读取 Stop Hook 的：

```text
last_assistant_message
```

不要依赖 Stop 时 transcript 已经写入最终回答。

### 决策标记

推荐：

```text
<AWF_DECISION_REQUIRED>...</AWF_DECISION_REQUIRED>
```

### 决策完成标记

建议 DC 的机器输出外围再加：

```text
<AWF_DECISION_RESULT>
{ ...DecisionResult JSON... }
</AWF_DECISION_RESULT>
```

这样 Stop Hook / AWF 不需要从自然语言猜结构。

### 防递归

逻辑：

```pseudo
if state == DECIDING and last_message contains AWF_DECISION_RESULT:
    capture_result()
    allow_stop()
    return

if stop_hook_active == true:
    allow_stop()
    return

if last_message contains AWF_DECISION_REQUIRED:
    state = DECIDING
    continue_current_session_with_decision_instruction()
    return

normal_flow()
```

---

## 7. AskUserQuestion Hook 建议

对 `AskUserQuestion` 配置 `PreToolUse` matcher。

第一版推荐：

```text
AskUserQuestion
    ↓
PreToolUse
    ↓
设置 Agent State = DECIDING
    ↓
阻止真实用户提问
    ↓
把决策指令反馈给当前 Claude
    ↓
当前 Claude 调用 decision-core
    ↓
输出 AWF_DECISION_RESULT
    ↓
DW 记录 + READY
```

可以使用 `permissionDecision: "deny"` 将拒绝理由反馈给 Claude，让它不要询问用户而改走 DC。

如果你的现有调用方式更适合 Claude Code 的非交互恢复机制，也可采用：

```text
permissionDecision: "defer"
→ process 获得 deferred_tool_use
→ AWF 完成决策
→ resume session
→ updatedInput.answers
```

但这会让 DW 的实现更重。

因此第一版优先使用“deny → 当前 Session 自决策”的路径。

---

## 8. 决策模式 Prompt

Hook 反馈给当前 Claude 的内容应非常短，并保持稳定。

示例：

```text
AWF 已捕获一个决策事件。

不要向用户继续提问。
调用 decision-core Skill，使用当前会话上下文完成该决策。
必要时仅获取真正可能翻转结论的用户偏好、本地项目事实或网络事实。

最终只输出：
<AWF_DECISION_RESULT>
<符合 Decision Result 协议的 JSON>
</AWF_DECISION_RESULT>

当前处于决策模式；本次决策闭合前禁止再次发起用户提问。
```

不要把 DC 的完整公理复制到 Hook Prompt 中。

公理由 Skill 自己维护。

---

## 9. 状态改造

当前 Agent 建议至少增加：

```ts
type AgentState =
  | 'RUNNING'
  | 'DECIDING'
  | 'READY'
  | 'FINISHED'
  | 'ERROR'
```

语义：

### RUNNING

当前 Agent 正在执行已派发 Prompt。

### DECIDING

发现正式 Decision，暂停向该 Agent 派发新的外部 Prompt。

注意：

- 不停止其他 Agent；
- 不停止当前已经存在的子 Agent；
- 不代表整个 Run 停止。

### READY

Decision 已闭合，已有可继续使用的 `answer`，允许任务调度器继续派发下一 Prompt。

### FINISHED

任务真正完成。

### ERROR

只有连 fallback Decision 都无法构造或基础设施本身失效时使用。

---

## 10. Decision Service / Module

推荐最小接口：

```ts
interface DecisionRequest {
  decisionId: string
  runId?: string
  taskId?: string
  source: 'text' | 'ask_user_question'
  question: string
  taskGoal?: string
  context?: string
  options?: unknown[]
  constraints?: string[]
  relatedDecisions?: unknown[]
}

interface DecisionResult {
  decision_id: string
  answer: string
  type: 'resolved' | 'deferred' | 'no_action' | 'validation_required' | 'reframed'
  finality: 'final' | 'provisional'
  impact?: 'low' | 'medium' | 'high' | 'critical'
  real_question: string
  decisive_factors: string[]
  causal_chain?: string[]
  facts?: string[]
  assumptions?: string[]
  unknowns?: string[]
  risks?: string[]
  reversible?: boolean
  reconsider_when: string[]
  confidence?: 'high' | 'medium' | 'low'
  fallback?: boolean
}
```

DW 只依赖：

```ts
resolveDecision(request): Promise<DecisionResult>
```

第一版内部实现可以直接利用当前 Claude Session + Skill，不需要先抽象远程 Provider。

---

## 11. Decision Result 校验

建议顺序：

```text
收到结果
  ↓
提取 AWF_DECISION_RESULT
  ↓
JSON parse
  ↓
JSON Schema validate
  ↓
answer 非空？
  ↓
成功 → 写 Review → READY
失败 → fallback deferred
```

不要因为某些辅助字段缺失就中断 Run。

第一版最关键的是保证 `answer` 存在。

---

## 12. Fallback Decision

任何 DC 执行失败都转成统一兜底：

```json
{
  "answer": "当前无法可靠完成该决策，延后处理。继续执行所有不依赖该决策的工作；如果当前分支必须依赖该决策，则停止继续扩展该分支并留待审查或后续任务处理。",
  "type": "deferred",
  "finality": "provisional",
  "real_question": "原决策问题",
  "decisive_factors": ["决策过程未能可靠完成"],
  "unknowns": ["原决策仍未可靠解决"],
  "reconsider_when": ["人工审查时", "后续任务重新处理时"],
  "confidence": "low",
  "fallback": true
}
```

fallback 仍然：

- 进入 Review；
- 有 Decision ID；
- 有 `answer`；
- 可以继续现有调度逻辑。

---

## 13. Review 数据

每次 Run 建议继续采用一个追加式记录文件：

```text
.awf/decisions/runs/<run-id>.jsonl
```

第一版按 Decision 完成时间追加。

示例：

```json
{"event":"decision_completed","decision_id":"D-001","task_id":"T-12","created_at":"...","request":{},"result":{},"status":"pending_review"}
```

人工修改：

```json
{"event":"decision_overridden","decision_id":"D-001","created_at":"...","instruction":"改为采用 B"}
```

历史不覆盖。

---

## 14. Review 页面

按时间顺序即可。

每项展示：

```text
时间
Decision ID
问题
answer
类型 / finality
决定性因素
风险
未知
重新决策条件
fallback 标记
```

不需要复杂排序。

---

## 15. Review 修改后的行为

人工修改某 Decision 后，不计算影响范围。

只向现有 Task List 新增：

```ts
{
  source: 'decision_review',
  decisionId: 'D-001',
  instruction: '人工修正后的要求',
  originalAnswer: '原 answer'
}
```

该任务被执行时，由执行 Agent 自行检查当前项目状态并决定：

- 需要修改什么；
- 是否已有部分结果仍有效；
- 需要重新执行哪些步骤。

这保持现有任务系统简单，也避免第一版引入复杂依赖图。

---

## 16. 单 Agent 与多 Agent

### 单 Agent

```text
RUNNING
  ↓
Decision
  ↓
DECIDING
  ↓
暂停派发新 Prompt
  ↓
DC
  ↓
READY
  ↓
继续派发
```

### 多 Agent

某个 Agent 进入 DECIDING，只影响它自己的新 Prompt 派发。

其他 Agent 和已经启动的子 Agent 按原机制继续。

不需要为了 Decision 引入全局暂停。

---

## 17. 不建议第一版加入 `/decision` 命令

自定义 `/decision` 命令是合理的未来抽象，但不是第一版闭环成立的前提。

第一版：

```text
Hook → 固定决策指令 → DC → DW
```

足够。

当未来出现：

- 多个 Hook 重复相同逻辑；
- CC 需要主动进入决策模式；
- 人工调试 Decision；
- 其他 Workflow 需要复用；

再抽象：

```text
/decision
```

作为薄控制命令。

不要把 Decision 创建成普通业务 Task，避免任务系统与决策系统套娃。

---

## 18. 推荐实施顺序

### 第 1 步

接入 Decision Result Schema 与 Review 记录。

### 第 2 步

增加 Agent State：

```text
DECIDING
READY
```

### 第 3 步

实现 Stop Hook：

```text
AWF_DECISION_REQUIRED → 当前 Session 进入 DC
```

### 第 4 步

实现 AskUserQuestion PreToolUse Hook。

### 第 5 步

实现 Result 捕获、校验和 fallback。

### 第 6 步

接 Review 页面。

### 第 7 步

Review 修改 → 新增纠偏 Task。

### 第 8 步

实际连续跑多个 Run，重点验证：

- 是否漏拦截；
- 是否重复触发；
- `stop_hook_active` 是否正确防循环；
- AskUserQuestion deny 后 Claude 是否稳定转入 DC；
- Decision Result 是否稳定符合结构；
- fallback 是否能保持 Run 不悬空。

---

## 19. 第一版验收标准

满足以下条件即可认为决策闭环成立：

1. 普通 Agent 结束不进入 Decision；
2. 文字决策能被 Stop Hook 稳定捕获；
3. AskUserQuestion 能被 PreToolUse 稳定捕获；
4. 决策期间当前 Agent 不接受新的外部 Prompt；
5. DC 能利用当前上下文输出标准 Decision Result；
6. `answer` 能稳定成为下一步输入；
7. 所有正式 Decision 都出现在 Review；
8. DC 失败会生成 deferred fallback，而不是悬空；
9. Review 修改只新增纠偏 Task；
10. 多 Agent 场景下单个 Agent 决策不会停止其他 Agent。

达到这 10 条后，再考虑更复杂能力。
