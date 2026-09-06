---
name: code-doc
description: >
  文档体系实施规范 — 每类文档的模板、命名、创建/更新时机，以及删除归档与优化规则。
  覆盖功能文档、测试用例、开发日志、Bug、问题、可复用资源、决策记忆（人/AI）、报告和变更记录。
  触发条件：w-doc 命令、需要生成或更新项目文档时。
  引用方：w-doc
---

# 文档体系实施规范

> 参考：Diátaxis（四类文档）、Michael Nygard ADR。框架层（粒度/路由/范围位置）见 w-doc 命令，本文只讲每类文档「怎么写」。

## 术语（全项目统一）

级别与核心术语（模块/功能/任务/需求/req-id）的定义见 **awf-plan-level** skill（权威）。本文档按该规范用词，禁止混用「需求/功能/模块」等近义词。

层级：`生态 → 系统 → 项目 → 模块 → 功能（WBS 叶子）→ 任务`

## 文档范围与位置（权威总表）

### 项目资产 → `docs/`

| 类型 | 位置 |
|------|------|
| 功能文档 | `docs/features/<name>.md` |
| 测试用例 | `docs/features/<name>.test.md` |
| 开发日志 | `docs/features/<module>/<req-id>.log.md` |
| 决策记忆（人） | `docs/discuss/` |
| 可复用资源 | `docs/reuse/` |
| 变更记录 CHANGELOG | `docs/CHANGELOG.md` |

### 开发产物 → `.awf/`

默认放 `.awf/`；项目无该目录时退回 `docs/`。

| 类型 | 位置 |
|------|------|
| Bug 记录 | `.awf/bugs/` |
| 问题记录 | `.awf/issues/` |
| 决策记录（AI） | `.awf/decisions/` |
| 报告 | `.awf/reports/`（test / review / perf / lint / summary） |

---

## 1. 功能文档

- **读者 / 用途**：后续任务 / 新接手 AI 和人；功能实现细节（代码驱动的参考），必须过门禁
- **命名**：模块级 `docs/features/<name>.md`；功能级 `docs/features/<module>/<req-id>.md`
- **创建时机**：规划阶段出骨架（概述 + 验收标准），开发完成后按代码补全
- **更新时机**：功能代码变更时同步；review/test 发现描述与代码不符时

```markdown
# [功能名] — 功能文档

> 对应 WBS：[节点编号]
> 源码：src/xxx

## 功能描述
[该功能做什么，1-3 句；含边界条件和异常情况]

## 执行流程
[流程图或步骤列表，标注关键决策点]

## 核心常量 / 配置
| 常量 | 值 | 说明 |
|------|-----|------|

## 函数清单
| 函数 | 说明 | 位置 |
|------|------|------|

## 接口 / 依赖
| 模块 | 用途 |
|------|------|

## 验收标准
- [ ] 标准 1
- [ ] 标准 2
```

## 2. 测试用例

- **读者 / 用途**：TEST 阶段验收；验收依据
- **命名**：模块级 `docs/features/<name>.test.md`；功能级 `docs/features/<module>/<req-id>.test.md`
- **创建时机**：功能文档成型后
- **更新时机**：功能/接口变更时同步；测试策略调整时

```markdown
# [功能名] — 测试用例

> 对应功能文档：docs/features/<module>/<req-id>.md
> 源码：src/xxx
> 测试文件：tests/...

## 测试场景总览
| # | 场景 | 类别 |
|---|------|------|

## 详细测试用例

### TC1: [场景名]
**前置条件**：[精确初始状态]
**执行**：[具体调用]
**断言**：
- [精确结果]
- ...

## Mock 策略
| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
```

> 721 渐进式（70% 单元 / 20% 集成 / 10% E2E）作为测试设计参考，见 code-test-case；默认只留用例文档不写测试代码，逻辑过复杂或回归频繁时再补代码。

## 3. 开发日志

- **读者 / 用途**：复盘 / 追溯；核心变更 + 关键决策（细节）
- **命名**：`docs/features/<module>/<req-id>.log.md`（`.log.md` 与功能/测试同目录）
- **创建时机**：功能开发开始即建
- **更新时机**：每次功能开发收尾追加；关键决策发生即记

```markdown
# [功能名] — 开发日志

> 记录核心变更和关键决策，不记录临时调试信息。

## 变更记录

| 日期 | 变更类型 | 描述 | 关联 commit |
|------|---------|------|------------|
| ... | feat/fix/refactor | ... | ... |

## 关键决策

1. [决策] — [原因] — [权衡]

## 已知问题

- [问题描述] — [影响] — [计划]
```

## 4. Bug 记录

- **读者 / 用途**：修复者 / 复盘；踩坑记忆，同样的错不犯第二次
- **位置 / 命名 / frontmatter**：见 `.awf/README.md`（`.awf/bugs/NNN-short-slug.md`；frontmatter：`id` / `title` / `status` / `severity` / `source.*` / `labels` / `created` / `resolved`）
- **创建时机**：`awf run` 执行中发现缺陷即记
- **更新时机**：状态流转 `open → confirmed → in_fix → resolved`（可旁路 `wontfix` / `duplicate`）
- **正文**：现象 → 复现步骤 → 根因分析 → 修复方案 → 关联
- 需跨任务跟踪时，在 `issues/` 建对应 Issue 并 `related` 双向关联

## 5. 问题记录（Issue）

- **读者 / 用途**：决策者；阻塞 / 待决策 / 风险跟踪
- **位置 / 命名 / frontmatter**：见 `.awf/README.md`（`.awf/issues/NNN-short-slug.md`；frontmatter：`id` / `title` / `status` / `labels` / `assignee` / `milestone` / `priority` / `created` / `updated` / `deps` / `related`）
- **创建时机**：阻塞问题 / 待决策事项 / 风险出现时即记
- **更新时机**：状态流转 `open → in_progress → resolved`（可旁路 `wontfix` / `duplicate`）
- **正文**：描述 → 影响 → 选项/权衡 → 决议
- 承担与 GitHub Issues 相同功能（缺陷/待办/讨论/决策）；本地先记，需跨团队协作再同步 GitHub

## 6. 可复用资源

- **读者 / 用途**：后续开发；减少重复造轮子（索引去重）
- **命名**：`docs/reuse/<name>.md`（按组件/模块/代码片段粒度）
- **创建时机**：出现可复用点即记
- **更新时机**：资源接口/用法变更时
- **作用**：减少重复造轮子

```markdown
# [资源名]

## 用途
[解决什么问题]

## 来源
[出处 / 关联 commit]

## 用法
[示例代码 + 关键参数]
```

## 7. 决策记忆（人）

- **读者 / 用途**：决策者 / 后续讨论；防反复争论
- **命名**：`docs/discuss/<topic>.md`，重大决策用 ADR 编号 `ADR-<NNN>`
- **创建时机**：做出影响架构/方案的决策时（**在实现该决策的 PR 里同步写**）
- **更新时机**：append-only，不修改已 accepted 的 ADR

```markdown
# ADR-001: [一句话决策]

状态：accepted   // proposed / accepted / deferred / superseded / withdrawn

## 背景（Context）
[真实约束]

## 决策（Decision）
[主动语态："我们将采用 X"]

## 后果（Consequences）
正向 / 负向

## 备选方案（Alternatives）
[为何不选]
```

- 一条 ADR 只记一个决策；被推翻 → 写新 ADR 并 superseded 引用
- AI 运行期的辅助决策不属于此处，见下

## 8. 决策记录（AI）

- **读者 / 用途**：运行后复盘的人；run 过程可追溯
- **位置**：`.awf/decisions/`（独立目录，区别于 `docs/discuss/` 的人为架构决策）
- **定位**：`awf run` 运行过程中的辅助决策记录，供人**运行后复盘**查看，不并入 issues 跟踪
- **命名 / frontmatter**：见 `.awf/README.md` 的 `decisions/` 章节（待补）
- **创建时机**：AI 在运行期做出辅助决策时即记
- **更新时机**：append-only

```markdown
# AI 决策 [id]：[一句话]

## 场景
[触发背景 / 上下文]

## 决策
[AI 选了什么 + 依据]

## 说明
[可复现性 / 是否需要人工复核]
```

## 9. 变更记录 CHANGELOG

- **读者 / 用途**：使用者 / 发布者；版本变迁概览
- **命名**：`docs/CHANGELOG.md`（项目级，唯一）
- **创建时机**：首个版本发布
- **更新时机**：每个版本发布时追加一段
- **定位**：整体版本变迁，**重点概括**（细节见各功能 `.log.md`）

```markdown
# Changelog

格式参考 Keep a Changelog + 语义化版本。

## [Unreleased]

## [0.1.4] - 2026-08-28
### Added
- 新增 xxx（一句话，含影响面）
### Changed
- xxx
### Fixed
- xxx
### Removed
- xxx
```

## 10. 报告（reports）

`awf run` 各阶段 AI 产出的报告，见 `.awf/README.md`（`.awf/reports/`，按类型分目录）。

| 类型 | 目录 | 阶段 | 内容 |
|------|------|------|------|
| 测试报告 | `.awf/reports/test/` | TEST | feature / impacted / full_regression |
| 审查报告 | `.awf/reports/review/` | REVIEW | code / security / ui / architecture |
| 性能分析报告 | `.awf/reports/perf/` | REVIEW | 性能分析（瓶颈、优化建议、量化指标） |
| Lint 报告 | `.awf/reports/lint/` | DEV/REVIEW | Lint 检查 |
| 汇总报告 | `.awf/reports/summary/` | FINISH | 里程碑汇总 |

- **命名**：`<task-id>-<slug>.md`，summary 为 `summary.md`
- **frontmatter**：`type` / `task_id` / `milestone` / `result`（pass/fail/partial/changes_requested）/ `created`
- **读者 / 用途**：门禁 / 复盘；阶段结果记录
- **创建时机**：对应阶段（TEST/REVIEW/FINISH）执行时产出
- **内容来源**：测试报告见 code-test-case；审查报告见 code-review-* skills；性能报告见 code-review-performance

## 11. 非 w-doc 管理的 .awf/ 产物（列出，不通过本 skill 生成）

| 项 | 位置 | 谁生成 |
|----|------|--------|
| 运行时状态 | `.awf/state.json` | awf-state MCP tools |
| 运行配置 | `.awf/config.json` | init / 手工 |
| 版本归档 | `.awf/versions/vX/state.json` | awf run FINISH 快照 |
| 运行日志 | `.awf/logs/YYYY-MM-DD-HHmmss/`（run.log / phases.json / errors.json / metrics.json） | CLI/hooks 自动捕获 |
| 计划产物 | `.awf/plan/`（discussion / wbs） | awf-plan-* skills |
| 跨阶段上下文 | `.awf/context/handoff.md` | code-context-onboard skill |

这些是运行时/流程产物，不由 w-doc 生成；schema 见 `.awf/README.md` 或对应 skill。

---

## 文档生命周期（跨类通用）

### 删除 / 归档

| 场景 | 处理 |
|------|------|
| 功能下线 | 功能文档 / 测试 / 开发日志 → 移 `docs/features/_archived/`（默认）或直接删除（git 可回溯） |
| Bug / Issue 解决 | 状态标记「已关闭」，不物理删除 |
| 决策被推翻 | 写新 ADR 并 superseded，不删旧条目 |
| CHANGELOG / reuse | append-only，不删 |

### 优化

- **过时即改/删**：新鲜度是硬指标，文档声明代码里不存在的东西就是传播错误
- **一页一类**：混写拆页（Diátaxis），缺教程/解释就补，别只堆参考
- **重复合并**：reuse 索引去重，避免多份同类文档
- **过长拆分 / 碎片合并**：一页超长拆成多页；内容过少合并到父文档
- **增量优先**：增量更新优先于全量重写

## 四类文档写作法（Diátaxis）

每一页先判断属于哪一类，**一页只做一类**：

| 类型 | 回答的问题 | 写法 |
|------|-----------|------|
| 教程 | 从零教我 | 步骤式、带讲解，读者照着做 |
| 指南 | 怎么做 X | 祈使句、编号步骤、可复现命令 |
| 参考 | 细节是什么 | 中立、穷尽、可扫描（API 参数表、配置键） |
| 解释 | 为什么这样 | 讲理由和取舍，防反复争论 |

## 原则

- **少而精**：默认不生成、按需生成；没有明确读者的文档不生成；过时文档比没文档更糟，宁缺勿滥
- 文档与代码同仓库，同提交更新
- 分类是为了查找快，不是为了分类多
- 每份文档有 owner；不同层级文档标准不同（团队内部文档不必达到对外标准）
- 写最坏时刻的文档——runbook 是凌晨三点值班人员打开的，要编号步骤 + 可粘贴命令 + 预期输出

## 反模式

- 页面堆砌教程+参考+解释混在一页
- 只堆自动生成的参考文档，缺教程和解释
- 例子未经测试——"照着做会失败"的文档不如没有
- 专业盲区——对熟悉系统的人省略"显然的步骤"，新读者卡死
