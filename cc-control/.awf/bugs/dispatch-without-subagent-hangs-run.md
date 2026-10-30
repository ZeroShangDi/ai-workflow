# 派发提示词被收下却没派子 Agent：任务留在 active，整轮干等到超时

- 状态: fixed（2026-09-13，`server/run/transport.cjs` 派发生效确认 + 重派提示词）
- 严重度: high — 4 次实现跑出 2 次卡死（~50%），run 静默停摆到 15min 无变化窗口耗尽
- 类型: awf 产品缺陷（多 agent 派发 / 「派发是否真的发生」缺判据）
- 关联: `server/run/transport.cjs`（dispatch）、`server/runtime/index.cjs`（`batchTransportFor` 端口）、
  `plugin/plugin-code/prompts.json`（`subagent-dispatch` / `subagent-redispatch`）、
  `server/run/host.cjs`（driveBatch）、`server/run/scheduler.js`（补位循环）、
  相关 `.awf/bugs/timeout-must-confirm-no-cc-change.md`（无变化窗口超时）

## 现象

多 agent 并行用例偶发卡死：run 日志停在最后一句「在跑：X1」，主会话此后不再被唤醒（ctx 7%、空闲）。
state 上表现为**一个任务停在 `active` 且没有任何子 Agent 生命周期事件**。

两个现场（沙箱可能已清理，同形态可复现）：

| 现场 | state 终局 | 缺事件的任务 |
|---|---|---|
| `sandbox/e2e/multi-agent-parallel-2026-09-13T10-56-01` | T1/T2/T4 done、**T3 active**、R3/X2/D1 pending | T3 |
| `sandbox/eval/multi-agent-parallel-2026-09-13T08-57-52` | 除 **X1 active** 外全 done、D1 pending | X1 |

共同点：派发提示词**已经注入会话且被主会话收下**（main.log 有该任务的「提示词」块），
但 `subagent-events.jsonl` 里没有对应的 `SubagentStart` —— 健康运行里每次派发都在 2~4s 内产生一条
（11 派发 / 11 Start），卡死那次是 8 派发 / 7 Start。

## 根因

**主会话没有任何拦截，是模型自己编造了一条拦截信息，然后拒绝派发。**

两例的 transcript（`~/.claude/projects/.../<sid>.jsonl`）里，模型 **thinking** 原文：

| 现场 | thinking 原文 | 事实 |
|---|---|---|
| 10-56-01 T3 | 「There's a hook notification: `[Dispatch] 该任务已有派发记录`」 | 全仓库 / 全局 hooks / transcript 输入里均无此物 |
| 08-57-52 X1 | 「工具调用被用户拒绝了。用户说：『暂时不要给子任务派发 X1』」 | 同上；该会话是 `bypassPermissions`，不存在拒绝 |

排查判据（可复用）：把该句在 transcript 里 `grep` —— 只出现在 `thinking` / `text` 里、输入侧没有，
就是幻觉。系统侧本就不存在派发去重：`plugin/core/hooks/hooks.json` 的 `PreToolUse` 只 match
`AskUserQuestion`，`server/web/api/hook.cjs` 也只在该工具上分支；真正的去重是宿主在 state 层用
`markActive` 做的，主会话完全不必参与。

**为什么会卡死（真正的系统缺陷）**：`dispatch()` 当时只把 `send` 是否抛错当作派发结果。

```
markActive(task) → send(text)（send 内部等到会话回 Stop、返回 true）→ dispatch 返回 true
```

主会话回合正常结束、提示词也确实收下了，只是没派生任何子 Agent —— 上面每一步都不报错，于是：
任务被留在 `active`，调度器只对 `pending` 任务补位（永不重派），`waitAnyDone` 的空闲窗口又被
`Stop` 事件的推进探测反复重置的依据全无 —— 一路干等到 15min 无变化窗口耗尽才整轮报错。

即：**「提示词投递成功」被当成了「派发已发生」，二者之间缺一个判据。**

## 修复

1. **派发生效确认**（`server/run/transport.cjs`）：`send` 返回后确认「本回合确实起了子 Agent」——
   按 `subagent-events.jsonl` 的 `SubagentStart` 计数（`send` 内部已等到 Stop，故返回时本回合已结束，
   通常一次检查即可）。判据两分支：
   - 起了子 Agent → 派发成立；
   - 任务已被别处结算（done/blocked）→ 无需再派，也算成立。
   未成立 → `releaseActive` 回滚占用，换 `subagent-redispatch` 提示词**再派一次**；
   连续 `DISPATCH_MAX=2` 次未成立 → 标 `blocked` 跳过（与收尾协商「多轮无产出 → blocked」同语义）。
   窗口 `DISPATCH_ACK_MS`（缺省 15s，env `CC_BATCH_DISPATCH_ACK_MS`）、轮询 `ACK_POLL_MS`（1s）。
2. **提示词堵掉借口**（`plugin/plugin-code/prompts.json`）：
   - `subagent-dispatch` 删掉「严禁重复派发同一任务」——那句正是被拿来当「有派发记录所以不派」的理由；
     改为「要不要去重由调度方在 state 层判定，你不需要判断、更不得据此跳过派发」，
     并加「无派发门槛」段（本项目没有会拦截派发的 hook；调用失败就重试一次并如实回报，禁止只回文字）。
   - 新增 `subagent-redispatch`：点明「上一回合没有任何子 Agent 被派生」并要求立刻补救。
     桥接见 `server/shared/prompts.js` 的 `subagentRedispatch`。

## 验证

- 单测 `tests/unit/batch-transport.test.js`：新增「派发生效确认」3 例（重派成功 / 重派仍无 → 回滚 + blocked /
  等待期间被别处结算 → 不重派）；该文件原本指向已无调用方的旧树 `src/server/batch-transport.cjs`，一并指回新树。
- 真 e2e `multi-agent-parallel`：11 派发 / 11 `SubagentStart` / **0 次重派** / 0 告警 / 11 任务全 done ——
  确认确认机制在健康路径上不会误判。

## 未覆盖 / 边界

- **e2e 无法稳定复现**：要真模型主动拒绝才触发，不能靠用例构造，该形态只有单测保护。
  集成侧 `tests/integration/batch-host.test.js` 走的是「任务已结算」分支。
- 两次派发都不成立时标 `blocked` 而非重试到底：依赖该任务的门禁任务会因此停在 `pending`，
  run 以「部分完成」收尾 —— 比静默卡死可诊断，但仍是失败，需人工/监控介入。
- 主会话编造拦截信息本身属模型行为（本机 e2e 跑在本地代理后的 `deepseek-flash` 上），不在本缺陷范围内；
  本条修的是「系统不该因为主会话不配合而死锁」。
