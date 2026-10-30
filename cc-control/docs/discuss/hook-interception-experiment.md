# Claude Code Stop 与 AskUserQuestion 阻断实验（decision 上抛新通道探测）

> 日期：2026-09-06 · Claude Code 2.1.247 · 模型 opus · 隔离目录 `/private/tmp/cc-hook-experiment-20260906`（仓库无改动）
> 实验动机：验证能否用「hook 阻断 + 提示词反馈 + `<DECISION_REQUIRED>` 标签」把 CC 原生 `AskUserQuestion` 的上抛路径关掉、改走一条可由 awf CLI 消费的确定性通道。触发：awf 决策层讨论。

## 一句话结论

**可行，机制已实测跑通。** `PreToolUse(AskUserQuestion)` 能拦截提问工具，`Stop` 能拦截「结束」，两者都能把一段提示词喂回模型让它继续，且能基于模型最后一句里的 `<DECISION_REQUIRED>` 标签决定是否放行。但该链路对模型输出是**协作式（非强制）**，且有副作用（Stop 被拦会显示为 hook error、额外烧一轮）。它**证明了机械可行性，不等于 awf 决策层该这么接**——接不接、怎么接是下一个设计问题（见文末）。

## 现状对照（awf 决策捕获 = 观察式，本次实验 = 拦截式）

| | awf 现状（`src/server/server.cjs` /hook） | 本次实验 |
|---|---|---|
| `PreToolUse(AskUserQuestion)` | **不拦截**：把问题拷进 `decisionPending`，CLI 轮询 `/status` 处理 | **拦截**：`permissionDecision:"deny"`，工具不执行 |
| `Stop` | 只做闩锁翻转（busy→ready）+ transcript 采集，**不返回 block** | 返回 `decision:"block"` + `reason` → 模型被要求继续 |
| 决策谁问 | 主 Agent 原生 AskUserQuestion（CLI 自动选/readline / 注入回答） | （设想）子 Agent 自己带标签收尾，CLI 解析标签处理 |

## 实测链路（三段，全绿）

### ① Stop 拦截 + 提示反馈（`claude -p` stream-json 可复现）

```jsonc
// Stop hook 输入（v2.1.47+ 自带最后一条回复，无需读 transcript）
{
  "hook_event_name": "Stop",
  "last_assistant_message": "<DECISION_REQUIRED>Which mode?</DECISION_REQUIRED>",
  "stop_hook_active": false
}
```

hook 检测到 `last_assistant_message` 以 `<DECISION_REQUIRED>…</DECISION_REQUIRED>` 结尾 → 返回：

```json
{ "decision": "block", "reason": "…检测到待决策标记。不要结束，输出 STOP_BLOCK_RECOVERED。" }
```

stream 显示完整二次循环：

```
assistant: <DECISION_REQUIRED>Which mode?</DECISION_REQUIRED>
  → hook Stop block → 合成 user 消息:
     "Stop hook feedback:\nHOOK_STOP_FEEDBACK: …输出 STOP_BLOCK_RECOVERED…"
  → assistant: STOP_BLOCK_RECOVERED      （stop_hook_active:true → 放行，end_turn）
```

### ② AskUserQuestion 拦截 + 反馈（真实交互式 tmux，`-p` 无该工具）

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "提问工具已被拦。请改在最后一行输出 <DECISION_REQUIRED>…</DECISION_REQUIRED>。"
  }
}
```

结果：**无提问弹窗**；界面显示 `Error: <reason>`，模型随即输出标签收尾。⚠️ 用 `hookSpecificOutput.permissionDecision`，勿用旧的顶层 `decision`（PreToolUse 已废弃）。

### ③ 两钩串联：ask 被拦 → 模型带标签收尾 → Stop 拦停 → 放行

```
PreToolUse deny: "改输出 <DECISION_REQUIRED>Pick A or B?</DECISION_REQUIRED>"
  → 模型: <DECISION_REQUIRED>Pick A or B?</DECISION_REQUIRED>
  → Stop(active:false, tagged) → block: "不要结束，输出 COMBINED_FLOW_RECOVERED"
  → 模型: COMBINED_FLOW_RECOVERED
  → Stop(active:true, 未tagged) → 放行 ✅
```

## 关键坑 / 边界（实测得出）

| # | 结论 | 实证 |
|---|------|------|
| 1 | **别解析 `transcript_path` 取最后一句**——Stop 被拦后再触发时 transcript 可能还没刷到最新 assistant 消息 | 第一次用 transcript 解析：第二次 Stop 仍 `tagged:true`（读到旧消息）；改用 `last_assistant_message` 后正确识别新消息 |
| 2 | **必须看 `stop_hook_active`**：`false`= 本轮首次（可拦），`true`= 已因 Stop 续跑过（通常放行）。不看它 → 模型若继续带标签会循环 | 事件流：`active:false → block → 模型合规去掉标签 → active:true → 放行` |
| 3 | **8 连拦有硬上限**（v2.1.143+）：同轮连续 block 8 次即放弃并告警，`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 可调 | 文档确认；是防死循环的安全网，别依赖它当设计边界 |
| 4 | Stop 被拦在 UI 上显示为 `Stop hook error` / `stop-hook-error` 通知，但 hook 命令本身 `outcome:"success"` | 属 CC 对「阻止结束」的呈现，不是命令失败 |
| 5 | **hook 改不了已输出的最后一句**。标签必须靠模型配合产出（常驻规则 / deny 反馈里要求重写）→ 纯协作式 | 见链路③：二次指令后模型才去掉标签合规 |
| 6 | 模型如果**不调 AskUserQuestion、直接输出一个普通问句**就停：纯标签匹配的 Stop 拦不住 | 只测了「标签结尾」一条判定；问句形态判定未测 |

## 反馈通道语义（本项目文档里查不到、值得固化）

- **Stop 的 `reason`**：以合成 `user` 消息注入模型上下文（实测可见 `isSynthetic:true` 的 user 消息，内容前缀 `Stop hook feedback:`）。这是「拦停后喂提示」的可靠通道。
- **PreToolUse 的 `permissionDecisionReason`**：拦下后在会话里显示为 `Error:` 行，模型**能据此行动**（实测续走）。同字段语义、交互 vs `-p` 差异、`additionalContext`（同文件在 `hookSpecificOutput` 内的另一通道）各自注入到上下文的准确路径**未逐一区分**，要真上生产需再定向验证。

## 判定代码（可直接复用）

```js
const text = input.last_assistant_message?.trim() ?? "";
const tagged = /<DECISION_REQUIRED>[\s\S]*<\/DECISION_REQUIRED>\s*$/.test(text);
if (input.hook_event_name === "Stop" && tagged && !input.stop_hook_active) {
  // 输出 { decision:"block", reason:"…" }
}
```

## 对 awf 的启发与未决问题（下一轮设计）

- **启发**：拦截能力 + `reason`/`permissionDecisionReason` 反馈 + 标签 = 「把需要人的决策，从 CC 原生工具形态改成 CLI 可确定性解析的文本协议」的机械基础。若要让子 Agent 在自身会话内收尾上抛决策（免 NEEDS_INPUT→主 Agent 二次 hop），此通道是候选。
- **未决**：① 标签内结构化信息（题干/选项/multiSelect）的承载格式与解析；② Stop 拦截「多烧一轮 + hook error 观感」的代价是否可接受；③ 纯协作式（模型忘带标签即漏）如何兜底——是否要保留 AskUserQuestion 捕获做 fallback；④ 标签 vs 现有 `decisionPending` + `/respond` 注入回答，谁持有决策权威，避免双轨冲突。
- **倾向（未定）**：先不推翻现有「原生 AskUserQuestion 捕获→CLI 处理」主线；把本次能力作为**被拦/无人值守时**的可选补充，避免为机械可行就重做决策层。

## Sources

- [Hooks reference](https://code.claude.com/docs/en/hooks) — Stop/SubagentStop 输入含 `last_assistant_message` / `stop_hook_active`；Stop `block`+`reason`；PreToolUse `hookSpecificOutput.permissionDecision(allow|deny|ask|defer)`；多 hook 决策优先级 deny>defer>ask>allow
- [Hooks guide](https://code.claude.com/docs/en/hooks-guide) — Stop hook 应检查 `stop_hook_active`
- [Changelog](https://code.claude.com/docs/en/changelog) — v2.1.47 加 `last_assistant_message`；v2.1.143 加 8 连拦上限 + `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`
