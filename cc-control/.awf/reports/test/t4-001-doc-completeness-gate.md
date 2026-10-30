---
type: test
task_id: T4-001
milestone: v0.2.0
result: changes_requested
created: 2026-09-12
---

# T4-001 · 项目文档完整性核对门禁 — 报告

> 2026-09-12 · 口径：对**五类文档**（功能/测试 · 问题 · Bug · 决策 · 报告）+ 顶层索引与发布产物做
> **完整性 + 契约合规 + 声明与实现一致性**核对，全部结论取自第一手命令输出与文件内容。
> 不含真机运行（真实链路已由 T3-011 承担）。
>
> **关于本报告的 frontmatter**：`.awf/README.md` §reports 与 `code-doc` §10 都写明报告须带
> `type/task_id/milestone/result/created`，而现存 12 份报告 0 份带（已登记 `issue 010`，是「契约要不要留」的**裁决题**）。
> 本报告按**书面契约**给出 frontmatter —— 裁决的是契约的去留，不是「写下的契约要不要被遵守」；
> 这也给 010 的裁决留一个「带 frontmatter 的报告长什么样」的样本，便于判断代价。

## 一、五类文档现状（实测）

| 类 | 落点 | 实际 | 契约（`.awf/README.md` / `code-doc`） | 合规 |
|---|---|---|---|---|
| 功能文档 | `docs/features/*.md` | **23 份**（+15 份 `.test.md`，合计 38 文件） | 模块级 `<name>.md`；模板含功能描述/流程/函数清单/验收标准 | ✅ 命名与结构合规 |
| 测试用例 | `docs/features/*.test.md` | **15 份** | 「对应功能文档」反向指针 + 场景总览 + 用例 + Mock 策略 | ⚠️ 1 份缺反向指针（**D-8**） |
| 问题记录 | `.awf/issues/` | **12 份**（11 编号） | `NNN-short-slug.md` + 11 字段 frontmatter + status 枚举 | ⚠️ **编号冲突**（**D-1**） |
| Bug 记录 | `.awf/bugs/` | **10 份** | `<slug>.md` 不编号 + 标题下元数据块 | ✅ 全部合规 |
| 决策记忆（人）/ AI | `docs/discuss/` · `.awf/decisions/runs/` | discuss **29 份**（另 `_archived/` 7 项）；decisions 1 个 jsonl | append-only；`runs/<runStamp>.jsonl` | ✅ |
| 报告 | `.awf/reports/` | **12 份** | `<task-id>-<slug>.md` + frontmatter + 按类型分目录 | ⚠️ 已在册 `issue 010`（本门禁不重复登记） |

**旁证（实测）**：`npm test` **98 文件 / 924 例全绿**；`npm run test:real -- --list` **15 个 case**；
`npm run eval -- --list` **10 个 case**；MCP 工具面实测 `awf-state` **20** / `awf-session` **7** / `awf-oneshot` **1**
（与 `CLAUDE.md:230`、`architecture-v0.2.0.md §3.2` 三方一致）；`docs/features` **38** 与 §3.1 表头一致。

**已复核在位的上轮修复**：T3-010 的 N-1（`web.md` 补齐）/ N-2（bug 落点收敛到 `.awf/bugs/`）/ N-3 / N-4
逐条仍在位；M-1 的两处计数（38 份 / 15 case）已改正。旧引用（`src/cli/run-batch.js` 等 8 处）
逐条复核**均已正确标注**「已删除 / 已随…删除」，写法与 N-4 的范例一致。

---

## 二、发现

### D-1（中）· 两份 Issue 共用编号 `010`，违反「NNN 三位递增编号」

| 文件 | frontmatter `id` | created | related |
|---|---|---|---|
| `.awf/issues/010-host-blind-to-dead-session.md` | `"010"` | 2026-09-12 | `T3-011` `T1-111` `009` |
| `.awf/issues/010-reports-contract-drift.md` | `"010"` | 2026-09-12 | `T3-010-F2` |

`a33fc1b`（「登记 010/011」）新增的是 `010-host-blind-to-dead-session.md`，而同批已存在 F2 登记的
`010-reports-contract-drift.md` —— 登记时未查号。影响：按 `NNN` 引用/检索会歧义（若将来有脚本按 `id` 建索引，
会直接覆盖）。全仓按文件名的引用目前**只有** `t3-010-module-gate.md:183` 指向 reports 那份（未被牵连）。

**修复**：后登记者改号 —— `010-host-blind-to-dead-session.md` → `012-host-blind-to-dead-session.md`（文件名 + frontmatter `id`），
并顺带核一遍 `state.json` 里对它的引用。

### D-2（中）· `.awf/README.md` 缺 `context/` 章节，且落后于 `src/templates/awf-README.md`

`awf init` 用 `fs.copyFile(tpl/awf-README.md → .awf/README.md)`（`src/cli/init.js:93`）落地本文件。
模板在 `de886dc`（2026-09-12）被更新，本项目这份（`a33fc1b`）**没有回灌**，`diff` 出实质差异：

| 差异 | 模板（新） | 本项目 `.awf/README.md`（旧） |
|---|---|---|
| 目录树含 `context/` | ✅ `architecture.md` + `handoff.md` 两行 | ❌ 整块没有 |
| `## context/` 章节 | ✅ | ❌ 没有该章节 |
| `dynamic-planning/` | `proposals/` + `events.jsonl` 两行 | 只有 `proposals/` |

后果不是「少了点说明」：`code-doc §11` 明确把 `.awf/context/handoff.md` 的 schema 指向
**`.awf/README.md`**，而这份 README 里根本没有 `context/`；同时 **4 个 skill**（`w-dev`、`code-architecture`、
`code-review-architecture`、`code-context-onboard`）都指向 `.awf/context/architecture.md`，读者顺着
「schema 见 `.awf/README.md`」去查会空手而归。本目录下 `context/handoff.md` 是实际存在的。

**修复**：把模板的 `context/` 章节与本项目实际目录树同步过来（保留本项目的本地说明，如
`approve_then_apply` 那句），并核对 `dynamic-planning/` 两行。

### D-3（中）· `docs/CHANGELOG.md` 的 `[0.2.0]` 段三处数字已过期

| 行 | 写的 | 实测 | 说明 |
|---|---|---|---|
| `:21` | `docs/features/`（**36 份功能文档**） | **38 个文件 = 23 份功能文档 + 15 份测试文档** | 36 是把「文件数」当「功能文档数」，两个口径都不对（38 才是文件数，23 才是功能文档数） |
| `:34` | 真机回归 harness（**13 个 case × 150 断言**） | `--list` 实测 **15 个 case**；断言按各 case 注册数合计 **203** | 13/150 是动态规划两个 case 加入**之前**的口径（T3-011-F1 时 151，T3-011 后 dynamic-planning-run 22→21） |
| `:70` | `server.cjs` 仍是单体（**1491 行** / 上限 1600） | **1600 行，顶满上限** | 「未收口」这条现在是**硬约束**：T1-120 对它的改动只能是净零行（加 1 删 1）才没破线，任何一处新增都会当场让 `npm run check:arch` 变红 |

CHANGELOG 是发布基线（T1-102 的验收对象），读者按它核对现状会得到与仓库不符的结论。

**修复**：三处改数字（事实错误，不是重写历史）；`:70` 建议补一句「已顶到结构断言上限 → T1-113 的拆分是硬前置」。

### D-4（中）· `[Unreleased]` 缺 T1-120 造成的**用户可见面**变更

T1-120 移除了 CLI 的 `-a/--auto` 与 `-l/--local`（`awf run -a` 现在**显式报错** `unknown option '-a'`），
并修掉了门禁扫描假阴性、`?sid` 死字段、`/run/events` 的 `limit` 静默丢弃。`[Unreleased]` 段有
Fixed / Added 两节，但 **Removed 一节不存在**，CLI 表面的移除没有任何落点；issue 003 的修复（验证工具自身缺陷）
也未入册。

**修复**：`[Unreleased]` 补 `### Removed`（两个 CLI 选项 + 理由）与 `### Fixed`（门禁扫描剥注释 / 死字段摘除 / limit 转发）。

### D-5（轻）· `docs/features/testing-infrastructure.md` 的「已校对」数字过期

banner 写「**2026-09-12 校对**」，正文校注写「`npm test` 为 **98 文件 / 918 例全绿**」；实测现为 **924 例**
（T1-120 新增 6 例：扫描器 5 + 宿主 limit 1）。该 banner 的作用正是「读时以本节为准」，
而它现在是错的 —— 与 T3-010 N-3 同型（那次修的是「当前零测试」，数字部分没一起处理）。

**修复**：改成 924（或去掉具体例数，改为「见 `npm test` 实跑」以防再漂）。

### D-6（轻）· `docs/features/eval-design.md` 无状态标注，产物表 3 处指向不存在的路径

- 引用 `docs/features/eval-results.json`、`docs/features/eval-report.html`、`tests/fixtures/eval-tasks/` —— **均不存在**。
- 该文件无 banner（既没说「设计稿未落地」，也没说「已按新形态落地」）；而 eval 体系实际**已落地**
  （`tests/eval/`，`npm run eval -- --list` 列 10 个 case），形态与本设计的三模式对比实验不同。
- 同型的 `testing-infrastructure.md` 在 T3-010 N-3 加了状态 banner，这份当时不在清单内、未处理。

**修复**：按 N-3 的写法加状态 banner（历史设计文档 / 部分落地），并把不存在的产物表标为「设计中的产物」。

### D-7（轻）· `CLAUDE.md` 目录树整块漏掉 `src/lib/` 与 `src/adapters/`

树里 `src/` 只列 `awf.js` / `cli/` / `server/` / `templates/`；实际还有 **`src/lib/`（28 文件）** 与
**`src/adapters/`（7 文件）** —— 两者恰是 v0.2.0 的两个核心（单写者 store / 端口契约，见 §重要文件表）。
`CLAUDE.md` 是每个会话都会读的指令文件，树是它的第一入口。同株另缺 `plugin/` 根下的
`CHECKLIST.md` / `PLAN.md` / `README.md`（次要）。

**修复**：树内补 `lib/` 与 `adapters/` 两行（一句话职责即可）。

### D-8（轻）· `docs/features/version-prompt.test.md` 缺「对应功能文档」行

其余 14 份 `.test.md` 首块都有 `> 对应功能文档：docs/features/<name>.md`，这份没有（只有「源码文件」行）。
文件名能对上，但按「测试文档 → 功能文档」的机械检索会漏。

**修复**：补一行反向指针。

---

## 三、判断项（已核，**不**判缺陷）

| 项 | 判定 |
|---|---|
| `docs/features/` 有 8 份功能文档无 `.test.md`（adapters / api / eval-design / events / metrics / run-domain / store / testing-infrastructure） | **不判缺陷**：这 8 份是 Diátaxis 的**参考类**文档，其验收依据在 `tests/`（924 例单测 + 15 个真机 case）与各自的「真机 case」列；`code-doc` 只写「测试用例在功能文档成型后创建」，**未要求一一配对**。其中 `eval-design` 另按 D-6 处置 |
| `reports/` 零 frontmatter + 扁平目录（不按版本分子目录）+ 4 份专题报告落 `reports/` 顶层 | **已在册**：`issue 010`（2026-09-12 登记），是契约**裁决题**（README/code-doc 的契约 vs 实际），本门禁不重复登记、不单方裁决 |
| `.awf/state.json.bak-20260912T012459` | 非问题：`.gitignore:19` 已忽略（`a33fc1b` 补的） |
| `.awf/context/` 无 `architecture.md`（4 个 skill 引用它） | 非问题：skill 措辞是「存在时」；`handoff.md` 在位 |
| 8 处指向已删文件的旧引用（`src/cli/run-batch.js` 等） | 已核**全部带历史标注**，符合 N-4 确立的写法 |
| `docs/discuss/real-run-coverage-gaps.md` 的 204 断言记录 | 非问题：文中已显式标注「204 是隔离模式下的最后一次全量记录，当前应为 203 且**尚未跑过**」 |

---

## 四、结论

**verdict: changes_requested**

五类文档**结构齐全、命名与字段合规**（Bug 10/10、Issue 12 份文件字段全（11 个编号）、功能/测试 23+15 无孤儿配对），
上轮 T3-010 的四项修复全部在位，旧引用标注纪律保持得比上轮更严。**不判 pass 的实质是 8 条「声明与现状不符」**：

- **D-1 / D-2 / D-3 / D-4** 是「**基线层面的错**」—— Issue 编号冲突、`awf init` 会复制给新项目的 README 领先于本项目自己那份、
  发布基线（CHANGELOG）三处数字过期且缺一节用户可见面变更；
- **D-5 / D-6 / D-7 / D-8** 是「**自称已校对的文档其实没校对**」，其中 D-5 的 banner 正写着「读时以本节为准」而本节是错的。

修复要求（按优先度）：

1. **D-1** 改号（`010-host-blind-to-dead-session` → `012`）+ 核引用。
2. **D-2** 用模板的 `context/` 章节回灌 `.awf/README.md`（保留本项目本地说明）。
3. **D-3 / D-4** 修正 CHANGELOG 的 `[0.2.0]` 三处数字，并补 `[Unreleased]` 的 `Removed`（两个 CLI 选项）与相应 Fixed 条目。
4. **D-5 / D-6** 修正/补状态 banner 与过期数字。
5. **D-7 / D-8** 补 `CLAUDE.md` 树两行与测试文档的反向指针。
6. **不改**：`reports/` 契约走 `issue 010` 的裁决路径（本报告给出一个带 frontmatter 的样本供参考）；8 份无 `.test.md` 的参考类文档不需要补配对。

**本门禁覆盖边界**：不判「真机链路是否真的通」（T3-011 承担）、不判 `reports/` 契约去留（issue 010）、
不判草稿类（`docs/discuss/` 的讨论稿与 `_archived/` 按历史记录对待）。
