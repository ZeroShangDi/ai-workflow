# 决策闸门 v0.2.0（ai-workflow-decision）— 功能文档

> 对应 WBS：W4-001 AWF 决策闸门 v0.2.0（单 agent）｜功能拆分见 [讨论稿](../discuss/decision-system-design.md)
> 源码：`src/server/server.cjs` / `src/server/decision*.cjs` / `src/cli/run.js` / `src/lib/run-config.js` / `src/lib/decision-config.cjs` / `plugin/core/hooks/gateway.cjs` / `plugin/decision/`
> 配置源：`plugin/config.json`（marketplace.plugins / mcpServers / hooks）+ `.awf/config.json`（`run.decision.enabled`）
> 测试：`tests/integration/decision-gate.test.js` / `tests/unit/{run-config,decision-config,decision,decision-instruction,decision-store,gateway,run-resume,run-logger}.test.js` / `sandbox/decision-smoke/smoke.cjs`

---

## 目标（Goal）

将原型 `plugin/awf-decision-system` 的设计落成一个**独立插件 `ai-workflow-decision`**，并在**单 agent** 运行编排中接通「决策闸门」：会话执行中遇到决策点（文字 `<AWF_DECISION_REQUIRED>` 标记或 `AskUserQuestion` 提问工具）时，**当前会话切换到自主决策内核（Decision Core, DC）**，由 AI 基于会话上下文直接产出结构化的 **Decision Result**（`answer` 驱动后续行动），全程记录进 **Review**（jsonl + 页面），支持人工 **override** 后**追加纠偏任务**回流执行。

由配置开关 `run.decision.enabled` 控制：**缺省关闭 = 完全保留既有上抛逻辑**（AskUserQuestion → decisionPending → CLI autoSelect / 人类明示路径）。**本轮只覆盖单 agent**；多 agent 决策闸门后置。

## 功能描述

- 新增独立 `core` 级插件 `ai-workflow-decision`（目录 `plugin/decision/`），随渲染器泛化注册为三插件市场一员（core / plugin-code / decision），无自己的 mcp/hooks/命令，只承载**决策技能与协议资产**。
- 决策技能资产：`skills/decision-core`（DC，纯决策内核，12 公理方法）、`skills/decision-workflow`（DW，调度权/记录权，供复杂/未来场景复用）、`decision/PROTOCOL.md`（DC↔DW 最小协议）、`decision/schemas/decision-result.schema.json`（权威 schema，本轮轻量校验不引 ajv）、`decision/mode-instruction.md`（决策模式短指令，server 注入进 block/deny）。
- 决策入口两处，共用同一套 server 决策状态机（`decisionGate`）与 Stop 闸门：
  1. **文字入口**：会话最后一行以 `<AWF_DECISION_REQUIRED>…</AWF_DECISION_REQUIRED>` 结尾 → Stop 闸门 ② 触发 block（`continuePrompt` = 决策模式指令）。
  2. **AskUserQuestion 入口**：PreToolUse 拦截 → deny（`reason` 指引模型改以决策标签收尾、勿再问）→ 落到同一 Stop 闸门 ②。
- 决策结果：模型产出 `<AWF_DECISION_RESULT>{DecisionResult JSON}</AWF_DECISION_RESULT>` 作为回合最后输出 → Stop ③ 捕获 → 解析/轻量校验 → 落 `.awf/decisions/runs/<runStamp>.jsonl`（`decision_completed`，`pending_review`）→ 置一次性 `decisionResume` → ready → CLI 续跑注入 answer 让原任务继续。
- 无有效结果兜底：deciding 中结束且无合法 Result → 统一 **deferred fallback** 落盘（`fallback:true`）→ ready，不悬空。
- Review：`GET /awf/decisions` 聚合读取、`/decisions.html` 页面浏览操作（标记 reviewed 客户端态 / Override）、`POST /awf/decisions/<id>/override` 追加 `decision_overridden` + 追加纠偏任务（`kind=dev` / `source=decision_review`），单 agent runLoop 下一轮 `findNextTask` 自然拾取。

## 执行流程

### 状态与角色落点

| 概念 | 落点 | 说明 |
|---|---|---|
| DECIDING / READY | server `decisionGate` 对象 | `null \| { phase:'deciding', startedAt }`；`/status` 暴露；独立于人类 decisionPending 单槽 |
| 续跑摘要 | server `decisionResume` | 最近一次闭合决策摘要（`{decision_id,answer,type,finality,fallback}`）；新事务开始时清空，一次性 |
| DC（决策内核） | `plugin/decision/skills/decision-core/` | 决策模式下由会话加载产出 Decision Result |
| DW（承载/记录/Review） | 分拆给 server（拦截+捕获+校验+落盘+fallback+override）；`decision-workflow` skill 保留 | 单 agent 决策由 server 编排足够 |
| 决策模式指令 | `plugin/decision/decision/mode-instruction.md` | server 经 `decision-instruction.cjs` 读入，注入 block `continuePrompt` / deny `reason`；改指令不动 server |
| 决策记录 | `.awf/decisions/runs/<runStamp>.jsonl`（追加式） | runStamp 对齐 run-logger `${version}-${ts}`；decision_id = `D-<ts-base36>-<seq>` |
| fallback | server 兜底（deferred 模板） | 无有效 answer / 解析失败 / 决策中断 → 兜底 deferred，仍落盘 + ready |
| Review | 同 jsonl + override 事件 | override 不覆盖历史，追加 `decision_overridden` |
| 纠偏任务 | server 追加 `kind=dev` 任务 | 复用 settleSubagent 的 state 写锁；runLoop 下一轮拾取 |

### Stop 统一闸门（server `handleStop`）

```
if !gateEnabled:                          // gate 关 → 现状逐字一致
    clearDecision + decisionGate=null + decisionResume=null + setReady + capture
else:
    if !deciding:
        if 文本以 <AWF_DECISION_REQUIRED>…</…> 结尾 && stop_hook_active !== true:
            decisionGate={phase:'deciding',startedAt}      // ② 触发，busy 保持不 ready
            记 decision_started 日志
            return { ccOutput:{ decision:'block', continuePrompt:<决策模式指令> } }
        else:                              // ① 普通完成
            clearDecision + decisionGate=null + setReady + capture
    else:                                  // ③ deciding 中收尾
        parsed = parseDecisionResult(text)
        有效 → persistDecision(parsed.result, 'text')
        无效 → persistDecision(deferredFallbackResult(), 'text')   // fallback:true
        decisionGate=null + clearDecision + setReady + capture
```

### AskUserQuestion 决策化（server `handleAskUserQuestion`）

```
if !questions: return null
if !gateEnabled:                        // gate 关 → 现状：setDecision 捕获，不拦截、无 ccOutput
    setDecision({type:multiSelect?'multiSelect':'choice', question, options, header, source:'AskUserQuestion'})
else:
    if decisionGate.phase==='deciding': // 决策闭合前禁再问（防递归）
        return deny（reason=禁止再问，请产出 <AWF_DECISION_RESULT> 收尾）
    else:                                // gate 开 & 非 deciding → deny，指引改标签收尾（与文字入口合一）
        return deny（reason=禁再问禁继续，请把问题以 <AWF_DECISION_REQUIRED>…</…> 放最后一行结束回合）
```

### 防递归伪代码（对齐设计稿 §6）

```
if gate.phase==deciding && 消息含 AWF_DECISION_RESULT: capture+落盘+fallback判断 → idle → setReady
else if stop_hook_active（已在 block 续跑轮，无有效结果）: deferred 落盘 → idle → setReady
else if 消息含 AWF_DECISION_REQUIRED: deciding → return block（busy 保持）
else: setReady
```

AskUserQuestion 在同一 deciding 事务内重复调用 → 拒绝并提示「决策闭合前禁止再问」；deny 只发一次，避免死循环。

### 单 agent 续跑（CLI `drainDecisionResume`）

- `executeTask` 首次 `waitForReady` 返回后读 `/status` 的 `decisionResume`；有则注入续跑消息「已收到 AWF 决策结果：`<answer>`（兜底注记）…请据此继续执行当前任务，完成后结束本回合」→ 再 `waitForReady`。
- 一次任务可能多次决策，循环续跑（上限 10 防死循环）；注入失败/超时安全停止。
- gate off 时 `decisionResume` 恒 null → drain 零操作；gate on 自动决策不产生 `decisionPending` ⇒ autoSelect 不介入（autoSelect 仅作 gate 关遗留路径保留）。

## 配置开关（run.decision）

| 配置 | 默认 | 说明 |
|---|---|---|
| `run.decision.enabled` | `false` | 决策闸门开关。`true` = 决策闸门激活（AskUserQuestion 不再 autoSelect → deny 转 DC；文字标记 → block 转 DC）；缺省/非法值回落 `false` = 旧上抛逻辑（AskUserQuestion → decisionPending → autoSelect/问人、子 agent NEEDS_INPUT → 主 agent 问人、await_choice/await_input 交互） |

- **单源防漂移**：判定实现收敛在 `src/lib/decision-config.cjs`（CJS，server/CLI 共用）：`DECISION_DEFAULT_ENABLED=false`、`decisionEnabledFrom(raw)`（仅接受布尔）、`isDecisionEnabled(projectRoot)`（读 `<root>/.awf/config.json`）。CLI `run-config.js` 的 `loadRunConfig` 委托它（decision 段 = `{ enabled: isDecisionEnabled(root) }`），无自带 DEFAULT/normalize。
- init 模板 `src/templates/awf-config.json` 含 `run.decision.enabled=false`，`awf init` 复制为 `.awf/config.json`；说明见 `docs/features/init.md`「awf-config.json」段。

## 核心常量 / 配置

| 常量 / 路径 | 值 | 说明 |
|---|---|---|
| `DECISION_DEFAULT_ENABLED` | `false` | 决策闸门缺省关闭（decision-config.cjs） |
| 记录文件 | `.awf/decisions/runs/<runStamp>.jsonl` | 追加式 jsonl；runStamp = `<state.version>-<ISO19>`（对齐 `.awf/logs/<version>-<ts>`） |
| `decision_id` | `D-<Date.now().toString(36)>-<seq36>` | server 捕获落盘时赋值（模型输出侧不产 id） |
| `decisionGate` | `null \| { phase:'deciding', startedAt }` | server 状态机；`/status` 暴露 |
| `decisionResume` | `null \| { decision_id, answer, type, finality, fallback }` | 一次性续跑摘要；新事务清空 |
| DECISION 结果必填 | `answer` / `type` / `finality` / `real_question` / `decisive_factors` / `reconsider_when` | 与 schema.required − decision_id 对齐；数组字段必须是数组（可空数组视为已提供） |
| `type` 合法值 | `resolved \| deferred \| no_action \| validation_required \| reframed` | mode-instruction 硬约束 |
| 续跑上限 | `10` | `drainDecisionResume` 防死循环 |
| gateway 端口/超时 | 缺省 `8787` / `2500ms` | `plugin/core/hooks/gateway.cjs` |

## 数据记录（DecisionStore）

- 记录事件：`decision_completed`（正式/兜底，`status:'pending_review'`，`fallback:true` 标记兜底，`source:'text'`）、`decision_overridden`（override 追加，不改写原记录）。
- `decision_completed` 字段：`runStamp` / `event` / `decision_id` / `status` / `fallback` / `source` / `created_at`(ISO，与 run 日志 logDecision `at` 同一) / `result`（完整 Decision Result，fallback 时为 deferred 模板结果）。
- 不变量：只追加绝不覆盖；幂等（同 `decision_id` 同一 run 文件不重复落盘，防 Stop 双触发）；override 追加进原 decision 所在 run 文件。
- run 日志：`RunLogger.logDecision` 写 `[<ISO>] [DECISION][decision_started|decision_completed|decision_overridden] <decision_id> <detail>` 到 `.awf/logs/<run>/main.log`，Review 页可按 created_at/decisionId 对齐。

## Review（API + 页面）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/decisions.html` | GET | Review 页面（深色，内联风格）：时间/Decision ID/问题/answer/type/finality/决定性因素/风险/未知/反转条件/fallback；决策被 override 时随原决策展示覆写日志；操作「标记 reviewed」（客户端本地态）+「Override」 |
| `/` dashboard | GET | 含「决策 Review」入口链接 |
| `/awf/decisions` | GET | 聚合列表：各 run 倒序扁平，含 decision_completed 与 decision_overridden 事件 |
| `/awf/decisions/<decisionId>/override` | POST | body `{ instruction(必填), original_answer? }`；400=缺 instruction、404=目标不存在；成功追加 `decision_overridden` + 纠偏任务，返回 `{ reviewTaskId }` |

- 纠偏任务：`appendDecisionReviewTask` 在 state 写锁下追加 `{ id: <decision_id>-REV, kind:'dev', status:'pending', source:'decision_review', deps:[], plannedFiles:[], constraints:[], prompt(含 instruction/original_answer), acceptance, exec:{ decision_id, instruction, original_answer } }`；已存在同 id 则幂等返回。

## 插件资产（ai-workflow-decision，plugin/decision/）

```
plugin.json                     # name ai-workflow-decision（render-config 泛化生成）
skills/decision-core/SKILL.md   # DC 决策内核（frontmatter name=decision-core，12 公理方法）
skills/decision-workflow/SKILL.md  # DW 调度权/记录权协议
decision/PROTOCOL.md            # DC↔DW 最小协议
decision/schemas/decision-result.schema.json  # 权威 Result schema
decision/mode-instruction.md    # 决策模式短指令（5 硬约束），server 注入
```

- Hook 形态：`config.json.hooks` 唯一源；`Stop` / `PreToolUse(AskUserQuestion)` 命令改为共享 `node "${CLAUDE_PLUGIN_ROOT}/hooks/gateway.cjs" <port>`（读 stdin → POST `/hook?event=<hook_event_name>` → 响应含顶层 `ccOutput` 则 JSON 打 stdout，否则无输出 exit 0；网络/解析异常静默 exit 0），其余事件保持裸 curl。hooks 只渲染进 core（不按插件拆分），避免双 Stop 竞态。
- 注册：`plugin/config.json` marketplace.plugins + `plugin/settings.json` plugins/enabledPlugins + 渲染器泛化（render-config.mjs 遍历 marketplace.plugins）；渲染产物 `plugin/<dir>/plugin.json` / `.claude-plugin/marketplace.json`；旧原型目录 `plugin/awf-decision-system/` 已删，集成方案归档 `docs/discuss/decision-system-design.md`。

## 函数清单

| 函数 | 说明 | 位置 |
|---|---|---|
| `isDecisionEnabled(projectRoot)` / `decisionEnabledFrom(raw)` | 决策闸门开启判定（单源，布尔语义） | `src/lib/decision-config.cjs` |
| `loadRunConfig(projectRoot)` | 读 `.awf/config.json` run.* 段；decision 段委托 decision-config | `src/lib/run-config.js` |
| `handleStop(body)` | Stop 统一闸门三分支（普通/②触发 block/③deciding 收尾） | `src/server/server.cjs` |
| `handleAskUserQuestion(body)` | AskUserQuestion PreToolUse：gate 关捕获 / 非 deciding deny / deciding 禁再问 | `src/server/server.cjs` |
| `persistDecision(result, source)` | 捕获落盘 + 置 decisionResume + run 日志 | `src/server/server.cjs` |
| `deferredFallbackResult()` / `nextDecisionId()` | 兜底 Result 模板 / `D-…` id 生成 | `src/server/server.cjs` |
| `appendDecisionReviewTask(...)` | override → 追加纠偏任务（state 写锁 + 幂等） | `src/server/server.cjs` |
| `parseDecisionResult(lastMessage)` / `validateDecisionResult(data)` | 抓 `<AWF_DECISION_RESULT>` JSON + 轻量必填校验 | `src/server/decision.cjs` |
| `DecisionStore`（runStamp/append/override/listRuns/listAll） | 追加式 jsonl 决策存储 | `src/server/decision-store.cjs` |
| `decisionPluginDir/decisionInstructionPath/readDecisionInstruction` | 按 marketplace 定位 decision 插件并读决策模式指令 | `src/server/decision-instruction.cjs` |
| `RunLogger.logDecision(...)` | 决策事件入 run 日志（时间与 store created_at 对齐） | `src/server/run-logger.cjs` |
| `drainDecisionResume(projectRoot)` | gate on 捕获后单 agent 续跑（注入 answer 继续原任务） | `src/cli/run.js` |
| `gateway.cjs main()` | hook 网关：转发 + 透传 ccOutput 到 stdout | `plugin/core/hooks/gateway.cjs` |

## 接口 / 依赖

| 模块 | 用途 |
|---|---|
| Claude Code Hooks（Stop / PreToolUse(AskUserQuestion)） | 决策入口拦截；`stop_hook_active` 区分触发轮/续跑轮 |
| `plugin/core/hooks/gateway.cjs` | Stop/PreToolUse 转发 + ccOutput 回传（决策 block/deny） |
| `decision-instruction.cjs` | server 读 `plugin/<decision>/decision/mode-instruction.md`（改指令不动 server） |
| `DecisionStore` / run-logger | 决策记录落盘 + run 日志对齐 |
| `.awf/config.json` `run.decision.enabled` | 开关（单源 decision-config.cjs） |
| `findNextTask`（`src/lib/state.js`） | runLoop 下一轮拾取纠偏任务 |
| decision 插件资产（DC skill / PROTOCOL / schema / mode-instruction） | 决策模式方法论与协议权威 |

## 边界（Boundary）

本轮决策闸门只作用于**单 agent 主会话**的决策入口；交互边界与状态边界见下表：

| 维度 | 边界 |
|---|---|
| 触发范围 | 仅单 agent 主会话；子 agent（`awf-worker`）不进入 DECIDING，其 NEEDS_INPUT → 主 agent 问人路径不变 |
| 拦截对象 | 文字 `<AWF_DECISION_REQUIRED>` 结尾标记 + `AskUserQuestion` 提问工具；`await_choice` / `await_input`（人类明示路径）不拦截 |
| 开关语义 | `run.decision.enabled=false` 或缺省 → 闸门整体不介入，与旧行为逐字一致 |
| 状态机 | `decisionGate` 全局单例（`idle`/`deciding`），不做 per-task / per-agent 扩展；一次事务从触发到闭合只允许一次捕获落盘 |
| 结果边界 | 无合法 Result → 统一 deferred fallback 落盘闭合；不做自动回滚 / 决策→Task 依赖图 |
| 校验深度 | 轻量字段必填校验（answer/type/finality/real_question/decisive_factors/reconsider_when），不跑完整 ajv schema |

> 详细「本轮明确不做」见上节 outOfScope。

## 关键场景（Scenario）

### 场景矩阵：gate 状态 × 会话收尾

| # | 场景 | 期望行为 | 对应分支 |
|---|---|---|---|
| S1 | gate 关，普通任务完成（Stop） | 清 decisionPending + ready + transcript 采集，无 ccOutput、无落盘 | Stop ①（现状） |
| S2 | gate 关，遇 AskUserQuestion | setDecision 捕获（不拦截、无 ccOutput）→ 走旧 decisionPending / autoSelect / 问人 | PreToolUse（现状） |
| S3 | gate 开，普通任务完成（多次 Stop） | 均 ready、无落盘、decisionGate 恒 null（不误触发） | Stop ① |
| S4 | gate 开，文字标记收尾（`<AWF_DECISION_REQUIRED>` + `!stop_hook_active`） | → deciding + block（`continuePrompt`=决策模式指令），busy 保持，一次事务只 block 一次 | Stop ② |
| S5 | gate 开，deciding 中 Stop 含合法 `<AWF_DECISION_RESULT>` | 解析 → 落盘 `decision_completed`（pending_review）→ 置 decisionResume → ready；CLI 注入 answer 续跑 | Stop ③ 有效 |
| S6 | gate 开，deciding 中 Stop 无有效结果（多次无结果） | 收敛到单条 deferred fallback 落盘（`fallback:true`）→ decisionResume → ready，不悬空不重复 | Stop ③ 兜底 |
| S7 | gate 开，遇 AskUserQuestion（非 deciding） | deny（reason 指引改以决策标签收尾）→ 转 Stop ② 进入 deciding（与文字入口合一） | PreToolUse deny |
| S8 | gate 开，deciding 中重复 AskUserQuestion | 拒绝（决策闭合前禁再问），不重新置 deciding | PreToolUse deciding |
| S9 | gate 开，结果落盘后重复同 decision Stop | 幂等：不重复落盘（防 Stop 双触发 / 防递归） | store 幂等 |
| S10 | override → 追加纠偏任务 | `decision_overridden` 追加原记录；`<decision_id>-REV`（kind=dev / source=decision_review）入列，runLoop 下一轮拾取 | Review API |
| S11 | override 非法输入 | 缺 instruction → 400；目标 decision 不存在 → 404 | Review API |
| S12 | 无 `stop_hook_active` 字段 | 缺省视作首次可触发（deciding 前可进入），deciding 后按结果/兜底闭合，判定不依赖该字段 | Stop ② |

## 范围（inScope / outOfScope）

### inScope

- 新增独立 `core` 级插件 `ai-workflow-decision`（目录 / 市场注册 / 渲染器泛化）。
- 决策技能与资产落地：decision-core / decision-workflow SKILL + PROTOCOL + decision-result.schema + mode-instruction 决策模式指令。
- `run.decision.enabled` 配置开关（缺省关 = 旧上抛逻辑不变）。
- 单 agent 决策闸门两入口（文字标记 / AskUserQuestion）→ 当前 Session 切 DC（Route A）。
- server `decisionGate` 状态 + Stop/PreToolUse decision-aware 处理 + hook gateway 命令（stdout 输出 block/deny）。
- Decision Result 解析 / 轻量校验 / deferred fallback / 防递归（一次闭环）。
- 决策记录 `.awf/decisions/runs/<runStamp>.jsonl` + Review 数据 API + decisions.html 页面 + override → 纠偏任务回流。
- 单元 / 集成测试（gate on/off 双路径）+ 真 run 冒烟 + 文档同步（README / CLAUDE.md / CHECKLIST 三插件化 + 集成方案归档）。

### outOfScope

- 多 agent 决策闸门 / per-agent DECIDING（子 agent NEEDS_INPUT → 主 agent 问人维持现状）。
- `await_choice` / `await_input` 明示真人路径的拦截分流。
- 决策 → Task 依赖图 / 自动计算受影响文件 / 自动回滚 / 复杂决策优先级。
- 完整 JSON Schema（ajv）校验（本轮轻量字段校验，schema 文件留作权威参考）。
- Review 复杂排序 / 批量操作 / 多层 Decision 状态机。
- 把 Decision 落成普通业务 Task（任务系统与决策系统套娃防护）。

## 验收标准

- [x] `run.decision.enabled` 缺省为关；关闭时 AskUserQuestion → decisionPending → 旧 autoSelect/问人路径行为不变（回归通过）。
- [x] 开启后：文字 `<AWF_DECISION_REQUIRED>` 与 AskUserQuestion 两入口均被闸门捕获并转当前会话 DC。
- [x] 普通任务结束不触发 gate；一次决策事务只闭合一次（deny 一次、防递归、无结果有 fallback）。
- [x] DC 产出合法 Decision Result → 落 `.awf/decisions/runs/*.jsonl`（pending_review）；无有效结果 → deferred fallback 不悬空。
- [x] Review 数据可聚合读取；decisions.html 页面可浏览并 override；override 追加纠偏任务（kind=dev, source=decision_review）且 runLoop 下一轮拾取。
- [x] `ai-workflow-decision` 注册为第 3 个插件，config / settings / render 产物 / 文档三插件化一致（不再称双插件）。
- [x] 单元 + 集成测试绿（gate on/off 双路径）；真 run 冒烟证据落库（`sandbox/decision-smoke/smoke-evidence.json`，11/11）。

> 门禁状态：T3-003（server 状态机与 Hook）pass、T3-004（记录与 Review）pass、T3-005（编排收尾与回归，含冒烟证据）pass；配置开关语义 T3-002 pass。
