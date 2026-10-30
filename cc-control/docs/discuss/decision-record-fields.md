# 决策记录字段：三条入口链的覆盖现状与字段改造结论

> 2026-09-28 · 状态：**讨论结论（未实施）**
> 触发：决策页面希望对「人工选择 / AI 自决」同时展示来源、类型、问题、选项；在把数据迁进数据库之前，先把字段定型。
> 关联：`.awf/issues/016-decision-lifecycle-records.md`（生命周期记录，已 fixed）、
> `.awf/bugs/decision-entry-two-generations.md`（两条链纠缠，待调整）、
> `docs/discuss/decision-system-design.md`、`server/adapters/cc/plugin/decision/decision/PROTOCOL.md`

## 1. 一句话

决策**数据层**一直是 16 个字段、三条入口链覆盖各不相同；**展示层**砍到 3 个字段。
真正缺的只有「AI 自决那条链的问题文本」和「页面渲染」，**不是**「人工那条链没数据」。

## 2. 现状：三条入口链 × 字段覆盖

| 想要的字段 | A 人工上抛<br>`/choice` `/ask`（旧代） | B-1 AI 自决·文本<br>`<AWF_DECISION_REQUIRED>` → Stop | B-2 AI 自决·提问捕获<br>AskUserQuestion 被 PreToolUse 捕获 |
|---|---|---|---|
| 来源 | **✗ 零记录** | ✗ 无来源字段 | 半 ✓ `source:'AskUserQuestion'`（记入口，不是「人/AI」） |
| 类型（单选/多选/文本） | 内存有 `type:'choice'\|'text'`，**不落盘** | ✗ | ✓ `type:'multiSelect'\|'choice'` + `multiSelect` |
| 问题 | 内存有，**不落盘** | **✗ 不落盘** | ✓ `request.question` |
| 选项 | 内存有，**不落盘** | ✗ | ✓ `request.options`（**只有 label**，description 丢弃） |
| 决策 / 判断依据 / 风险 | **✗** | ✓ `result` 全字段 | ✓ |

- **A 链已停用**（`plugin/core/skills/awf-run-decision/SKILL.md:4` 标【已停用 2026-09-10】，
  项目 CLAUDE.md 明确「不要再用」）。所以 A 链零记录**不是缺口，是遗留**。
  工具本身仍注册在 `plugin/core/mcp/awf-session/server.cjs:131/144`，但没有提示词/技能引导调用。
- **B-2 是今天人工选择的真实来源**，且 `requested → answered` 落得完整 —— 数据一直在。
- 落盘的 `request` 只有 5 个字段：`{ decision_id, question, options, type, multi_select }`；
  PROTOCOL §1 定义的 7 个 Request 字段中，`task_goal` / `context` / `constraints` / `related_decisions`
  **代码里没有任何地方写入**（协议有定义、实现为空）。

## 3. Decision Result 权威字段表（16 个）

来源：`server/adapters/cc/plugin/decision/decision/schemas/decision-result.schema.json`（git 已跟踪）。
`必填` 一列为 schema 的 `required`（7 个）。

| # | 字段 | 类型 | 必填 | 中文描述 |
|---|---|---|---|---|
| 1 | `decision_id` | string | ✓ | 决策唯一标识，由闸门/工作流生成（`D-<base36时间戳>-<序号>`），非模型产出 |
| 2 | `answer` | string | ✓ | **决策结论** —— 唯一驱动下一步执行的字段；不得是「建议进一步考虑 / 信息不足 / 需要用户决定」 |
| 3 | `type` | enum | ✓ | 结果语义：`resolved` / `deferred` / `no_action` / `validation_required` / `reframed` |
| 4 | `finality` | enum | ✓ | `final` 无计划中的待确认关键前提 / `provisional` 可执行但仍依赖未解决条件 |
| 5 | `impact` | enum | | 影响程度元数据，仅审查展示：`low` / `medium` / `high` / `critical` |
| 6 | `real_question` | string | ✓ | 真正被解决的决策问题（可能与表面问题不同） |
| 7 | `decisive_factors` | string[] | ✓ | **判断依据** —— 真正决定结论的因素，最多 5 个 |
| 8 | `causal_chain` | string[] | | 因果链：关键变量 → 机制 → 结果 → 为什么因此选当前行动 |
| 9 | `facts` | string[] | | 可验证事实（FACT）；公理 6 要求区分依据性质，禁止把判断/假设/未知伪装成事实 |
| 10 | `assumptions` | string[] | | 当前推理暂时依赖、尚未验证的前提（ASSUMPTION） |
| 11 | `unknowns` | string[] | | 当前未知项（UNKNOWN）；公理 7：不确定性要定价，不是消除 |
| 12 | `risks` | string[] | | **风险** —— 结论可能带来的损失或负面后果 |
| 13 | `reversible` | boolean | | 是否可逆；公理 9/11：错误成本与可逆性优先于表面收益 |
| 14 | `reconsider_when` | string[] | ✓ | **失效条件** —— 哪些条件变化时结论必须重新评估（公理 12） |
| 15 | `confidence` | enum | | `high` / `medium` / `low`；低置信度仍必须给出有效 `answer` |
| 16 | `fallback` | boolean | | 兜底标记，缺省 `false`；DC 无法完成决策时由 DW 置 `true`，语义固定为「延后处理 + 依赖分支停止扩展 + 进人工审查」 |

**语义分组**（PROTOCOL §2）：执行字段只有 `answer`；`decision_id` / `type` / `finality` /
`real_question` / `decisive_factors` / `reconsider_when` 是必需审查字段；其余为解释 / Review / 人工修改 / 重新决策。

**schema 必填 ≠ 模型必填**：`mode-instruction.md` 对模型只要求
`answer` / `type` / `finality` / `real_question` / `decisive_factors` / `reconsider_when` 六项，
`decision_id` 由闸门填。改字段须同时看这两处。

## 4. 展示层现状：只渲染 3 个

`web/src/shared/components/business/ReviewRecord/Detail.jsx:14-16`

| 界面标签 | 字段 |
|---|---|
| 决策 | `answer` |
| 判断依据 | `decisive_factors` |
| 风险 | `risks` |

- 该组件被 `Decisions` 与 `DynamicReview` **共用**；同文件 17-19 行的
  「变更操作 / 受影响任务 / 替代指令」是动态规划记录的字段，决策下行下为空。
- 前端聚合已按 `decision_id` 跨事件合并（`web/src/pages/Decisions/model.js` 的 `aggregateDecisions`，
  `...entry, ...result` 摊平），所以 `request.question` / `request.options` / `value`
  **已经在聚合对象上**，只是 `Detail.jsx` 没渲染。
- 列表标题取 `e.reason || e.real_question || e.answer || e.id`（`web/src/pages/Decisions/hooks/useDecisionsPage.js`）。
- 存储是**域共享**的：`subject.capability` 区分 `decision_gate` / `dynamic_planning`，改结构须照顾两边。

## 5. 三个已查实的坑

### 5.1 `answered_by` 拿不到「AI」——没有产出者

全仓搜索：**没有任何调用方会发 `answeredBy:'ai'`**。

- `cli/lib/decision.cjs:51-53` 的 `ai` 路由是**主动让位**，返回 `{answered:false}`，**根本不调 `/respond`**；
  文件头注释「三条路由的应答都经 `/respond`」与代码不一致。
- 服务端白名单接受 `'ai'`（`server/web/api/session.cjs:222`），但无人产生。
- **B-1 文本自决不经过 `/respond`**：Stop hook 的 `resolve` 分支直接 `persist()` 落 `decision_completed`，
  压根没有 `answered_by` 字段。

实际落盘值只有：`human`（CLI TTY readline 人答）、`auto`（CLI 5s 倒计时选第一项，发序号 `'1'`）。

### 5.2 B-1 不落问题，且 `deciding` 阶段没有 id

- `handler.cjs:onStop` 的 `deciding` 分支只写 `logger.logDecision({ decisionId: null, event: 'decision_started' })`
  —— 那是 run 日志（`.awf/logs/`），**不是** `.awf/decisions/`。
- `session.setDecision` 与 `nextId()` 只在 B-2 捕获路径调用，所以 B-1 的 requested / completed
  没有共同 id 可串。
- 要落问题，须在 `deciding` 分支生成 id，并从文本尾部抠出
  `<AWF_DECISION_REQUIRED>…</AWF_DECISION_REQUIRED>` 的正文；当前 `gate.cjs` 的 `classifyStop`
  只回答「文本是否以标签结尾」，**没有提取正文的先例**。

### 5.3 `type` 有三个含义，新增的「交互类型」会是第四个

| 位置 | 取值 | 语义 |
|---|---|---|
| `result.type` | resolved / deferred / no_action / validation_required / reframed | 结果语义（**schema 必填**） |
| `pending.type`（B-2 捕获） | choice / multiSelect | 交互形态 |
| `pending.type`（A 链） | choice / text | 交互形态 |

要新增的「类型（单选/多选/文本）」与第 2、3 行同义，却与 `result.type` 无关 —— **必须换名**。

## 6. 本次结论（用户裁定）

1. **「来源」用 `answered_by`。** 但因为它拿不到 AI（§5.1），页面须按**事件组合**推断：

   | 记录形态 | 显示 |
   |---|---|
   | `decision_answered` 且 `answered_by='human'` | 人工 |
   | `decision_answered` 且 `answered_by='auto'` | 自动（默认第一项） |
   | 只有 `decision_completed`、无 answered | AI 自决 |

2. **逐步做。** 改动量大的部分后置，先做有数据、改动集中在 B 链的那一段。
3. **A 链不是缺口，是遗留。** 它的入口已停用，不按「要补的洞」处理。

## 7. 分阶段改动量评估

### 第一阶段 —— 有数据，改动集中在 B 链（建议先做）

| 改动 | 文件 | 量 |
|---|---|---|
| B-1 落问题：`deciding` 分支生成 id + 落 `decision_requested` | `server/features/decision/handler.cjs` | ~15 行 |
| 抠标签正文的纯函数 | `server/features/decision/gate.cjs` | ~15 行 |
| 交互类型字段（**避开 `type`**） | schema + `mode-instruction.md` + `PROTOCOL.md` | 定义 |
| 页面 4 列渲染 + 来源推断 + `request.*` / `value` 展平 | `web/.../ReviewRecord/Detail.jsx` + `web/src/pages/Decisions/model.js` | ~20 行 |

≈ 4~5 个文件、50 行上下，**做完页面立刻有数据**（AI 自决的问题 + 人工的选择）。

### 第二阶段 —— A 链接入记录（4 文件 / 30~50 行；**建议暂不做**）

需要：`/choice`、`/ask` 生成 decisionId 并落 `requested`；
`recordAsked` 从 handler 导出面透出并参数化 `source`（现在硬编码 `'AskUserQuestion'` +
`subject:{capability:'decision_gate'}`）；`/respond` 那句**零改动**（已在传 `pendingDecision.decisionId`，
有 id 即自动生效）。

不做理由：入口停用中，接了没人调 = 死代码；且「两条链互斥化」那次 A 链形态还会变
（是否给它补 Decision Result 决定了字段长什么样）。等那次一起做更省。

### 第三阶段 —— 属「两条链互斥化」项目

复活 A 链入口 + 页面待决选择入口。用户 2026-09-10 已裁定「暂不做」，但**验收必须包含
「需要人工决策时页面上能出选择提示」**（见 `.awf/bugs/decision-entry-two-generations.md`）。
本议题的「来源/问题/选项」三列正是那条验收的前置。

## 8. 未决

1. **人工那行后三列留空还是补 DC？** B-2 捕获的纯人工决策没有 Decision Result，
   `decisive_factors` / `risks` / `finality` 全空。接受留空反而是好的对比
   （人工行有选项做参照、AI 行有依据和风险做解释）；要求「人工那条也补一次 DC」则改动量翻倍。
2. **交互类型字段定名**：候选 `form` / `answer_mode` / `interaction`。
3. **B-1 问题原文的存法**：是模型自由文本，可能很长 —— 原样存还是截断/清洗，直接影响后续 DB 字段类型与长度上限。
4. **入库顺序**：字段是 schema 契约，须先定字段再定表结构（本次讨论的原始前提）。

## 9. 一句话备忘

数据一直是 16 个字段，只有展示层砍到 3 个；「人工」那列有数据（B-2），
真正缺的是 AI 自决的问题文本（B-1）和页面渲染 4 列。`answered_by` 拿不到 AI，
来源列必须靠 `decision_completed` 事件推断。
