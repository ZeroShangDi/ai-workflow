---
id: "010"
title: "报告（reports）文档契约与实现不符：README §reports / code-doc §10 的 frontmatter 与「按版本分目录」在 0 份实际报告中出现"
status: open
labels: [docs, contract-drift, discussion]
assignee: null
milestone: null
priority: medium
created: 2026-09-12
updated: 2026-09-12
deps: []
related: ["T3-010-F2"]
---

# 报告（reports）契约与实现不符

**一句话**：`reports/` 的文档契约在两处（`.awf/README.md` §reports、`code-doc` §10）写明了**通用 frontmatter** 与
**按版本分目录**，但实际 0 份报告实现前者、目录是扁平的；这是**契约裁决题**，不是命名笔误，故登记而非顺手改。

## 一、契约怎么说

- `.awf/README.md` §reports（`src/templates/awf-README.md` 同文，`awf init` 直接复制）：
  「按类型**和版本**分目录」、子目录注「测试报告（**按版本分目录**）」，并有「**通用 Frontmatter**」表：
  `type` / `task_id` / `milestone` / `result` / `created`，末尾「各类型附加字段见**模板**」。
- `plugin/plugin-code/skills/code-doc/SKILL.md` §10 重述同一契约（frontmatter 四字段 + 命名 `<task-id>-<slug>.md`）。

## 二、实现是什么样

| 契约点 | 实际 | 证据 |
|---|---|---|
| 按版本分目录 | ❌ 扁平 | `.awf/reports/test/` 下直接是 `t3-010-module-gate.md`、`w3-009-module-gate.md` …（无版本子目录） |
| 通用 frontmatter | ❌ 0 份 | 抽查 `t3-010-module-gate.md` / `w3-009-module-gate.md` / `t3-011-full-real-gate.md` / `refactor-recovery-audit.md`：首行一律是 `# 标题`，**无 YAML frontmatter** |
| 「见模板」 | ❌ 无模板 | 仓库内不存在报告模板文件 |
| 归入五类子目录 | ⚠️ 有例外 | 不属 test/review/perf/lint/summary 的专题报告直接落 `reports/` 顶层：`architecture-discipline-audit.md`、`u5-scan.md`、`v0.2.0-state-analysis.md`、`refactor-recovery-audit.md` |

**没有代码解析报告 frontmatter**：唯一程序化读报告的是 `src/lib/gate-loop.cjs:18`，它从任务 `exec.files` 里取**路径**
（`.awf/reports/` 前缀），不读文件内容。所以 frontmatter 目前只有「给人看」的潜在价值。

## 三、为什么登记而不是顺手改

与 `T3-010-F2` 处置的 M-3（`.awf/bugs/` 契约）**不同型**：

- M-3 是「命名/格式与既成事实不符」——把规范改成既成事实即可，无信息损失（且 bugs 的自由文本状态本身就比枚举更有信息量）。
- 本条是**是否保留 frontmatter 契约**的产品裁决：删掉它就等于放弃「报告可被程序化检索/渲染」这条路线；
  保留它则要给报告**生成链路**（谁写报告：AI 按 `code-doc`；门禁报告由 `gate-loop` 消费）补上写入与校验。
  两种修法方向相反，必须选一个。

## 四、两种修法

**(a) 保留契约并落地**：报告模板确实产出，AI 写报告时带 frontmatter；`reports/` 按版本分子目录（或明确放弃版本分层，
把条款改掉）；顶层专题报告归位（新增 `reports/analysis/` 或明确允许顶层）。
—— 收益：`result` / `task_id` 可检索、可汇总（例如「本版本所有 `changes_requested` 的门禁报告」）。

**(b) 收敛契约到既成事实**：删掉 README / `code-doc` 的通用 frontmatter 条款与「按版本分目录」，
改成「报告是纯 Markdown，结论写在正文；文件名 `<task-id>-<slug>.md`」。
—— 收益：零实现成本，规范立即为真；代价：放弃程序化检索那条路线。

## 五、影响

`.awf/README.md` 是 `awf init` 复制出去的**面向所有新项目**的规范，`code-doc` 是 w-doc 的实施依据 ——
两处都写着一条 0% 实现的契约，接手者会照它写出第三种形态。属文档面契约债务，非运行时缺陷。
