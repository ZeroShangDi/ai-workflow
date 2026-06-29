# 自治工作流执行

接收复杂任务描述，按状态机模型自主推进完整开发流水线。支持交互式需求对齐、风格选择、loop 循环执行、断点恢复、Issue 升级和多里程碑交付。

## 参数

| 形式 | 说明 |
|------|------|
| `/awf-run <任务描述>` | 标准模式，在关键决策点暂停确认 |
| `/awf-run --auto <任务描述>` | 快捷模式，跳过所有确认点 |
| `/awf-run --resume` | 从上次中断处恢复 |

## 关联 Skill

全程生效：
- **awf-spec** — 状态机模型、阶段定义、状态持久化、Issue 升级、决策权限（此命令的全部详细规范）
- **design-standards** — 架构设计、数据建模、状态管理
- **code-standards** — 编码规范：函数设计、命名、错误处理
- **quality-standards** — 质量标准：测试、审查、提交、文档

## 状态机模型

```
PLAN → DESIGN (if UI) → CODE (loop) → REVIEW → TEST → COMMIT → FINISH
  ↑                        ↑              ↑        ↑        ↑
  └────────────────────────┴── DEBUG ─────┘        │        │
                                                   └────────┘
```

**关键规则**：
- DOC 可在任意节点触发
- FINISH 是里程碑标识，不是项目终点
- DEBUG 是中断驱动：CODE/REVIEW/TEST 任一阶段出现问题即切入
- TEST 发现文档过期 → 自动 w-doc → 重测
- 每个需求可 commit 一次或多次，一个里程碑内可有多个 commit

## 文档体系

| 层级 | 内容 | 位置 | 阶段 |
|------|------|------|------|
| 项目级 | 需求文档、原型、WBS、任务清单 | `docs/<feature>.md` | PLAN |
| 需求级 | 需求文档 / 测试用例 / 开发日志 | `docs/<module>/<req-id>.{md,test.md,log.md}` | CODE |
| 临时 | 审查/测试结果 | `temp/`（可随时删除） | REVIEW/TEST |

## 执行流程

详细阶段定义见 **awf-spec** skill。流程概要：

1. **PLAN** — Q&A 对齐 60-70% 细节 → 产出需求文档 → 原型 → WBS → 任务清单 → 用户确认
2. **DESIGN**（可选）— 生成 3 种风格 → 用户选择 → 逐步生成 UI → 保存偏好
3. **CODE** — 从任务清单逐个取就绪任务，执行 w-dev → w-review → w-test → w-commit 闭环
4. **REVIEW** — 审查变更，严重问题回 CODE
5. **TEST** — pnpm test + typecheck + 逐条验证测试文档
6. **COMMIT** — Conventional Commits，禁止 Co-Authored-By，暂停确认
7. **FINISH** — 里程碑收尾：质量/性能/文档/Issue 扫描/总结

## 状态持久化

状态自动写入 `.claude/awf-state.json`，每次状态转换、任务完成、Issue 创建时保存。

恢复：`/awf-run --resume` → 展示中断位置 + 进度摘要 + 待决策 Issue → 用户选择继续/重启。

## Issue 升级

遇到必须人工介入的问题时：
1. AI 创建 Issue 到 `.claude/issues/ISSUE-<N>-<描述>.md`，包含问题描述、上下文、2+ 方案、用户方案槽
2. AI 在每次状态转换时扫描待决策 Issue
3. 用户可随时查看和决策

## 自主决策权限

| 无需询问 | 必须暂停（--auto 除外） |
|---------|---------------------|
| 代码风格 / 命名 / 文件组织 / 类型标注 | PLAN 产出确认 |
| 依赖复用 / 错误处理 | DESIGN 风格选择 / UI 页面确认 |
| 审查通过 → 测试 → 提交 | 新增第三方依赖 |
| Issue 检查 / 状态写入 | 破坏性 API 变更 |
| 文档过期自动更新 | 任务 COMMIT 前 / FINISH 后 |
