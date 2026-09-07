# AWF Decision System 架构定稿（v0.2.0 决策闸门 · 单 agent）

> 关联原型：`cc-control/plugin/awf-decision-system/`（设计产物，未接线）
> 讨论日期：2026-09-06
> 已定决策（用户）：独立 ai-workflow-decision 插件 / 核心闭环含 Review 页面 / 当前 Session 切 DC / 本轮只做单 agent

## 1. 目标链路（Route A：当前 Session 切 DC）

### 1.1 文字型入口

```text
/w-dev T1 派发
  → agent 某轮最终文字含 <AWF_DECISION_REQUIRED>…</AWF_DECISION_REQUIRED>
  → Stop hook（gateway 命令）→ server Stop handler（decision-aware）：
      解析 last_assistant_message 含标记 && !stop_hook_active
        → 置 decisionGate.state='deciding'（不 setReady，busy 保持）
        → 返回 block → gateway 打印到 stdout
          { decision:"block", continuePrompt:"<决策模式短指令>" }
  → CC 继续当前会话：按指令调 ai-workflow-decision:decision-core，禁再问人
  → 产出 <AWF_DECISION_RESULT>{DecisionResult JSON}</AWF_DECISION_RESULT> 后结束回合
  → Stop 再次触发（stop_hook_active=true）→ server：解析结果→轻量校验→
      写 .awf/decisions/runs/<runStamp>.jsonl → deciding=false → setReady
  → CLI waitForReady 返回 → settleTask → 下一任务
```

### 1.2 AskUserQuestion 入口

```text
agent 调 AskUserQuestion(questions/options)
  → PreToolUse(AskUserQuestion) hook（gateway）→ server：
      置 deciding；返回 deny → gateway 打印
        { hookSpecificOutput:{ hookEventName:"PreToolUse",
          permissionDecision:"deny",
          permissionDecisionReason:"<转 decision-core 指令>",
          updatedInput:{ questions:[] } } }
  → agent 转 DC → 产出 <AWF_DECISION_RESULT> → Stop（stop_hook_active=false）→ 同上捕获/ready
```

### 1.3 单 agent 语义

决策发生在任务内部：block/deny 后的续跑让同一会话「先决策、再继续原任务」，
最终 Stop 以正常任务完成结束。CLI run.js **happy path 不需要改动**——
server 在 deciding 期间不翻 ready，waitForReady 自然等待；超时由既有任务超时兜底。

## 2. 状态与角色落点

| 概念 | 落在哪 | 说明 |
|---|---|---|
| DECIDING/READY | server `decisionGate` 对象（新，独立于人类 decisionPending 单槽） | `{phase:'idle'\|'deciding', entry:'text'\|'ask_user_question'}`；`/status` 暴露供 CLI/dashboard |
| DC（自主决策内核） | `plugin/decision/skills/decision-core/` | agent 在决策模式加载它产出 Decision Result |
| DW（承载/记录/Review） | 分拆：server 承担拦截+捕获+校验+落盘+fallback+override；decision-workflow skill 保留供复杂入口/未来多 agent 复用 | 单 agent 决策由 server 编排足够 |
| 决策模式指令 | `plugin/decision/decision/mode-instruction.md` | server 经 plugin-bridge 读入并拼进 block/deny 消息；改指令不动 server |
| 决策记录 | `.awf/decisions/runs/<runStamp>.jsonl`（追加式） | runStamp 对齐 run-logger `${version}-${ts}`；decision_id = `D-<seq>` |
| fallback | server 兜底（deferred 模板） | DC 无有效 answer / 解析失败 / 决策中断 → 兜底 deferred，仍落盘+ready |
| Review 数据 | 同 jsonl + override 事件 | override 不覆盖历史，追加 `decision_overridden` 记录 |
| 纠偏任务 | server 追加 kind=dev 任务（source:decision_review） | 复用 settleSubagent 的 state 写锁；单 agent runLoop 下一轮 findNextTask 自然拾取 |

## 3. 防递归（对齐设计 §6 伪代码）

```text
if gate.phase==deciding && 消息含 AWF_DECISION_RESULT:
    capture+落盘+fallback判断 → gate.phase=idle → setReady → return
if stop_hook_active:  // 已在 block 续跑轮，但无有效结果 → 兜底
    gate.phase=idle → deferred 落盘 → setReady → return
if 消息含 AWF_DECISION_REQUIRED:
    gate.phase=deciding → return block（busy 保持）
normal: setReady
```

AskUserQuestion 在同一 deciding 事务内重复调用 → 拒绝并提示「本次决策闭合前禁止再问」；deny 只发一次，避免死循环。

## 4. Hook 形态改造（单源 + gateway）

- config.json.hooks 仍为唯一源，只渲染进 core（**不按插件拆分**）——避免双 Stop 竞态。
- Stop 与 PreToolUse(AskUserQuestion) 两条命令由「裸 curl 丢 stdout」改为共享 gateway 脚本：
  `node <dir>/hooks/gateway.cjs`——读 stdin payload → POST 给 server → server 返回含 `ccOutput` 时打印之，否则无输出 exit 0。
- 其余事件（SessionStart/UserPromptSubmit/SubagentStart/SubagentStop/PostToolUse）维持现形态。
- hooks.test.js / render-config.mjs 需同步更新。

## 5. server 新增

- `decisionGate` 状态；Stop/PreToolUse 分支改造（取代 Stop「一律 clearDecision+setReady」）。
- `parseDecisionResult(last_assistant_message)`：抓 `<AWF_DECISION_RESULT>{…}`（仿 parseSubagentResult）。
- `decision-store.cjs`（类比 run-logger）：resolve runStamp、追加/读 jsonl、list API。
- 轻量 Result 校验函数（answer 非空 + type/finality/real_question 等必填；不引入 ajv，schema 文件作为权威供工具/未来扩展）。
- 端点为 Review 页服务：`GET /decisions.html`、`GET /awf/decisions`、`POST /awf/decisions/<decisionId>/override`（写 override + 追加纠偏任务）。

## 6. 插件（ai-workflow-decision）

目录 `plugin/decision/`：
```
plugin.json                     # name ai-workflow-decision（render 泛化后生成）
skills/decision-core/SKILL.md   # 从 awf-decision-system 迁移
skills/decision-workflow/SKILL.md
decision/PROTOCOL.md
decision/schemas/decision-result.schema.json
decision/mode-instruction.md    # server 经 plugin-bridge 读取
README.md
```
注册：config.json marketplace.plugins + settings.json plugins/enabledPlugins；
渲染器泛化（render-config.mjs 由写死 core/plugin-code 改为遍历 marketplace.plugins）；
迁移完成后删除 `plugin/awf-decision-system/` 旧目录，集成方案文档归档到 docs/discuss。

## 7. Review 页面

`src/server/decisions.html` + dashboard 链接。字段（设计 §14）：时间/Decision ID/问题/answer/类型/finality/决定性因素/风险/未知/反转条件/fallback。操作：标记 reviewed / override（写入 instruction → 生成纠偏任务）。聚合展示 `.awf/decisions/runs/*.jsonl`，新在前。

## 8. 本轮明确不做（多 agent / 边界）

- 子 agent NEEDS_INPUT → 主 agent 问人路径保持不变（DECIDING 不扩展到 per-task/per-agent）。
- await_choice/await_input（人类明示路径）不拦截。
- Review 复杂排序 / 影响图 / 自动回滚 不做。
- 决策→Task 依赖图不做。

## 9. 配置开关（用户确认）

新增 `run.decision.enabled`（bool，.awf/config.json，run-config.js 加载，缺失=旧行为）：

- **未配置 true / false** → 完全保留既有上抛逻辑：
  - AskUserQuestion → PreToolUse 置 decisionPending → CLI autoSelect/问人（现行为）；
  - 子 agent NEEDS_INPUT → 主 agent 问人；
  - await_choice/await_input 交互。
- **= true** → 决策闸门激活（本轮单 agent）：
  - AskUserQuestion **不再走 autoSelect 默认选项** → deny 转 DC；
  - 文字 `<AWF_DECISION_REQUIRED>` → block 转 DC；
  - 捕获/校验/落盘/fallback/Review。

> autoSelect 函数仅作为 gate 关闭时的遗留路径保留；gate 开启时不调用。

## 10. Hook 语义已验证（用户确认）

Stop 返回 `decision:block` + continuePrompt 让会话续跑、PreToolUse deny AskUserQuestion 并反馈提示词——**已实测可行**。故不设 spike 任务，直接进入实现；但须配一条集成测试验证「普通结束不触发 / 标记触发 / deny 后转 DC / 防递归」。

## 11. 验证缺口（转为测试任务，非 spike）

1. 单 agent 真实 run：普通完成不触发 gate；文字标记触发 block 一次；DC 结果落盘后正常推进。
2. AskUserQuestion deny 后模型稳定转入 decision-core，不再弹真实 UI。
3. `stop_hook_active` 随 payload 透传是否真实可用（实现时在集成测试中确认，若有出入用 fallback 语义兜底——无 stop_hook_active 也能靠「deciding 态 + 消息含/不含 DECISION_RESULT」判定）。

## 12. 实现细化决定（2026-09-07 用户逐项拍板）

依据 `cc-control/docs/discuss/hook-interception-experiment.md`（Claude Code 2.1.247 实测）收敛：

- **协议事实**：Stop 输入含 `last_assistant_message` / `stop_hook_active`；标签判定 `/DECISION_REQUIRED…\s*$/`（结尾）；PreToolUse AskUserQuestion deny 用 `hookSpecificOutput.permissionDecision`（勿用顶层 decision）；`reason`/`permissionDecisionReason` 注入为合成消息供模型行动；连续 block 有 8 连硬上限（不作设计边界）。
- **B1 拦截语义**：按参数 `run.decision.enabled` 全拦，不做有人/无人探测；误伤靠 Review + 纠偏兜底。
- **B3 决策模式提示词**：mode-instruction 内联硬约束（禁问人、只输出 `<AWF_DECISION_RESULT>`、answer 非空、必需字段），decision-core 作为方法论补充；不依赖模型成功加载 skill。
- **B4 无结果结束**：deciding 中结束无 RESULT → 统一 deferred fallback 落盘 → ready（延后处理）。
- **B5 合一链路 + CLI 续跑**：
  1. PreToolUse(AskUserQuestion) gate on → deny，reason 指引模型改为「最后一行输出 `<AWF_DECISION_REQUIRED>`…</…> 并结束本回合（勿再问/勿继续）」→ 两入口合一。
  2. Stop（tagged && !stop_hook_active）→ block，reason = 决策模式指令（要求决定后以 RESULT 为最后文本并停）。
  3. Stop（stop_hook_active=true && 含 RESULT）→ parse/store 落盘 → 置一次性 `decisionResume`（/status 暴露）→ ready。
  4. CLI run.js waitForReady 探测 decisionResume → 注入续跑消息（answer + 继续原任务）→ 继续等待直至任务完成。
  - server 状态机最简、两入口同一套；AskUserQuestion 在 deny 后不立即 DC，先落成标签再走同一 Stop 闸门。
