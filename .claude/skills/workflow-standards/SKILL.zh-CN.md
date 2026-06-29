---
name: workflow-standards
description: >
  自定义命令（.claude/commands/）和技能（.claude/skills/）设计规范。
  在创建新命令、编写新技能、拆分大型技能、审查工作流架构时使用。
  触发场景："怎么设计命令"、"这个应该是命令还是技能"、"技能太大"、"工作流架构"。
---

# 工作流规范 — 命令与技能设计原则

这些原则定义了工作流系统的两个构建块：自定义命令（`.claude/commands/`）和技能（`.claude/skills/`）。划清边界是保持系统可维护的关键。

## 核心边界

| | 命令 (`.claude/commands/`) | 技能 (`.claude/skills/`) |
|---|---|---|
| **角色** | 流程编排器 — 控制步骤的执行顺序 | 能力提供者 — 编码专门知识 |
| **归属** | 一个工作流阶段（如 w-commit = COMMIT 阶段） | 一个领域概念（如 code-standards = 编码规则） |
| **调用方式** | 用户通过 `/command-name` 调用 | 由命令或 Agent 自动加载调用 |
| **规模** | 目标 ≤150 行 | 目标 ≤300 行 |

规模目标是**指导规范，而非硬性限制**。复杂工作流（如 `awf-run` 编排完整流水线）天然会超出。绝不能为了压缩行数而牺牲功能完整性和可读性。这个目标的作用是提醒"这里可能做太多了"——但如果范围内的确需要更多行，完全没有问题。

## 为什么需要边界

失去边界时，命令会变成混合编排逻辑和领域规则的"上帝对象"，技能则变成无调用的孤立知识。清晰的边界确保：

- **命令保持可读**：开发者不需过多滚动就能读完命令逻辑
- **技能保持聚焦**：每个技能是单个概念的独立知识单元
- **两者独立演进**：改变流程不改变规则，反之亦然

## 命令设计规则

### 1. 命令编排，技能执行

命令的职责是**决定下一步做什么**，而非编码领域规则。当某个步骤需要专业知识时，命令引用技能——不内联知识。

```markdown
✗ 坏 — 命令内联质量规则：
  1. 检查命名：函数用 camelCase，组件用 PascalCase...

✓ 好 — 命令委托给技能：
  1. 遵循 **code-standards** skill 检查代码质量
```

### 2. 命令有明确的单阶段范围

每个命令属于状态机的一个阶段（PLAN / DESIGN / CODE / DEBUG / REVIEW / TEST / COMMIT / FINISH / DOC）。跨阶段则拆分。

### 3. 命令定义"做什么"，不定义"怎么做"

描述步骤和顺序，把细节留给技能。每个步骤的描述控制在 1-3 行。

### 4. 命令规模：目标 ≤150 行

目标是 150 行以内。如果明显超出，考虑是否做得太多、能否提取专业知识到技能中。但复杂编排器（如 `awf-run`）天然需要更多行——不要为压缩行数而损失完整性和可读性。

### 5. 命令追求简洁

命令中每个部分都应有存在的必要。优先使用简短、直接的描述，避免冗长的解释。每个步骤保持在 1-3 行。避免重复：如果信息已在某个 skill 中，引用即可，不要复述。目标是开发者从头到尾读完命令后能理解整个流程，而不被细节淹没。

### 6. 命令结构模板

```markdown
# [命令名]

[一句话描述这个命令做什么]

## 参数
[入参方式]

## 前置 Skill 调用
[自动加载的 skill]

## 关联 Skill
[持续生效的 skill]

## 硬性规则（可选）
[不可违反的规则]

## 执行流程
[步骤序列 — 每步 1-3 行]

## 注意（可选）
[边界情况]
```

## 技能设计规则

### 1. 一个技能 = 一个概念

技能应封装单个概念的全部知识。`code-standards` 拥有编码相关的所有知识（命名、错误处理、函数设计）。`design-standards` 拥有系统架构相关的所有知识（组件设计、数据建模、状态管理）。

如果技能描述需要"和"或"或"来连接，说明它试图拥有两个概念。

### 2. 技能自包含、独立可用

技能应脱离上下文也成立。它不应假设是某个特定命令调用了它。这样命令可以自由组合技能。

### 3. 技能无状态

技能提供规则和原则，不管理工作流状态。技能不应知道当前任务、里程碑或阶段——这些属于命令和状态机。

### 4. 高内聚、低耦合

- **内聚**：技能内的一切都与其核心概念直接相关
- **耦合**：技能不应引用其他技能的细节（通过名称交叉引用没问题，如"遵循 code-standards"）

### 5. 技能规模：目标 ≤300 行

技能是详细参考文档，可以比命令长。目标是 300 行以内。如果超出此规模，考虑技能是否覆盖了过多概念、是否可拆分。但全面覆盖一个真正宽广的概念（如测试规范）的技能可能合理超出 300 行——功能完整性优先于行数。

### 6. 默认双语

每个技能必须同时提供英文和中文版本：

```
.claude/skills/<skill-name>/
├── SKILL.md            # 英文版 — 系统加载的规范版本（必须）
├── SKILL.zh-CN.md      # 中文版 — 给用户看的人工可读翻译（必须）
└── candidates.md       # 候选规则池（可选）
```

**英文是默认版本，中文是给人看的。** 英文 `SKILL.md` 是 Claude Code 加载和用于 skill 匹配的规范版本。中文 `SKILL.zh-CN.md` 是完整翻译，供用户查看和理解 skill 内容。两者必须保持同步——更新其中一个时，另一个也必须同步更新。

### 7. 技能 frontmatter

每个 SKILL.md 必须有 YAML frontmatter：

```yaml
---
name: skill-name
description: 一句话说明技能覆盖内容和触发时机
---
```

## 决策流程图

```
需要做什么？
  ├── 定义流程步骤顺序？ → COMMAND
  ├── 编码专业知识/规则？ → SKILL
  ├── 两者都需要？
  │     ├── 先创建 SKILL（编码知识）
  │     └── 再创建 COMMAND（编排流程，引用 SKILL）
  └── 不确定？
        └── 默认先做成 SKILL。命令可以后续补，技能可以独立使用。
```

## 现有命令与技能对照

| 命令 | 引用技能 | 阶段 |
|---------|--------------|-------|
| awf-run | awf-spec, design-standards, code-standards, quality-standards | 全流程 |
| w-plan | design-standards | PLAN |
| w-design | design-standards | DESIGN |
| w-dev | brainstorming, tdd, code-standards, design-standards | CODE |
| w-debug | systematic-debugging | DEBUG |
| w-review | requesting-code-review, code-standards, quality-standards | REVIEW |
| w-test | quality-standards | TEST |
| w-commit | verification-before-completion, quality-standards, version-management, git-flow, workflow-standards | COMMIT |
| w-finish | verification-before-completion, quality-standards | FINISH |
| w-doc | quality-standards | DOC |
| w-tree | design-standards | PLAN |
| w-ui | figma-use | CODE |
