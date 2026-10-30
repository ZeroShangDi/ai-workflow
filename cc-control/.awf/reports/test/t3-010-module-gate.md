# T3-010 · W3-010（文档与发布）模块测试门禁 — 非真结构核查报告

> 门禁任务 T3-010 · 2026-09-11 · 口径同 W3-009：对照模块 acceptance 与改动 diff 做结构/验收自检，
> **不跑整套真实测试**（真实运行由 T3-011 承担）。
> 复审对象：`T1-100`（功能文档）→ `T1-101`（架构终稿）→ `T1-102`（CHANGELOG/版本/scripts）→ `T1-103`（复盘）。
> 基线 HEAD `e6385ec`，工作树未提交。

## 一、模块验收点对表（W3-010 desc）

| # | 验收点 | 第一手证据 | 判定 |
|---|--------|-----------|------|
| 1 | 受影响功能文档更新 | `docs/features/` **36 份**：14 份受影响文档（server/run/state/hooks/decision/auto-decision/oneshot/tmux-session/plan/init/cli-aux/bootstrap/run-logger/version-prompt）+ 各自 `.test.md` 已按现存代码重写；6 份新能力文档（store/adapters/run-domain/metrics/events/api）首次成文 | ✅ |
| 2 | 架构终稿 v4 落正式 docs/discuss | `docs/discuss/architecture-v0.2.0.md`（254 行）：纪律文字化（§1 三条 + 判据 + 取证方式）/ 组织图（§2）/ 功能映射（§3）/ 决策归档（§4，含「已定勿翻」七条 + 关键决策表 + 未决与登记债六项）；`architecture-notes.md` 已加指针并澄清「笔记 ≠ 正文」 | ✅ |
| 3 | CHANGELOG v0.2.0 + 发布基线核对 | `docs/CHANGELOG.md` 的 0.2.0 段由 27 行扩为完整条目（Added/Changed/Fixed/Removed + **未收口**节）；版本六处对齐 0.2.0（package / lock / web / config.json / marketplace / 三个 plugin.json）；渲染幂等实测零 diff；scripts 四个实测（test 852 例绿 / lint 通过 / build 通过 / eval `--list` 列出 9 case） | ✅ |
| 4 | AI 重构元实验复盘记录 | `docs/discuss/ai-refactor-retro-v0.2.0.md`（123 行）：卡点 8 条 / 边界决策 8 条 / 验证结论 + Stable-Improve-Experiment 各 3 条 + **行动项 3 条带 owner 与期限**；决策记忆同步进 `architecture-notes.md` | ✅ |

**旁证**：`node scripts/check-architecture.mjs` EXIT 0（87 生产文件、白名单 3、豁免 4 = 零引用 0 / 依赖方向 4）；
`npm test` 95 文件 / **852 例全绿**；全仓 94 份 md 的引用扫描（见 §三 N-4）。

## 二、结论先行

四项验收点的**表面证据全部成立**，文档产出量与自洽性较上一版有实质改善（引用扫描、渲染幂等、版本对齐均已机器化核对）。

但对照**实际交付面**核验时查出：**验收清单本身漏了一项交付** —— v0.2.0 的一大新能力 `web/`（React 前端工程）
在 `docs/features/` 下**没有任何落点**。这与本仓刚复盘的 K4（「形式齐备、事实缺席」）同型：
清单上的每一项都做完了，**但清单不全**。

## 三、本门禁发现

### N-1（重）· `web/` 前端工程零功能文档

- **交付规模**：`web/src/` **12 个文件 / 887 行** —— 4 个视图（Dashboard / WbsTree / Decisions / Diagnostics）+ 5 个模型层（`*-model.js`）+ `api/client.js` + `App.jsx` / `main.jsx`。
- **现状**：`docs/features/` 下**没有** `web.md`；`api.md` / `metrics.md` / `events.md` / `server.md` 只在讲服务端面时顺带提到它。
- **为什么是「被漏掉」而不是「不需要」**：旧形态（`dashboard.html`）在前版 `server.md` 里有独立章节（`## 5. dashboard.html`，
  HEAD 版可查）。T1-100 正确地把该章节删掉了（文件已退役），但**新前端工程本身没有替代品** ——
  四视图各自负责什么、`?p` 作用域取数怎么走、模型层与视图层的分层、构建链（`build-web.mjs` → `src/server/public` → 缺产物 503）全无文档。
- **影响**：接手者要改前端时，`docs/features/` 里找不到入口，只能反读 887 行源码 —— 而这一版其余每一个能力都有落点。
- **严重度**：**高**（本模块的主题是「文档与发布」，交付面缺一块）。

### N-2（中）· Bug 记录分居两处，且两处规范互相打架

- **实际分布**：`docs/bugs/` **8 个**（created 均为 2026-09-09 ~ 09-11，**都是本轮的**）；`.awf/bugs/` **1 个**。
- **规范冲突**：`code-doc`（权威实施规范）写明 Bug 记录 → `.awf/bugs/`，且明确「默认放 `.awf/`；项目无该目录时退回 `docs/`」——
  本项目**有** `.awf/`，故 `docs/bugs/` 不合规；而 `CLAUDE.md` **自身打架**：
  第 49 行写 `docs/ # features/issues/bugs/logs/discuss 五类项目文档`，第 318–325 行的目录树又写 `.awf/` 下有 `bugs/`。
- **对照**：issues 没有这个问题 —— 4 个 issue **全部**在 `.awf/issues/`。
- **后果**：写 bug 的人按任意一份文档都能找到「依据」，于是 8:1 分裂；查 bug 的人要搜两处。
- **严重度**：**中**。修法需一次裁决（建议向 `.awf/bugs/` 收敛，与 issues 的实际做法及目录树一致），并修正 `CLAUDE.md` 第 49 行。

### N-3（轻）· `docs/features/testing-infrastructure.md` 陈述与现状不符

- 开篇断言「cc-control **当前零自动化测试**，所有核心模块均未覆盖」—— 现状是 95 个测试文件 / 852 例。
- 「13 个能力模块的单元测试」与验收标准 5 个复选框**全未勾**，而它们事实上已全部满足（`npm test` 可运行、E2E 烟雾在册、能力测评设计文档 `eval-design.md` 已产出）。
- 该文档不在 T1-100 的清单内，但按「过时即改」属本模块范围。
- **严重度**：**低**（历史需求文档，但「当前零测试」是明确的假陈述）。

### N-4（轻）· 归档之外的文档仍残留指向已删除模块 / 旧路径的引用

全仓 94 份 md 的引用扫描中，**非归档**文档命中两类未标注的失效指向：

| 文件 | 残余引用 | 说明 |
|---|---|---|
| `docs/reuse/engineering-patterns.md:10` | `src/cli/run-batch.js` | 该文件已删除；此行未标注（「相关实现」被当成现状） |
| `docs/bugs/bootstrap-tmux-global-env-leak.md:73` | `tests/sandbox/fullflow-regression.mjs` | harness 已归位到 `tests/regression/`（T1-098），旧路径未标注 |

（同文件 `:65` 的 `session-launch.cjs` **已正确标注**「已随 T3-009-F1 删除」，可作写法范例。
其余命中均在 `docs/discuss/_archived/` 或讨论笔记中，属历史记录，不计。）

## 四、结论

- **四项验收点成立**，且本轮文档的机器化核对（引用扫描 / 渲染幂等 / 版本对齐 / scripts 实测）质量高于前版。
- **不判 pass 的实质**：验收清单**漏了一项交付面**（`web/` 零文档），叠加一处规范自相矛盾（bug 落点）
  与两处陈述过时。四者都不是「写错了」，而是「**该有的落点不存在，或存在两个互相矛盾的落点**」——
  与本仓刚复盘的 K4 同型。

→ **verdict: changes_requested**

修复要求（按优先度）：

1. **N-1**：新增 `docs/features/web.md`（+ 必要的 `.test.md`），覆盖 `web/` 工程结构、四视图职责、模型层与视图层分工、
   `?p` 作用域取数、WS 事件驱动、构建链与产物托管（与 `api.md` / `server.md` 交叉引用，不重复）。
2. **N-2**：裁定 bug 记录的唯一落点（建议 `.awf/bugs/`），迁移另一处并修正 `CLAUDE.md` 第 49 行，使规范与目录树一致。
3. **N-3**：更正 `docs/features/testing-infrastructure.md` 的「当前零自动化测试」等过时陈述，或按归档规则处置。
4. **N-4**：两处残余引用标注为历史/更正为当前路径。
5. **不改**：本轮四项交付物本身（功能文档 / 架构终稿 / CHANGELOG / 复盘）经核对无需返工。

---

# 第 2 轮复审（T3-010 recheck 1）— 2026-09-12

> 复审对象：`T3-010-F1`（N-1…N-4 处置）后的**当前工作树**（含补交 `ae2b0f3`）。
> 口径同第 1 轮：**非真结构核查**（未跑真机回归；真实运行由 T3-011 承担）。
> 本轮结论全部取自第一手证据（命令输出 + 文件内容），不采信处置方的自述。

## 八、上轮问题结清核对

| 上轮项 | 处置 | 本轮核验（第一手） | 判定 |
|---|---|---|---|
| N-1 `web/` 零文档 | 新增 `web.md`（231 行）+ `web.test.md` | 逐项抽验文中事实：`web/src` **12 文件 / 887 行** ✔；仓库内 **0 个 `.css`** ✔（与「无样式」一节一致）；`tests/unit/web-*.test.js` **6 文件**，实测 vitest **36 passed**，与 `web.test.md`「合计 36 例 / 6 文件」一致 ✔；三处交叉引用落点真实存在（`api.md:196` 属 §3.1 / `api.md:470` 属 §4 / `server.md:166` 属 §6）✔；引用的 `architecture-v0.2.0.md §2.1`、`events.md`、`run-domain.md` 均在位 ✔ | ✅ **结清** |
| N-2 bug 落点裁决 | `git mv` 8 份 → `.awf/bugs/`、删 `docs/bugs/`、改 `CLAUDE.md` | `docs/bugs/` 已不存在 ✔；`.awf/bugs/` 10 份 ✔；全仓**非时点快照**文档（`docs/**`、`CLAUDE.md`、`.awf/{README,RULES,bugs,issues}`）已无 `docs/bugs` 活引用 ✔（仅 `.awf/reports/**`、`.awf/state.json` 作为历史快照保留，与既有豁免口径一致）；`CLAUDE.md` 第 49 行改后与 `docs/` 实际一级内容（CHANGELOG / discuss / evals / features / reuse）**逐项相符** ✔；三处权威（`code-doc` §4、`.awf/README.md` §bugs、`CLAUDE.md` 目录树）现口径一致 ✔ | ✅ **结清**（落点自身的契约层见 M-3） |
| N-3 `testing-infrastructure.md` 过时陈述 | 加状态 banner + 校对层 | 「当前零自动化测试」已改「写作当时」并附校对 ✔；5 个验收框全勾且各带证据 ✔；**声称的数字全部复核为真**：`npm test` 声称 98 文件 / 918 例 → 实测 `98 passed / 918 passed / exit 0` ✔；eval `--list` 声称 10 case → 实跑列出 10 条 ✔；全量连跑声称 15 case / 204 断言 → 与 `0c2068b` 记录一致 ✔ | ✅ **结清** |
| N-4 残余引用 | 标注 2 处 | `engineering-patterns.md:10` 已改指 `src/server/batch-transport.cjs` 并标注旧文件已删 ✔；`bootstrap-tmux-global-env-leak.md:75` 已标注当时路径 + 归位 `tests/regression/` ✔。**同型扩大扫描**：`run.md:10`、`auto-decision.md:224`、`version-prompt.test.md:4` 亦均已正确标注 ✔ | ✅ **结清** |

**上轮之外的自证处置（复核认可）**：源码头注释两处过期现状声明（`src/cli/run.js`、`src/server/run-host.cjs`）已改正；MCP 侧 `httpJson`/`readJson` 逐块 `toString` 切碎多字节字符（真缺陷，`setEncoding('utf8')` 修 5 处）成立且已独立登记 bug。

## 九、模块验收点复核（W3-010 desc）

| # | 验收点 | 本轮第一手证据 | 判定 |
|---|---|---|---|
| 1 | 受影响功能文档更新 | `docs/features/*.md` **38 份**（含 15 份 `.test.md`），`web.md` 补齐了 W3-008 的交付面 | ✅（索引未同步 → **M-1**） |
| 2 | 架构终稿 v4 落正式 docs/discuss | `architecture-v0.2.0.md` 纪律 / 组织图 / 功能映射 / 决策归档四块齐备 | ⚠️ **两处计数过期 + 缺 web 行 → M-1** |
| 3 | CHANGELOG v0.2.0 + 发布基线核对 | 0.2.0 段完整；版本 **8 处**对齐（package / lock / web / plugin config / marketplace / 三个 plugin.json 均 0.2.0）；`node scripts/render-config.mjs` 后 `git status --porcelain` 仅剩 `.awf/state.json`（**渲染幂等，产物零 diff**）✔ | ✅（仓库卫生 → **M-4**） |
| 4 | AI 重构元实验复盘记录 | `ai-refactor-retro-v0.2.0.md` 在位（并已按 T3-010-F1 更正素材来源注） | ✅ |

**旁证**：本轮 `npm test` **98 文件 / 918 例全绿（exit 0）**；web 单测 **6 文件 / 36 例全绿**。

## 十、本轮新发现

### M-1（中）· 架构终稿 v4 未随 N-1 传播 —— 功能索引表无 `web/`，两处计数过期

`docs/discuss/architecture-v0.2.0.md` 是 T1-101 交付物，其 §3.1 表自述为「**每份功能文档的实际落点**」——即 v4 的功能索引。本轮刚补齐的 `web.md` 不在其中：

- **§3.1 缺 `web/` 行**：表内 13 行里最小的功能（运行指标 / 运行日志 / 旧上抛自动选择）都有行，而 12 文件 / 887 行、独占 WBS 模块 W3-008 的前端工程没有。按架构终稿找前端落点，会**空手而归** —— 这正是 N-1 的复发，只是换了文件：`docs/features/` 有了，索引没跟上。
- **§3.1 表头「`docs/features/` 共 36 份」→ 实为 38 份**（本轮 +`web.md` +`web.test.md`）。
- **§3.2「真机回归 case 14」→ 实为 15**（`tests/regression/fullflow-regression.mjs` 的 `CASES` 注册 15 条，含 `web` 与 `dynamic-planning-run`；后加的未回填）。

同一份文件内，§3.1 的行与 §3.2 的计数就是「发布基线核对」应当拦住的东西 —— 模块验收 #2/#3 都被它擦到。

### M-2（轻）· `CLAUDE.md` 的 MCP 工具计数过期，且与架构终稿打架

`CLAUDE.md:230` 写「awf-session（**5** tools）」并列出 5 个；`plugin/core/mcp/awf-session/server.cjs` 实际注册 **7** 个（漏 `awf_session_intervene` / `awf_session_interrupt`；`:300` 同错）。而 `architecture-v0.2.0.md §3.2` 写的是 **7** —— 同一事实两处矛盾。`CLAUDE.md` 本轮已被修改，其准确性已在本文件的维护范围内（N-2 处置即改了它）。

### M-3（轻）· `.awf/bugs/` 10 份文件**全部**不符合其自身规范

N-2 的裁定以 `code-doc` §4 与 `.awf/README.md` 为权威，二者对该落点的契约是 `NNN-short-slug.md` + frontmatter `id`（三位编号）。实际：

| 检查 | 结果 |
|---|---|
| 文件名 `NNN-` 前缀 | **0 / 10** 合规 |
| frontmatter `id` 字段 | **0 / 10** 存在 |
| 对照 `.awf/issues/` | **9 / 9** 合规（`001-…` + 编号） |

迁移时「保留文件名以留 git rename 溯源」是合理取舍，但**落点裁定了、落点自身的契约没核** —— 与 N-2 同型的下一层。修法二选一：改名补 frontmatter，或把 `.awf/README.md` / `code-doc` 的 bugs 命名条款改成既成事实（issues 与 bugs 命名不一致本身需要一次说明）。

### M-4（轻）· 578 KB 运行态备份入库

`.awf/state.json.bak-20260912T012459`（578,668 B）由 `ae2b0f3` 带入版本库，是**全仓唯一的 `.bak`**。它不属于任何现存代码路径：`backupState`（`src/lib/state.js:419`）写的是 `.awf/versions/<version>-<timestamp>.json`，而该目录已是本仓既有归档落点且**已在库中**（4 份）。同类先例：T3-009 门禁 N-1（`coverage/` 曾被误入库，判为需清）。

## 十一、结论

- 上轮 N-1…N-4 **四项全部实质结清**，且本轮核验的是**内容与实测**而非处置方自述 —— `web.md` 的 4 项数字、`testing-infrastructure.md` 的 3 组计数全部命中实测，这是本轮质量高于前版的地方。
- 不判 pass 的实质：N-1 的修复**没有传播到它自己的索引文件**——`web.md` 建起来了，但架构终稿 v4 §3.1「每份功能文档的实际落点」表里没有 `web/`，且两处计数因本轮改动而过期（M-1）。这与本模块两轮来的缺陷同型：**形式齐备而事实缺席**（第 1 轮是「清单不全」，本轮是「清单补了、总索引没改」）。M-2/M-3/M-4 为同型的轻度项。

→ **verdict: changes_requested**

修复要求（按优先度，均为小改）：

1. **M-1**：`architecture-v0.2.0.md` —— §3.1 补 `web/` 行（`web.md` / `web.test.md` ← `web/src` ← 真机 case `web`）；表头 36 → 38；§3.2 真机 case 14 → 15。
2. **M-2**：`CLAUDE.md` awf-session 5 → 7（两处），工具表补 `intervene` / `interrupt`。
3. **M-3**：`.awf/bugs/` 命名契约裁决并落地（改名 + 补 `id`，或改规范并向 issues 口径靠拢）。
4. **M-4**：`.awf/state.json.bak-20260912T012459` 出库（`git rm --cached`；如需保留磁盘副本，`.gitignore` 加 `.awf/*.bak-*`）。
5. **不改**：四项交付物本体（功能文档内容 / 架构终稿四块 / CHANGELOG / 复盘）经复核无需返工；`web.md`、`testing-infrastructure.md` 本轮已核的内容无需再动。

---

# 第 3 轮复审（T3-010 recheck 2）— 2026-09-12

> 复审对象：`T3-010-F2`（M-1…M-4 处置）后的当前工作树。口径同前两轮：**非真结构核查**。
> 本轮把 `.awf/README.md`（+ `src/templates/awf-README.md`）的**剩余条款逐条核完**，以界定「同类缺陷还有多少」，不再一轮一发现。

## 十二、上轮问题结清核对

| 上轮项 | 本轮第一手核验 | 判定 |
|---|---|---|
| M-1 架构终稿未传播 | §3.1 表头 **38**、新增 `前端工程（观测与控制台）` 行（列位与内容均正确）；§3.2 真机 case **15**（对 `CASES` 实测 15 条） | ✅ |
| M-2 CLAUDE.md 工具计数 | `:230` **7 tools** + 补 `intervene`/`interrupt` 两行 + 旧入口【已停用】标记；`:302` **7 个 tools**；与 `architecture §3.2` 的 7 一致 | ✅ |
| M-3 bugs 契约裁决 | 三处（`.awf/README.md` / `src/templates/awf-README.md` / `code-doc` §4）同文；10/10 文件合规（脚本复核：slug 命名 + 标题下元数据块 + `状态` 行）；残留 `NNN-short-slug` 引用**全部属 issues** | ✅ |
| M-4 备份出库 | `git ls-files` 中 `.bak` 计数 **0**；`git check-ignore` 命中 `.gitignore:17`（`/.awf/*.bak-*`）；磁盘副本保留 | ✅ |
| 同型扩大 ①decisions | 两处 README 已改为 `runs/<runStamp>.jsonl` + 三条不变量；与 `decision-store.cjs` 头注释一致 | ✅ |
| 同型扩大 ②`TEMPLATE.md`×3 | 两处 README 树已改为真实落点；`docs/features/init.md` 的骨架树本就无 TEMPLATE.md 且声明取自 `init.js` dirs —— **无第三个落点需要跟改** | ✅ |
| 同型扩大 ③`logs/` | 两处 README 已改为实测形态（`{version}-<ts>/` + `main.log` + `agents/`）+ 4 个真实顶层文件；`docs/features/run-logger.md` 与 `src/server/run-logger.cjs` 一致 | ✅ |
| 同型扩大 ④`{{VERSION}}` | 已渲染为 `v0.2.0`；模板侧保留占位符（`init` 的 `replaceInDir` 会替换，逻辑正确） | ✅ |
| **reports 契约（上轮登记项）** | F2 以 `.awf/issues/010-reports-contract-drift.md` **登记而非顺手改** —— 本轮**认可**该处置（契约裁决题须先定方向，不宜由修复任务单方决定），**不重复计入问题** | ✅ 处置正确 |

**旁证**：`npm run lint` 通过；`npm test` **98 文件 / 918 例全绿 exit 0**；`npm run check:arch` **EXIT 0**；`node scripts/render-config.mjs` 后渲染产物**零 diff**；模块四项验收点复核（38 份功能文档 / 架构终稿 / 版本 7 处对齐 / 复盘在位）全部成立。

## 十三、README 全量条款核对结论（本轮新增的界定工作）

为避免「一轮一个新发现」，本轮把 `.awf/README.md` 与模板的条款逐条对到代码/磁盘：

| 条款块 | 核对结果 |
|---|---|
| 目录树各条目 | ✅（`state.json` / `issues/NNN-` / `bugs/<slug>` / `decisions/runs/*.jsonl` / 五类 reports 子目录 / logs 布局 均与 `init.js` dirs 及磁盘相符） |
| `issues/` | ⚠️ **`labels` 枚举与既成事实不符（见 M-2）**；其余（命名 / `id` / `status` 枚举 / `assignee` / `milestone` / `priority` 枚举 / `created` / `updated` / `deps` / `related` / 状态流转 / 查询示例）逐条为真 |
| `bugs/` | ✅（本轮已改） |
| `decisions/` | ✅（本轮已改） |
| `versions/` | ❌ **与实现不符（见 M-1）** |
| `dynamic-planning/` | ✅（`run.dynamicPlanning` 键在 `awf-config.json` 与 `.awf/config.json` 均存在，服务实现与描述相符） |
| `reports/` | ⚠️ 已知未决（issue 010），按上轮约定不计 |
| `logs/` | ✅（本轮已改） |

即：**同类缺陷只剩 2 项**，且都定位到了具体措辞。

## 十四、本轮新发现

### M-1（轻）· `versions/` 契约与实现不符：文档说「每版本一个文件夹」，实现是扁平文件

| 口径 | 说法 |
|---|---|
| `.awf/README.md` / 模板 §versions | 「每个版本一个**文件夹**，内含该版本的完整 `state.json`」 |
| `.awf/README.md` / 模板 目录树 | `└── v0.1.x/state.json   # 各版本的完整状态快照` |
| `code-doc` §11 | `版本归档 \| .awf/versions/vX/state.json` |
| **实现**（`src/lib/state.js:419` `backupState`） | `path.join(dir, \`${state.version}-${ts}.json\`)` —— **扁平文件，无版本子目录** |
| 磁盘实测 | `.awf/versions/` 下 4 份 `0.2.0-2026-09-XXTHH-mm-ss.json`，**无任何子目录** |

三处文档互相一致但**与实现三者皆反**。后果与 M-3 同型：照 `v0.1.x/state.json` 去找的人会空手（该形状从未存在过）。
修法：三处改为实测形态（`versions/<version>-<timestamp>.json`，一次 run 完成一份快照，不建子目录）。

### M-2（轻）· `issues/` 的 `labels` 枚举与既成事实不符（63% 越枚举）

README 把 `labels` 写成封闭枚举 `bug` / `feature` / `enhancement` / `discussion` / `question` / `blocked`。实测 10 份 Issue 的 30 个标签实例：

| 标签 | 次数 | 在枚举内？ |
|---|---|---|
| `bug` | 7 | ✅ |
| `tooling` | 6 | ❌ |
| `discussion` | 4 | ✅ |
| `legacy` / `eval` | 各 2 | ❌ |
| `reliability` / `regression` / `recovery` / `real-run` / `observability` / `docs` / `deferred` / `contract-drift` | 各 1 | ❌ |

**越枚举 19/30 = 63%**；枚举内 `feature` / `enhancement` / `question` / `blocked` **四个值从未使用**。且次高频标签 `tooling`（6 次）在枚举里**没有对应项** —— 说明枚举不是「没被遵守」，而是**覆盖不了真实需要的领域维度**，与 `bugs/` 的 `status` 枚举同一性质（M-3 已裁为「自由文本」）。

（另注：上一轮报告写「issues 9/9 合规」只核了**命名与 frontmatter 字段存在性**，未核**枚举词表** —— 本条即那次漏核的账，且有 F2 新写的 issue 010 作实例。）

修法二选一：① 把 `labels` 改为**自由标签**（`string[]`）+ 给一个**建议核心集**与「领域词按需新增」的约定，并说明枚举为何不可行（同 `bugs/status` 的口径）；② 收敛现有 10 份 Issue 的标签到枚举内（会丢掉 `tooling` 等无对应项的语义，代价明显）。

## 十五、结论

- 上轮 **M-1…M-4 全部实质闭合**，同型扩大的四项（decisions / TEMPLATE.md / logs / {{VERSION}}）也全部落地；F2 对 reports 契约采取「登记而非顺手改」的处置**正确**。
- README 条款已**逐条核完**：同类缺陷从此剩 **2 项**（M-1 versions 措辞、M-2 labels 枚举），均定位到具体措辞，均为**一次性文案/裁决**量级。
- 不判 pass 的实质不变：文档契约与既成事实仍有两处不符，而这两处所在文件是 `awf init` **复制给每一个新项目**的规范（模板）——已修正的部分若留着未修正的部分，下一个接手者仍会照错的写。

→ **verdict: changes_requested**

修复要求（均为一处文案或一次裁决）：

1. **M-1**：三处（`.awf/README.md` §versions + 目录树、`src/templates/awf-README.md` 同两处、`code-doc` §11）改为实测形态 `versions/<version>-<timestamp>.json`。
2. **M-2**：裁定 `issues.labels` 口径并落地（建议同 `bugs/status` —— 自由标签 + 建议核心集 + 说明枚举为何不可行）；如选收敛标签，须逐项说明语义去向。
3. **不改**：F2 的四项与同型扩大四项经核验无需返工；reports 契约仍走 issue 010 的裁决路径，不在本任务内处置。

---

# 第 4 轮复审（T3-010 recheck 3）— 2026-09-12 · **verdict: pass**

> 复审对象：`T3-010-F3` 处置后的当前工作树。口径同前三轮：**非真结构核查**（真机回归由 T3-011 承担）。
> 本轮是 MAX_RECHECK（3）内的最后一轮；沿用并**扩展** F3 引入的「按错误签名扫全仓」方法做收敛判定。

## 十六、F3 结清核对

| 上轮项 | 本轮第一手核验 | 判定 |
|---|---|---|
| M-1 versions 契据 | 三处（`.awf/README.md` / 模板 / `code-doc` §11）均落到 `versions/<version>-<timestamp>.json`；两处目录树行均改为「版本归档（每次 run 完成一份 state 快照）」；与 `src/lib/state.js:431`（`\`${state.version}-${ts}.json\``）及磁盘 4 份实测形状一致 | ✅ |
| M-2 labels 裁决 | 两处 README 的 `labels` 行均为「**自由标签，不做枚举**：建议优先取 `bug` / `discussion` / `tooling` / `blocked` …」+ 一条「为什么不做枚举」的注（与 `bugs/status` 的自由文本注同写法）；`code-doc` §5 字段列表同步标注 | ✅ |
| F3 残尾 ①（树 logs 行 ×2） | 两处均为 `logs/` + `└── {version}-{ts}/`（对齐 `run-logger.cjs`） | ✅ |
| F3 残尾 ②（`code-doc` §11 运行日志行） | 已改实测形态 + 补 4 个真实顶层文件 | ✅ |
| F3 残尾 ③（`code-doc` §8「（待补）」） | 已替换为实际落点（`runs/<runStamp>.jsonl`）；全文 `待补` 命中 **0** | ✅ |

## 十七、扩展签名扫（本轮把 F3 的方法跑到底）

签名集扩到 12 个：`v0.1.x` / `NNN-short-slug` / `source.task_id` / `docs/bugs` / `TEMPLATE.md` / `run-batch` / `session-launch` / `dashboard.html` / `ui.html` / `phases.json` / `YYYY-MM-DD-HHmmss` / `enhancement`。逐条判定：

- **零命中**：`source.task_id`、`TEMPLATE.md`、`phases.json`、`YYYY-MM-DD-HHmmss`、`enhancement` —— 前几轮修掉的契约已无任何残留副本。
- **命中但合法**：`v0.1.x`（2 处，均为「早期形态已归档」的历史标注）；`NNN-short-slug`（3 处，均指 **issues**）；`docs/bugs`（1 处，`ai-refactor-retro` 的「原 8 条已归并」注明）；`run-batch` / `session-launch`（代码注释与 issue/bug 正文中的**历史叙述**，均已标注已删除，即前几轮 N-4 处置过的形态）；`dashboard.html` / `ui.html`（均写明「已废弃/已删除」（T1-094 / T1-119））。
- **命中且为真缺陷（1 处）**：`docs/CHANGELOG.md:21` ——

  > 细节见 `docs/features/`（**36 份**功能文档）

  实为 **38 份**（`docs/features/*.md` 实测 38），系本模块 N-1 补入 `web.md` / `web.test.md` 后未回填。**同一份 CHANGELOG 的 0.2.0 段是 T1-102 的交付物**，故属验收面内的数字滞后。

## 十八、两处口径裁决（本轮给出结论，不再下传）

**1. `.awf/README.md` 的目录树：判为「布局声明」，不要求逐条匹配本项目磁盘。**

依据：`src/templates/awf-README.md` 是 `awf init` 的复制源，其树描述的骨架已逐条对 `src/cli/init.js:88` 的 `dirs` 验真（`reports/lint|test|review|perf|summary`、`dynamic-planning/proposals`、`logs`、`versions` 等均在列）；本项目 `1cd255f`（2026-08-27「按精简模板重置」）删掉了 `TEMPLATE.md` 堆与空目录，空目录因此从 git 消失，属**本项目的修剪**而非声明的失真。故 F3 提出的悬置项**裁定为不构成缺陷**，无需改动（`context/` 一项见下）。

**2. `docs/CHANGELOG.md:21` 的「36 份」：不阻塞本门禁，归 `T4-001`。**

`T4-001`（项目文档完整性核对门禁，kind=doc，**deps 含 T3-010**）是本计划的全局文档门禁，正是这类「跨文档计数/完整性」的归属任务；本模块的验收面（W3-010 desc 四项）已全部成立，为一个指针句里的数字把模块门禁压在复审上限外（超限即需人工介入）不成比例。故**登记 + 转派**，不判 fail。

**（附）登记备查（不阻塞）**
- `docs/CHANGELOG.md:21`：「36 份」→「38 份」（建议 T4-001 顺手改，或与 CHANGELOG 定稿同步）。
- `.awf/context/`：目录存在且在用（`handoff.md` 已入库、`awf_context_ready` 写入），但**两份 README 的树与章节都未提它**（模板侧有、本项目副本侧被有意删去）。按口径 1 属布局声明范围，不判缺陷；若后续把本项目 README 定位为「本项目实际布局」，这将是首选项。

## 十九、验收点对表（W3-010 desc，四项 · 四轮复核）

| # | 验收点 | 第一手证据 | 判定 |
|---|---|---|---|
| 1 | 受影响功能文档更新 | `docs/features/*.md` **38 份**（含 15 份 `.test.md`）；`web.md` / `web.test.md` 文内数字（12 文件 / 887 行 / 0 个 `.css` / 36 例）均实测命中 | ✅ |
| 2 | 架构终稿 v4 落正式 docs/discuss | `architecture-v0.2.0.md` 254 行，四块齐备；§3.1 表头 **38 份**、`前端工程` 行在位；§3.2 真机 case **15** | ✅ |
| 3 | CHANGELOG v0.2.0 + 发布基线核对 | 0.2.0 段 59 行完整；版本 **7/7 处**对齐 0.2.0；`render-config` 渲染幂等零 diff | ✅（数字滞后一项转 T4-001） |
| 4 | AI 重构元实验复盘记录 | `ai-refactor-retro-v0.2.0.md` 在位（素材来源注已按 T3-010-F1 更正） | ✅ |

**旁证**：`npm run lint` 通过；`npm test` **98 文件 / 918 例全绿 exit 0**；`npm run check:arch` **EXIT 0**。

## 二十、结论

- 连续三轮的处置（F1 → F2 → F3）**全部结清**，且本轮用「按签名扫全仓」把前几轮修掉的契约逐个反查：**零残留副本**。
- 前三轮各自发现的缺陷有一个共同形态：**形式齐备而事实缺席 / 清单补了而索引与副本未跟**（W3-009 → T3-010 R1 → R2 → R3）。本轮不再有此类结构性问题；剩余仅一处**指针句里的计数滞后**，且已有归属任务（`T4-001`）。
- 模块验收四项经四轮复核稳定成立。

→ **verdict: pass**。修复轮次（3/3）用满，无新增修复任务；`T3-010` 可判 done，`T3-011`（全量真机回归门禁）随之就绪。

**遗留（非阻塞，已登记）**：`docs/CHANGELOG.md:21` 的「36 份」→「38 份」（归 T4-001）；`.awf/context/` 的文档缺位（按 §十八 口径 1 不判缺陷）。
