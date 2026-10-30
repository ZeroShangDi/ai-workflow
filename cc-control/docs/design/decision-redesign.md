# 决策记录改造：统一字段、记录与展示

> 2026-09-30 · 状态：**设计已定稿，待实施**
> 触发：决策页希望对「AI 自决」与「人工介入」统一展示；在把数据迁进数据库之前先定字段。
> 前置讨论：`docs/discuss/decision-record-fields.md`（现状调查：三条入口链的字段覆盖、16 字段权威表、三个已查实的坑）
> 关联：`.awf/issues/016-decision-lifecycle-records.md`、`.awf/bugs/decision-entry-two-generations.md`、`PROTOCOL.md`

## 1. 目标与范围

**目标**：awf run 期间产生的每一个决策，都按同一套字段记录、在同一处展示、在同一处复审。

**本版做的（场景 3）**：run 期间所有问题由 AI 自决，人工**事后**复审。

**本版不做的**：

| 场景 | 处理 |
|---|---|
| 1. 不开 `awf run`，项目里直接起 cc/dsh | 暂不做。后续看能否也记录 |
| 2. 开 `awf run` + 上抛，页面上人决策 | **不做**。省掉挂起/唤醒、`/respond`、`decisionPending`、Run 页作答入口、两条链互斥一整套 |

**为什么砍掉场景 2 代价可控**：「三种作答形态（问答 / 单选 / 多选）」的载体不依赖场景 2 —— 单选与多选来自「CC 想提问被拦截」那一刻（此时 `multiSelect` 与选项都在手上），问答来自文本标签路径。

**副产品**：`.awf/bugs/decision-entry-two-generations.md` 记录的「两条链纠缠」问题随场景 2 一起消失。

## 2. 数据结构：一条记录长什么样

页面上呈现为**一条**。存储仍是 append-only 的多事件（`decision_requested` → `decision_completed` → `decision_reviewed` / `decision_overridden`），由前端按 `decision_id` 聚合 —— 保留既有「历史不可改写」不变量。

**被拦截出题的那种（单选 / 多选）**

```
编号       D-abc-1
时间       2026-09-30 14:22（run 0.2.0-2026-09-30T14-00-00）
问题       回归测试用哪个方案？        ← CC 想提问时出的题
作答形态   单选
选项       A 快速回归 / B 全量回归      ← 拦截时拿到的
AI 决策    用 A
判断依据   时间紧；最近三次改动都集中在同一模块
风险       跨模块回归可能漏网
结论性质   已定
审核状态   待复审                     ← 人复审后变 已采纳 / 已改写
```

**没出题、直接文字问的那种（问答）**

```
问题       这个字段要不要现在就入库？
作答形态   问答
选项       （空）
AI 决策    先不入库，等字段稳定
...
审核状态   待复审
```

两种只差「作答形态」和「选项」两行，其余完全相同。

### 字段表

| 页面显示 | 字段 | 来源 |
|---|---|---|
| 问题 | `question` | 拦截时原样拿 ／ 文本标签正文（**新增落盘**） |
| 作答形态 | `form` | 单选、多选来自拦截到的 `multiSelect`；问答来自文本标签路径。**与审核状态并排显示，不单独占位** |
| 选项 | `options` | 拦截时拿（**新增落盘**） |
| AI 决策 | `answer` | 已有 |
| 判断依据 | `decisive_factors` | 已有 |
| 风险 | `risks` | 已有 |
| 结论性质 | `type` | 已有（schema 里的 `type` 保持不动，避免动老数据） |
| 审核状态 | `status` | 待复审、已改写已有；**已采纳新增** |

Decision Result 的其余 9 个字段（`causal_chain` / `facts` / `assumptions` / `unknowns` /
`reversible` / `reconsider_when` / `confidence` / `finality` / `impact`）照旧存着，本版不上页面。

### 三个正交的维度，不要混

| 维度 | 取值 | 谁决定 |
|---|---|---|
| **审核状态** | 待复审 / 已采纳 / 已改写 | 人 |
| **作答形态** | 问答 / 单选 / 多选 | CC 出题时的形态 |
| **结论性质** | 已定 / 暂缓 / 不需动作 / 先验证 / 重新框定 | AI（schema 的 `type`） |

`deferred`（暂缓）属于**结论性质**，不是审核状态 —— AI 说「不确定，先放着」时，审核状态仍是待复审，人照样要看。

**复审结果只有三种**，不设「已撤回 / 作废」：决策已落盘、可能已影响执行，作废只会让状态更乱；人不同意就走已改写。

**不设免审线**：每条 AI 决策都要人过一遍。目的是看清 AI 决策质量，免审会让样本变少；跑一段时间有数据了再定。

## 3. 交互

### 决策页（唯一展示与操作入口）

**列表**（默认按时间倒序）

```
[待复审] 回归测试用哪个方案？   单选  09-30 14:22  → 用 A
[已采纳] 这个字段要不要入库？   问答  09-30 13:05  → 先不入库
[已改写] 任务拆分粒度          单选  09-30 11:40  → 拆 3 个任务   ✎ 人工：拆 5 个
```

顶部筛选：审核状态（默认停在「待复审」）、run。

**列表只列有结论的决策**：`deciding`（只有问题侧、结论还没产出）是个几十秒的过渡态，不占列表；
真出异常时闸门会落一条 `deferred` fallback 结论，不会永久停在半截。它仍留在 jsonl 里备查。

**详情**：问题即标题（不重复列一行），状态与作答形态并排右上角，正文列 选项 / 决策 / 判断依据 / 风险 + 复审区。

**复审区**（只在待复审时出现）—— 两个动作，要求不同。**状态名与动作名分开**：状态是结果（已采纳 /
已改写），按钮是动作（采纳决策 / 提交其他决策）。

- **「采纳决策」** —— 认可 AI 的结论。一键，不填东西；落状态 `已采纳`
- **「提交其他决策」** —— 不同意，必须填；那句话会变成一个纠偏任务的执行说明
  （**现成链路**：`override` 已经在做）；落状态 `已改写`

两种都落一笔：谁审的、什么时候。

### Run 页

只显示一行计数 ——「本次 run 产生 3 条决策，2 条待复审」+ 点击跳决策页。
场景 2 不做了，run 期间没有需要人实时答的东西，Run 页不做弹窗。

## 4. 接口

| 用途 | 接口 | 现状 |
|---|---|---|
| 决策页读列表 | `GET /awf/decisions` | 已有，不用改（已返回全部字段） |
| 复审「已采纳」 | `POST /awf/decisions/:id/approve` | **新增** |
| 复审「已改写」 | `POST /awf/decisions/:id/override` | 已有（会追加纠偏任务） |
| Run 页计数 | 复用 `GET /awf/decisions`，前端自己数 | 已有 |

服务端新增的只有「已采纳」这一笔记录 —— 决策侧现在没有这个事件。

## 5. 改造点清单（实现指引）

### 5.1 拦截到提问时，别丢问题与选项

`server/features/decision/gate.cjs:118` 的 `classifyAskQuestion` 有三个分支，现在只有
`capture`（gate **关**）会把问题带回并落盘；gate 开时走 `deny_deciding` / `deny_gate`，
`question` 虽在返回值里但**不落盘**，选项直接丢弃。本项目 `decision.enabled=true`，所以永远走后两条 ——
CC 只能用文本标签重问一遍，结构化选项全失。

改造：**所有分支都先把 `question` / `options` / `multiSelect` 暂存进会话**，供本次决策合并使用。

### 5.2 文本标签路径要落问题

`server/features/decision/handler.cjs` 的 `onStop`，`deciding` 分支现在只写 run 日志
（`logger.logDecision({ decisionId: null, event: 'decision_started' })`，落在 `.awf/logs/`，
不是 `.awf/decisions/`）。

改造：该分支生成 `decisionId`、抠出 `<AWF_DECISION_REQUIRED>…</...>` 的正文、
与 5.1 暂存的拦截信息合并，落一条 `decision_requested`。

这条 requested 的 `status` 用 `deciding`（AI 决策中），**不要沿用 `awaiting_human`** ——
场景 3 没有人要答，那个值会误导页面。

抠正文需要一个纯函数 —— `gate.cjs` 已有 `DECISION_REQUIRED_RE`（锚定文本结尾），
但只做布尔判断，需要取捕获组。（当前全仓无「提取标签正文」的先例。）

### 5.3 问题侧与结论侧分落两条事件，展示层合并

> **实现期踩到的坑（回写）**：两条事件共用同一个 `decision_id` 之后，结论侧**不能再用
> `store.append`** —— 它按 `decision_id` **跨事件**去重，requested 一落，completed 会被静默丢掉
> （与 issue 016 同一个坑）。必须改 `appendEvent`（按 `decision_id + event` 去重）。
> 连带：`decision-gate.test.js` 里所有「落盘几行」的断言都要改成按事件过滤 —— 新增一条事件
> 必然改动这些断言，设计阶段就该预判到。

- `decision_requested` —— 落 `question` / `options` / `form`（问题侧）
- `decision_completed` —— 落 `result`（结论侧，`gate.cjs:61` 的 `buildCompletedRecord`）
- 合并发生在**展示层**：`web/src/pages/Decisions/model.js` 已按 `decision_id` 跨事件聚合、
  字段摊平，问题侧字段只在 requested 上有，聚合后自然保留

不把两侧塞进同一条存储记录：append-only 多事件是既有不变量（历史不可改写），
且 `deciding` 期间已有 requested 可供前端显示「AI 决策中」。

### 5.4 作答形态 `form` 的判定

- 拦截到的提问：`multiSelect === true` → 多选；否则单选
- 文本标签路径：问答

### 5.5 新增「已采纳」事件与端点

- store 落 `decision_reviewed` 事件（记录 reviewer、时间）
- 新端点 `POST /awf/decisions/:id/approve`
- `web/src/shared/api/index.js` 加对应调用

### 5.6 前端

- 列表：加审核状态筛选（默认「待复审」）、加作答形态与选项的展示
- 详情：`web/src/shared/components/business/ReviewRecord/Detail.jsx` 现只渲染
  `answer` / `decisive_factors` / `risks`（14-16 行），需补 question / form / options 与复审区
- 该组件被 `Decisions` 与 `DynamicReview` **共用**，17-19 行是动态规划记录的字段 ——
  改造时不要把两边混在一起
- Run 页：加决策计数 + 跳转
- 聚合逻辑 `web/src/pages/Decisions/model.js` 已按 `decision_id` 跨事件合并、字段摊平，基本够用

### 5.7 不再产生的事件

`decision_answered` 在场景 3 下没有产出者（`answered_by` 的 human / auto 都来自场景 2 的 CLI 应答；
`ai` 从来没有产出者 —— `cli/lib/decision.cjs:51` 的 `ai` 路由是主动让位，不调 `/respond`）。
保留事件类型，不再写入。

## 6. 遗留与将来

| 项 | 说明 |
|---|---|
| **入库挂任务** | 入数据库时要与任务建立联系：需求 id（整个任务列表代表的）+ 需求内任务 id。具体入库时再定。`PROTOCOL.md` §8 的 Review Record 已预留 `run_id` / `task_id` 两个槽，现在没填，入库时补上 |
| 场景 1 | 不开 awf run 时能否也记录 |
| 场景 2 | 上抛给人答 + 页面作答入口。做时须一并考虑 `PROTOCOL.md` §1 的 Decision Request（`task_goal` / `context` / `constraints` / `related_decisions` 四个字段协议有定义、实现从未写入） |
| `PROTOCOL.md` §8 | 定义了 Review Record 的 `request` / `result` / `source` 结构，与本设计的记录形状需对齐 |

## 7. 首版看过的调整（2026-09-30）

第一版做出来后按实际观感调的五处，均已落到代码：

1. **删掉「采纳决策」按钮** —— 它打的 `/awf/decisions/:id/adopt` **服务端根本没有这条路由**（死按钮，
   点了 404）。真正有路由的是 `POST /awf/decisions/:id/approve`。删按钮而不是给它补路由：
   同一页面出现两个「认可这条决策」的入口本身就是设计问题。
2. **命名**：`approved` 的展示名从「已通过」改为**「已采纳」**（与按钮动词一致：采纳 / 改写）。
   `overridden` 保留「已改写」。
3. **问题不再单独列一行** —— 它已经是详情的标题，重复展示只是噪音。
4. **作答形态与审核状态并排**（右上角两个 badge），不单独占一行 —— 单看状态不知道 AI 是在答一道
   选择题还是一句自由问，放一起才有信息量。
5. **`deciding` 不进列表** —— 只有问题侧、结论还没产出，存活几十秒，展示价值低于噪音成本。
   记录仍落盘备查（`status: 'deciding'`）。

两个动作的区分（也体现在按钮上）：**采纳决策** = 认可，一键、不填东西；**提交其他决策** = 不同意，
必须填（那句会变成一个纠偏任务的执行说明）。**状态名（已采纳 / 已改写）与动作名（采纳决策 /
提交其他决策）刻意不同** —— 状态是结果，按钮是动作，同名会让人以为按钮是在改状态而不是做事。
