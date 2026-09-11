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
