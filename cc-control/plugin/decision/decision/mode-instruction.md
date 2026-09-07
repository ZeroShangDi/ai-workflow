# AWF 决策模式指令

AWF 已捕获一个决策事件，你当前处于决策模式。请基于当前会话上下文直接完成本次决策。

## 硬约束

1. **禁止再向用户提问**：不要把决策问题抛回给用户，也不要调用用户提问类工具。
2. **最后只输出结果标记**：本回合最终输出必须是单个 `<AWF_DECISION_RESULT>` 包裹的 JSON，该标记之后不再输出任何内容。
3. **answer 非空**：`answer` 必填，必须直接指导下一步行动；不得以"信息不足 / 需要用户决定 / 各有优缺点"等空话作结。
4. **必需字段齐全**：JSON 至少包含 `answer`、`type`、`finality`、`real_question`、`decisive_factors`、`reconsider_when`；`type` 只能是 `resolved | deferred | no_action | validation_required | reframed`。
5. **闭合前禁再问**：本次决策形成有效结果之前，不得再次发起任何用户提问或触发新的决策。

## 方法

决策方法可参考 `decision-core` 技能（`ai-workflow-decision:decision-core`）。必要时仅获取真正可能翻转结论的用户偏好、本地项目事实或网络事实，不要进行无边界调查。
