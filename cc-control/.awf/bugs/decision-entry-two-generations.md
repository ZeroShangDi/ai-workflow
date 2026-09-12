# 决策两条链纠缠：应互斥的「人工上抛」与「AI 自决」没有互斥开关

- 状态: **待调整**（2026-09-10 记录，含已知中间态）
- 类型: 架构缺陷（决策入口未互斥）+ 三个具体缺陷
- 关联: T1-106（旧决策入口处置，任务图末位）、`docs/discuss/decision-system-design.md`、
  `plugin/decision/decision/PROTOCOL.md`
- 触发: 2026-09-10 真 run，T1-098 调 `awf_await_choice` 问「回归 A 还是 B」；用户答完时 run 已结束，
  答案静默丢弃

## 应有形态（用户裁定）

**两条链是互斥选项，不该同时活着、更不该共用同一个槽：**

| | 场景 | 谁做决定 |
|---|---|---|
| A. 人工上抛 | 需要**人**拍板的事 | 上抛到页面/CLI，人给答案 |
| B. AI 自决 | 应当由 AI 决的事 | 决策门阀切 DC，产出 Decision Result |

一个开关选其一。现状是两条都活着，且互相踩。

## 两条链完整链路（2026-09-10 代码实读）

### A. 人工上抛（旧代 `awf_await_choice`）

```
CC 调 awf_await_choice
  → awf-session MCP → POST /choice
  → server setDecision(pcx, {type:'choice', question, options})   ← 立即返回 {ok:true}，CC 不等
  → CLI observeRun 每 200ms 轮询 /status 看到 decisionPending → handleDecision → readline 问人
  → 用户答 → POST /respond {value} → server 把 value 当一条普通 prompt submit 进会话
```
无开关（工具常驻暴露）。

### B. AI 自决（新代 决策门阀 / DC）

```
CC 回合文本以 <AWF_DECISION_REQUIRED>…</AWF_DECISION_REQUIRED> 结尾（且 stop_hook_active !== true）
  → Stop hook → /hook → handleStop → classifyStop = 'deciding'
  → 置 decisionGate={phase:'deciding'}（保持 busy，不 setReady）
  → block ccOutput = decision/mode-instruction.md（「你处于决策模式…最后只输出 <AWF_DECISION_RESULT>」）
  → CC 切 DC 自决 → 产出 <AWF_DECISION_RESULT>{...}
  → 再次 Stop → classifyStop = 'resolve' → parseDecisionResult → persistDecision
     → 落盘 .awf/decisions/runs/*.jsonl + 置 decisionResume + 事件 decision.record
  → CLI observeRun 看到 decisionResume → injectResumeOnce → POST /send「已收到 AWF 决策结果：…」
  → CC 接着干
```
开关：`run.decision.enabled`（**模板默认 false**，本项目 true）。
`AskUserQuestion` 是 B 的另一个入口（gate on → deny + 指引改用决策标签）。

## 具体缺陷（代码级，均已定位）

1. **gate off 时决策标签没有出口**
   `classifyStop` 首行 `if (!enabled) return { branch: 'complete' }`。默认配置 `decision.enabled=false`，
   于是 `<AWF_DECISION_REQUIRED>` 不触发任何流程 —— CC 输出标记后任务悬空，只能等收尾协商 fuse 标 blocked。
   与「两条链互斥开关」直接相关：不开 B 就必须走 A，不能变成一个都不通。

2. **gate on 时 A 的 pending 会被 B 的 Stop 抹掉**
   `handleStop` 的 `complete` 分支（普通回合结束）执行 `clearDecision(pcx)` → `decisionPending = null`。
   CC 调完 `awf_await_choice` 结束回合，紧跟着的 Stop 就把它清掉 —— 两条链共用 `decisionPending` 一个槽，
   谁后到谁覆盖。

3. **答案丢了不报错（假成功）**
   `/respond` 在 `decisionPending` 为 null 时**不报错**，只把 `value` 当普通 prompt 注入；
   CLI 的 `handleDecision` **不检查响应**就打印 `✔ 已选择`。2026-09-10 现场就是这样：run 已结束、
   tmux 已关，`/respond` 回 503，用户看到「已选择」但答案被静默丢弃。

4. **引导资产把 CC 往旧路带**（已部分处理，见下）
   `awf init` 注入项目 CLAUDE.md 的模板、`awf-run-decision` 技能、`task-settle`/`batch-dispatch`/
   `batch-reconcile` 提示词，全都在教「需要决策 → 调 awf_await_choice」。

## 已知中间态（2026-09-10 改动，**尚未收尾**）

`1289ddc（refactor(decision)）` 已做：清空 `src/templates/CLAUDE.md.template`（该注入弃用）、`init.js` 空模板跳过注入、
三处提示词改为输出 `<AWF_DECISION_REQUIRED>`、`CLAUDE.md`/`awf-run-decision`/`w-pause` 文案收敛。

**遗留问题**：提示词改成决策标签后，**默认 `decision.enabled=false` 的项目会命中缺陷 1（没有出口）**。
本项目（true）不受影响。这是「互斥开关」缺失的直接后果，不是文案问题。

## 用户裁定（2026-09-10）

- **互斥化暂不做**（还在考虑）。现阶段**统一走自动决策（新代门阀）**即可。
- 将来做互斥时，**验收里必须包含：需要人工决策时，页面上要能出选择提示** ——
  旧代的价值是「上抛到页面给人决策」，而现在 `handleDecision` 只在 CLI 终端 readline，
  页面上没有待决选择入口。
- 失败自动定位 / 自愈**不在此任务**：与「动态任务规划」能力配套上线。

## 待调整方向（候选，未定）

1. **默认开关**：新代既然是目标形态，`src/templates/awf-config.json` 的 `decision.enabled` 默认应为 `true`。
2. **提示词出口与开关一致**：或按开关渲染（插件感知开关），或措辞中性 + 运行期注入。
3. **槽隔离**：两代不得共用 `decisionPending`；或彻底合并为一个入口，另一个在开启时不可达。
4. **补失败可见性**：`/respond` 无 pending 时显式报错；CLI `handleDecision` 检查响应再报「已选择」。
5. **真机验证缺口**：B 链（deciding → resolve → resume）目前只有 server 侧单测/集成测试覆盖，
   真 run 里从未走到过；调整前应先在真机走通一次。
