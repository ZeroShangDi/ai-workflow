# spec-kit × ai-workflow 定位罗盘

> 2026-09-14 · 讨论记录 · 外部同类项目对比 + 本项目 v0.2.0 复盘更正
> 对象：GitHub [spec-kit](https://github.com/github/spec-kit) v1.0.6（2026-09-10） × 本仓 `cc-control/` v0.2.0（2026-09-11 重构 / 09-14 旧树收口）
> 用途：把本项目放回「AI 驱动的软件工程工具」坐标系里，回答两个问题——**我们在哪一层**、**我们的短板在外部的对照物是什么**。
> 来源：外部事实来自 2026-09-14 实时抓取的 spec-kit 公开页面（README / spec-driven.md / AGENTS.md / templates/commands/*.md / docs/reference/* / discussions#1671）；本项目事实来自本仓代码与文档。

---

## 0. 一句话结论

**两者不在同一层，不构成替代关系。**

- **spec-kit = 规约层**。把「要做什么」形式化成文档，**无运行时**——`init` 完就是一堆 markdown 模板 + 脚本，之后全靠 agent 自觉。
- **ai-workflow = 执行层**。把「做到哪一步了」形式化成机读状态机，**有运行时**——常驻 Session Server 持有调度权与门禁闭环。

spec-kit 社区反复追问的那句 *"GitHub Spec Kit Defines the Plan. Who Enforces the Architecture?"* 指向的缺口，正是 awf 在做的事；反过来，awf 的验收靶子（`acceptance`）是 AI 动手前自己猜的（本仓 `docs/discuss/autonomy-ceiling.md` 已自述此自指环），而 spec-kit 的 `constitution` + `spec` + `clarify` 恰好是一套**把外部信号结构化灌进环里**的机制。

两者消灭的是**不同的 gap**：

| | 消灭的 gap | 代价 |
|---|---|---|
| spec-kit | spec 与实现之间——"code serves specifications" | 无强制力，环是开的 |
| ai-workflow | 会话与工作流之间——"让它变持久，不是变聪明" | 环是闭的，靶子可能是错的 |

---

## 1. 基本盘对照

| | spec-kit | ai-workflow |
|---|---|---|
| 主体 / 版本 | GitHub 官方 · **v1.0.6**（2026-09-10） | 个人项目 · **0.2.0**（2026-09-11 重构） |
| 语言 / 形态 | Python CLI（脚手架 + 模板分发） | Node CLI（`cli/`）+ 常驻 HTTP Server（`server/`） |
| 运行时 | **无** | **有** —— 常驻单写者控制平面，36 条 HTTP 路由 |
| 宿主绑定 | **40 个集成**（claude/copilot/cursor/codex/gemini/…），靠模板适配 | **仅 Claude Code**，靠 hooks / MCP / subagent 深绑 |
| 落进项目 | `.specify/` + `specs/NNN-name/` 文档树 | `.awf/state.json` + 三插件（core / decision / plugin-code） |
| AI 的角色 | 执行者，人是审阅者 | **被驱动者**，宿主是调度者 |
| 代码规模 | 未测 | `cli/` + `server/` 约 12,600 行；106 个 vitest 文件 |
| 对外面 | 9 个 slash 命令 × 40 集成 | 7 CLI 命令 · 16 slash 命令 · **28 个 MCP 工具** · 36 条 HTTP 路由 · 36 个 skill |

---

## 2. 逐维度对比

| 维度 | spec-kit v1.0.6 | ai-workflow v0.2.0 | 判断 |
|---|---|---|---|
| **规划产物** | `spec.md` / `plan.md` / `tasks.md` / `research.md` / `data-model.md` / `contracts/` / `quickstart.md` —— **给人读的文档** | WBS 空间树 + `tasks[]`（含 `deps`/`wbsRef`/`plannedFiles`/`constraints`/`acceptance`）写入 `state.json` —— **给机器读的状态** | 各自为政 |
| **规划方法论** | `/specify` → `/clarify` → `/plan`，用 `[NEEDS CLARIFICATION]`（**上限 3 个**，优先级 scope > 安全/隐私 > UX > 技术）显式暴露未知 | `w-plan` 8 步：规范化 → 现状 → 讨论 → **架构图先行冻结** → WBS 碎片逐级落盘 → 拼图式合并 → tasks + 门禁 → **最后一次写 state.json** | spec-kit 更强调「不猜」，awf 更强调「不返工」 |
| **拆解粒度** | 任务行 `T001 [P] [US1] 描述`；`[P]`=可并行、`[US1]`=绑用户故事；阶段 Setup→Foundational→每故事一段→Polish | 任务 = WBS 叶子，ID 自带语义层级（任务=1/功能=2/模块=3/项目=4），门禁任务编号对齐被管辖节点 | awf 可溯源，spec-kit 可读性更好 |
| **执行模型** | **单 agent 串行**。`/implement` 逐阶段跑，`[P]` 靠文件不相交并发 | 宿主 `decideChain` 定阶段链（simple `DEV→COMMIT` / medium `+TEST` / complex `+DOCS+REVIEW+TEST`），**滑动窗口**补齐：就绪池 + 四级配额 + `plannedFiles` 冲突 + 独占 | **awf 压倒性** |
| **失败处理** | 非并行任务失败 → **立即 halt**；`[P]` 失败 → 报告后继续 | 门禁 `verdict` 非 pass → **自动派生修复任务** + 门禁回退 pending（`MAX_RECHECK=3`）；持续不收敛走 `awf-run-reset`（回撤 + 复盘 + 重探） | **awf 压倒性** |
| **门禁** | `checklists/` 是 reviewer-owned，`/implement`「不得静默自审」——**提示词级自觉**；`/analyze` 只读不自愈 | 门禁是**独立任务**（`kind=review/test`），产出结构化 `verdict`，闭环在宿主侧强制执行（`server/features/gate/`） | **awf 压倒性** |
| **跨阶段上下文** | 完全靠文件 + `.specify/feature.json` 指针；官方承认「语义连续性」是无解难题 | `handoff.md` 7 段快照 + `awf_context_ready` 触发 `/clear`；每任务前压缩检查（`server/features/context/compaction.cjs`） | awf 更工程化 |
| **决策** | 无。`[NEEDS CLARIFICATION]` 靠人补 | **决策闸门**：`<AWF_DECISION_REQUIRED>` → Stop 钩子 → DC 自决 → `<AWF_DECISION_RESULT>` → DecisionStore 落盘；独立第三插件 | awf 独有 |
| **计划可变更** | `/speckit.converge` **append-only**，只追加不修改删除 | `awf_dynamic_plan` 运行期改任务图：影响闭包 + **CAS 双检**（闭包指纹 + 锁内重放）+ `hold` + 人工批准 | awf 独有 |
| **人工介入** | `gate` 步（Workflows 内的人工审批） | `pause` 闩锁（三条等待路径共用）+ `monitor` 介入（拉起隔离 claude 分析现场，5min 上限） | 各有其形 |
| **状态机** | 无结构化状态机。1.x 新增 **Workflows**（YAML 管道 + `state.json` + `resume`）——但作用于工作流层，**不作用于单任务** | `state.json` 是任务级状态机；`store` 层（`state.lock` 单写序列化 + 原子写 + 按数据族分型）；28 个 MCP 工具显式 CRUD | awf 深，spec-kit 广 |
| **可观测性** | 无 | `web/` 前端（React + Vite，5 可见 + 2 隐藏页）+ metrics + run-logger + `.awf/logs/` | awf 独有 |
| **自定义验证** | 无 | `check-architecture.mjs` **可失败门禁**（零引用 / 依赖方向 / 结构断言 + 元验证）；真机回归 15 case × 150 断言 + e2e 14 case | awf 独有 |
| **扩展机制** | Extensions / Presets / Bundles，模板 **4 级覆盖**（override > preset > extension > core） | 三插件分层（引擎 / 决策 / 编程）+ `plugin/config.json` 单源 → `render-config.mjs` 渲染 | spec-kit 生态更开放，awf 分层更干净 |

---

## 3. 同一条需求的走法对照

需求：「做一个登录功能」。

**spec-kit**
```
/constitution                  一次性，写死项目原则（5 槽 + Governance）
/speckit.specify "登录"        → specs/003-login/spec.md（FR-001… / SC-001… / ≤3 个 NEEDS CLARIFICATION）
/speckit.clarify               → 补全 spec 中的未决项
/speckit.plan                  → plan.md + research.md + data-model.md + contracts/ + quickstart.md
/speckit.checklist             → checklists/*.md（reviewer-owned）
/speckit.tasks                 → tasks.md（T001 [P] [US1] …，含文件路径）
/speckit.analyze               → 只读一致性报告（不回写）
/speckit.implement             → 单 agent 顺序跑；checklist 有未勾项就停下请求许可；tasks.md 打 [X]
```
**环是开的**：AI 自己执行、自己打勾。人在两处被问——`clarify` 与 `checklist`。

**ai-workflow**
```
awf plan "登录"   → w-plan 8 步：规范化(范围 100%) → 现状 → 讨论(技术 60-70%) → 架构图冻结
                    → WBS 碎片逐级落盘 .awf/plan/wbs/ → 拼图式合并 → tasks + 三级门禁
                    → 最后一次集中写 state.json（范围 → WBS → tasks）
awf run           → 宿主选就绪任务、判复杂度定链
                    complex: DEV → DOCS → REVIEW → TEST → COMMIT
                    门禁任务独立执行 → 出 verdict → 非 pass 自动派生修复任务并回退门禁
                    上下文不足 → 写 handoff.md → awf_context_ready → /clear → 续跑
                    计划发现缺口 → AI 发起 awf_dynamic_plan 提案 → 人工批准 → 同一 run 继续
                    持续不收敛 → awf-run-reset 回撤重来
```
**环是闭的**：宿主持有调度权与门禁闭环，AI 只在格子内工作。

---

## 4. 各自的真实短板

### 4.1 spec-kit（= awf 的靶场）

| 短板 | 证据 |
|---|---|
| 无强制力 | `/analyze` 只读；constitution check 是提示词自觉；第三方分析标题直指「谁 enforce」 |
| 长周期漂移无解 | Discussion #1671：spec 与实现「gradually fall out of sync in ways that are hard to detect」；维护者明确「核心工作流暂不改」 |
| 上下文耗尽靠手工 | 官方文档建议手工限任务区间（"only execute tasks T001-T010"）或手工派 sub-agent |
| 无回退 | `/converge` 是 append-only；没有回撤 / 重开机制 |
| 并行 = 标记 | `[P]` + 文件串行，无调度器、无配额、无补位 |

### 4.2 ai-workflow（= 本仓自评 + 审计结论）

| 短板 | 证据 |
|---|---|
| **自指闭环** | `acceptance` 由 AI 在 plan 阶段生成，门禁/审查/测试全在问「符不符合这个可能就错的靶子」——`autonomy-ceiling.md` 自述「静默且自信的失败」 |
| **单宿主绑定** | 只支持 Claude Code，离开 hooks / MCP / subagent 就废 |
| **规划期「猜」** | `w-plan` 有 8 步，但缺 spec-kit 那种**强制未知暴露**机制（`[NEEDS CLARIFICATION]` 有上限、有优先级）；awf 的 `openQuestions` 不是硬约束 |
| **零生态** | 无 extensions / presets / bundles，无 40 集成 |
| **重构完成度自评** | `v0.2.0-refactor-audit-and-recovery-plan.md` 总结论：**不能定义为重构完成**（原始任务 132/134、审计基线 147/154、七条验收 3 完成 / 3 部分 / 1 未完成） |
| **元卡点** | `ai-refactor-retro-v0.2.0.md` 列 8 条 K1-K8（抽象建了没接线 / 验证面假象 / 登记≠可达 / 自述失真 / 沉默的失败 / 单测拦不住真机 / 观测者效应 / 验证工具自身有缺陷），主线「**反复把形式成立当成事实成立**」 |

**注意**：4.2 的后两条在 spec-kit 里同样存在（constitution check 是自觉、analyze 不自愈）。区别是 spec-kit 小、可移植、40 集成，**不容易出现「抽象建了没接线」**这类问题——因为它压根没有抽象层。这是规模带来的不对称：**越薄的层越不会自欺，也越没有强制力。**

---

## 5. 可借鉴点（双向）

### 5.1 给 ai-workflow

1. **`[NEEDS CLARIFICATION]` 机制** —— spec-kit 强制「未知必须显式标记且有上限」，比 awf 的「范围 100% 敲定」自评更可验证。可作 `w-plan` 第 1 步的硬门禁：每个未决项必须显式登记，超限即拒绝进入 WBS。
2. **`constitution.md` 作为环外信号** —— awf 的三条架构纪律（R1 依赖单向 / R2 实例隔离 / R3 事件 schema 版本）目前写在架构文档里；spec-kit 的做法是做成**每次 plan 都强制 Check 两次**（Phase 0 前 + Phase 1 后）的宪法条款。awf 完全可以把它接到 `check:arch` 已有的机器裁决上。
3. **`/analyze` 的只读定位** —— 反向学习：awf 的所有门禁都带写权限（派生修复任务），缺一个「纯诊断、零副作用」的审查出口。
4. **Workflows 的续跑语义** —— `specify workflow resume <run_id>` 从失败点续跑 + `gate` 步的人工审批语义，比 awf 的「无变化窗口超时 → 标 blocked」更明确。
5. **模板 4 级覆盖** —— override > preset > extension > core 的解析优先级，比 awf 当前「插件声明、CLI 填充」的单层更利于团队定制。

### 5.2 给 spec-kit（即它的公开 gap）

awf 的三个能力恰好填 spec-kit **承认但未解**的三处：

| spec-kit 的 gap | awf 的对应件 |
|---|---|
| 谁 enforce | 门禁任务 + `verdict` + 宿主侧自动派生修复（`MAX_RECHECK=3`） |
| 长任务上下文退化 | 宿主调度 + 每任务前压缩检查 + `handoff.md` 交接 |
| 计划错了改不了 | `awf_dynamic_plan`（CAS 双检 + hold + 人工批准），取代 append-only `converge` |

spec-kit 的 `Workflows` 是朝这个方向的第一次尝试，但停在 YAML 编排层，**没进到任务粒度**。

---

## 6. 【更正】本项目 v0.2.0 复盘 —— 对本文早期判断的修正

本节独立成章：本文初稿的项目侧事实采自 **v0.1.0 形态**（旧树 `src/cli` `src/server` `src/lib` `src/adapters`）。2026-09-14 重新通读工作树后，以下判断需要更正或补充。

### 6.1 已失效的判断（更正）

| # | 我此前的判断 | 实际（v0.2.0） | 依据 |
|---|---|---|---|
| C1 | 项目结构是 `src/cli/` `src/server/` `src/lib/` `src/adapters/` | **旧树 `src/` 已退役删除**。现为根级 `cli/` + `server/`；`server/` 分 `web/` `run/` `features/` `runtime/` `shared/` `observability/` `adapters/` `mock/` `templates/` | commit `6563ea5`（旧树收口 P3）；`package.json` `bin → cli/awf.cjs`、`files` 含 `server/`+`cli/` |
| C2 | `awf-session` 是 **5 个** MCP 工具 | **7 个在册** —— 新增 `awf_session_intervene` / `awf_session_interrupt`；`awf_await_choice` / `awf_await_input` **资产层已标停用但代码面仍注册**（T1-106，用户裁定暂缓）。三 server 合计 **28 个** | `plugin/core/mcp/awf-session/server.cjs`；`.awf/state.json` 停用标注 |
| C3 | `README.md` 已过时，仍在描述 `bin/` `commands/` `tools/` | **该判断基于旧版 README**。现行 `README.md`（76 行）已重写为新树：架构图指向 `cli/awf.cjs` + `server/`，目录表为 7 命令 / 三插件 / 真机 e2e | `README.md` 全文 |
| C4 | 门禁闭环 `MAX_RECHECK=3`（判断正确，落点过时） | 落点在 `server/features/gate/`（`closure.js` 判定与派生 / `fix.js` / `loop.cjs` 文案规则），不再是 `src/server/gate-fix.js` | 目录树 + 文件头 |
| C5 | 未提及的整层能力 | 漏了 **store 持久化层**、**adapters 端口契约**、**`web/` 前端**、**replanning 动态规划**、**pause 闩锁**、**monitor 介入**、**双套真机测试** | 见 6.2 |

### 6.2 v0.2.0 相对 v0.1.0 的关键增量（补充）

| 增量 | 落点 | 一句话 |
|---|---|---|
| **常驻 Session Server 控制平面** | `server/server.cjs` + `server/web/api/*`（8 个域模块） | server 从「run 期间的临时服务」变成常驻单写者：单实例多项目（`?p` 路由到各自 `ProjectCtx`）、空闲回收、`/shutdown`、36 条路由 |
| **run 域整体搬进 server** | `server/run/{host,driver,scheduler,transport,channel}.cjs` | 编排权从 CLI 进程搬进宿主；CLI 薄化为「起环境 + 提交 run + 订阅事件 + 决策中继 + 收尾复位」 |
| **features 层（SDD 正常流程之外的处理）** | `server/features/{decision,replanning,gate,pause,monitor,context}/` | 六类「异常/旁路」能力独立成目录，各有文件头契约 |
| **runtime 骨架** | `server/runtime/{index,project,registry,session,executor,channel,idle,lifecycle}.cjs` | 把过去贴在共享 `pcx` 上的实例收成显式 runtime 成员 |
| **shared 原语** | `server/shared/*.cjs`（14 个） | 旧 `src/lib/` 地基 + `plugin-render.cjs`（旧树唯一打断构建者）+ `prompts.js`（原 `plugin-bridge.js`） |
| **adapters 端口契约** | `server/adapters/ports.cjs` + `cc/*`（10 个） | 「进入 adapters 的唯一门」：7 端口名册 + `status: factory \| not-landed` + 加载自检；`claude` 字面只在本层 |
| **store 持久化层** | `server/shared/store-core.cjs` + `store.cjs` | `state.lock` 单写序列化 + 原子写；按数据族分型（JsonFile / AppendFile / Snapshot / WriteQueue） |
| **决策闸门 + 第三插件** | `server/features/decision/*` + `plugin/decision/` | `<AWF_DECISION_REQUIRED>` → DC 自决 → Decision Result；独立成插件（技能 + 协议资产，无 mcp/hooks/命令） |
| **动态任务规划** | `server/features/replanning/*` | `propose → decision_required → awaiting_approval → approve/reject → applied/rejected`；影响闭包 + CAS 双检 + hold + 人工批准 |
| **`web/` 前端工程** | `web/src/{app,layouts,pages,shared}` + `mock/` | React 18 + Vite 5；7 条路由（run/tasks/decisions/reviews/logs + 隐藏 diagnostics/wbs-tree）；轮询改 WS；构建产物入 server 托管 |
| **结构门禁门禁化** | `scripts/check-architecture.mjs` | 从「取证工具」升级为**可失败门禁**（进 `npm run build`）；三条不变量 + 元验证（造假越界必须 exit 1） |
| **双套真机验证** | `tests/e2e/`（14 声明式 case）+ `tests/regression/`（命令式 harness，15 case） | 消耗真实 token 端到端；合并方案 `real-run-suite-merge.md` 部分落地 |

### 6.3 本项目自评的未收口项（不许沉默清单）

引自 `docs/discuss/architecture-v0.2.0.md` §4.3 与 `docs/CHANGELOG.md`：

| 项 | 内容 | 归属 |
|---|---|---|
| R1 四条越界边 | `adapters→server`、`cli→server`、`plugin-mcp→{adapters,lib}` | `T1-113`（豁免表已登记 + 责任可达性有机器断言） |
| R3 未达成 | 事件信封 `{type, at, runId, payload}` 无版本字段；消费方含 WS 推送与独立构建的前端 | 未决，需一次显式决策 |
| `server.cjs` 仍是单体 | 1491 行 / 上限 1600 | `T1-113` |
| 门禁扫描假阴性 | 注释里的 import 被当引用 → 零引用不变量漏检 | `.awf/issues/003` → `T1-120` |
| 声明与实现不符 7 条 | 参数被丢弃 / 死值 / 空声明 / 陈旧注释 | `.awf/issues/004` → `T1-120` |
| 旧决策入口代码面仍在 | `/choice` `/ask` `/respond` 与两个 MCP 工具仍注册在册 | `T1-106`（暂缓） |
| 真机 case 隔离性 | 全量连跑与单跑结论不一致 | `T3-011-F1` |
| 收口期两处静默能力丢失 | 会话就绪守卫 `sessionSeq` 零消费者、`server.log` 轮转丢失 | 已在 P0 补回 |

### 6.4 本次复盘额外发现（文档债）

- **`docs/discuss/architecture-v0.2.0.md` 未随 P4 改指新树**：该文（2026-09-11 accepted）全文仍用 `src/cli/` `src/server/` `src/lib/` `src/adapters/`，命中 32 处。P4 只改了 `docs/features/*`、`CLAUDE.md`、`README.md`。
  - 风险：它是自述的「**正式架构文档**」与门禁审查的纪律依据，现在是**唯一还在描述已删除目录的权威文档**。建议列一条文档任务改指新树，或在文首加显式过期声明。
- **`.awf/state.json` 处于 `mode: idle`、`tasks` 为空**，`plan.summary` 仍是 v0.2.0 重构摘要，未随旧树收口更新。`plan.reqDoc` 为空。
- **`src/` 目录仍以未跟踪状态存在于磁盘**（仅 `src/server/public/` 两个前端构建产物），`git status` 显示 `?? src/`。属构建残留，宜加进 `.gitignore` 或清理。

### 6.5 更正后对 §2 / §4.2 的净影响

- §2 表格中「状态机」「门禁」「可观测性」「自定义验证」四行，awf 侧的实际完成度**高于**初稿描述（初稿未计入 store 层、web 前端、双套真机测试、结构门禁）。
- §4.2「ai-workflow 短板」需**再补两条**：**重构完成度自评「不能定义为重构完成」**、**元卡点「反复把形式成立当成事实成立」**——这两条比初稿列的任何一条都更根本，且正好是 spec-kit 因「层薄」而天然绕开的问题（见 §4.2 末注）。
- §1「代码规模」行由初稿的估算改为实测：`cli/` + `server/` 约 12,600 行，106 个 vitest 文件。

---

## 7. 收敛

坐标系上，本项目占据的是 spec-kit 明确留空的那一层：**从「规约」到「可强制的执行」之间的运行时**。这个位置的价值由 spec-kit 的 Discussion #1671 反向确认——长周期漂移、上下文退化、计划不可修订，都是「规约层解决不了、必须由运行时解决」的问题。

但 v0.2.0 的复盘同时给出了代价：**越往下走，自检的可靠性越依赖机器而非自述**。本仓的 8 条元卡点（抽象建了没接线 / 验证面假象 / 登记≠可达 / 自述失真 / 沉默的失败 / 单测拦不住真机 / 观测者效应 / 验证工具自身有缺陷）没有一条是「能力不够」，全是「**形式成立被当成了事实成立**」。真正把这些关掉的是 `check-architecture.mjs` 这类**可失败、且有元验证**的机器裁决——不是更多的 skill 和文档。

一句话落点：**spec-kit 缺的是运行时；ai-workflow 缺的是可执行的外部真相。** 前者本项目已经建出来了，后者 `autonomy-ceiling.md` 已经说清楚它不在 prompt 层能解决——那是环境与反馈回路的问题。

---

## 附：外部事实来源

- https://github.com/github/spec-kit
- https://raw.githubusercontent.com/github/spec-kit/main/README.md
- https://raw.githubusercontent.com/github/spec-kit/main/spec-driven.md
- https://raw.githubusercontent.com/github/spec-kit/main/AGENTS.md
- https://raw.githubusercontent.com/github/spec-kit/main/templates/{spec,plan,tasks,constitution}-template.md
- https://raw.githubusercontent.com/github/spec-kit/main/templates/commands/implement.md
- https://raw.githubusercontent.com/github/spec-kit/main/docs/reference/{integrations,agentic-sdd,workflows,extensions,bundles,core}.md
- https://raw.githubusercontent.com/github/spec-kit/main/docs/concepts/{spec-persistence,complex-features}.md
- https://github.com/github/spec-kit/discussions/1671
- https://mnemehq.com/insights/github-spec-kit-who-enforces-architecture/

> 未证实项：spec-kit 的 `scripts/bash` 具体脚本清单、官方「已知局限」清单页、`.specify/memory/` 除 `constitution.md` 外是否还有其他文件 —— 公开页面均未说明，本文不作断言。
