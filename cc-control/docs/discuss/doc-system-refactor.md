# 文档体系重构决策记录

日期：2026-08-28
决策人：v-shangjunhao + AI 协作评审
状态：accepted

## 背景

原 w-doc 命令（25 行）与 code-doc skill 仅声明「6 类文档分类 + 3 条原则」，与实际 `docs/` 目录（仅 features / bugs / discuss 三处）严重脱节；AI 生成文档质量不可控、消耗不可控。经逐点评审后重构文档体系。本文记录其中的关键决策。

## 决策汇总

| # | 决策 | 要点 |
|---|------|------|
| D1 | 文档范围全保留 | 功能 / 测试 / 开发日志 / bugs / issues / reuse / 决策记忆 / CHANGELOG 8 类全要，不砍 |
| D2 | 位置按「项目资产 / 开发产物」分层 | 人看的知识资产 → `docs/`；run 产物 → `.awf/` |
| D3 | 决策按「人 / AI」分落 | 人 → `docs/discuss/`（ADR）；AI → `.awf/decisions/`（run 过程记录，供人复盘，单独存） |
| D4 | 开发日志用 `.log.md` | 与功能 / 测试同目录，三件套 |
| D5 | CHANGELOG 独立 | 项目级版本变迁，重点概括，区别于开发日志细节 |
| D6 | 命令 / 技能职责分离 | w-doc = 总控（生成策略 / 意图解析 / 路由 / 规则）；code-doc = 实施（模板 / 时机 / 删除归档） |
| D7 | `.awf/` 文档统一管理 | issues / bugs / decisions / reports 纳入 code-doc；state / logs / versions 为运行时自动产物，不纳入 |
| D8 | 报告 5 类 | test / review / perf / lint / summary（新增性能分析报告 perf） |
| D9 | 弃用 `.claude/issues/` | 问题跟踪统一到 `.awf/issues/` |
| D10 | 级别 / 术语拆分为 awf-plan-level | 层级 `生态→系统→项目→模块→功能→任务`；术语统一（「需求」→「功能」） |
| D11 | 生成策略：默认不生成 | 按需触发、读者导向、门禁兜底、消耗开关 |
| D12 | 质量靠门禁兜底 | 产出过 review / test，schema 或路径不符 → 打回，宁缺勿滥 |

## 落地产物

| 产物 | 文件 |
|------|------|
| w-doc 总控命令 | `plugin/plugin-code/commands/w-doc.md` |
| code-doc 实施 skill | `plugin/plugin-code/skills/code-doc/SKILL.md` |
| awf-plan-level skill | `plugin/plugin-code/skills/awf-plan-level/SKILL.md`（awf-plan-wbs 级别定义改引用） |
| docs 消耗开关 | `.awf/config.json` 的 `docs` 段（enabled + types/reports 白名单） |
| init 目录骨架 | `src/cli/init.js`（+ `decisions` + `reports/perf`） |
| `.awf/` 结构定义 | `src/templates/awf-README.md` / `.awf/README.md`（+ decisions 章节 + perf） |
| 项目文档规范 | `CLAUDE.md` 文档系统章节（docs/.awf 分层 + 删 `.claude/issues/`） |

## 理由要点

- **位置分层**：人复盘 / 阅读的知识资产（功能 / 测试 / 决策 / 复用）留 `docs/`；运行产物（bug / issue / AI 决策 / 报告）归 `.awf/`，随版本归档，不污染项目资产。
- **AI 决策单独存**：run 过程记录，人要运行后复盘，独立 `.awf/decisions/` 便于 grep 与追踪。
- **总控 / 实施分离**：命令管「该不该写 / 写什么 / 按什么规矩」，skill 管「怎么写」；前者是决策层，后者是执行层。
- **默认不生成**：没有明确读者的文档不生成；消耗可控是硬约束。
- **术语统一**：级别与核心术语由 awf-plan-level 权威定义，禁止「需求 / 功能 / 模块」混用。
