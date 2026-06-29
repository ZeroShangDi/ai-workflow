---
name: workflow-standards
description: >
  Design standards for Claude Code custom commands (.claude/commands/) and skills (.claude/skills/).
  Use when creating new slash commands, writing new skills, splitting large skills, or reviewing
  workflow architecture. Trigger when the user asks about "how to design a command", "should this be
  a command or a skill", "skill too large", or "workflow architecture".
---

# Workflow Standards — Designing Commands and Skills

These principles govern how we design the two building blocks of our workflow system: custom commands (`.claude/commands/`) and skills (`.claude/skills/`). Getting this boundary right keeps the system maintainable as it grows.

## The Boundary

| | Command (`.claude/commands/`) | Skill (`.claude/skills/`) |
|---|---|---|
| **Role** | Flow orchestrator — controls the sequence of steps | Capability provider — encodes specialized knowledge |
| **Owner** | One workflow phase (e.g., w-commit = COMMIT phase) | One domain concept (e.g., code-standards = coding rules) |
| **Reuse** | Called by users via `/command-name` | Called by commands or agents automatically |
| **Size** | Target ≤150 lines | Target ≤300 lines |

The size targets are **guidelines, not hard limits**. Complex workflows (e.g., `awf-run` orchestrating the entire pipeline) naturally run longer. Never sacrifice functional completeness or clarity just to hit a line count. The target exists to flag "this might be doing too much" — but if the scope genuinely requires more lines, that's fine.

## Why This Boundary Matters

Commands without a skill backing them become god-objects that mix orchestration decisions with domain rules. Skills without a command become orphaned knowledge that nothing invokes. The boundary ensures:

- **Commands stay readable**: a developer can read a command's full logic without excessive scrolling
- **Skills stay focused**: each skill is a self-contained knowledge unit about one concept
- **Both evolve independently**: changing *how* the workflow flows doesn't require changing *what* the rules are, and vice versa

## Command Design Rules

### 1. Commands orchestrate, skills execute

A command's job is to **decide what happens next**, not to encode domain rules. When a step needs specialized knowledge, the command invokes the skill — it doesn't inline the knowledge.

```markdown
✗ BAD — command inlines quality rules:
  1. 检查命名是否符合规范：函数用 camelCase，组件用 PascalCase...

✓ GOOD — command delegates to skill:
  1. 遵循 **code-standards** skill 检查代码质量
```

### 2. Commands have a clear single-phase scope

Each command belongs to one phase of the state machine (PLAN / DESIGN / CODE / DEBUG / REVIEW / TEST / COMMIT / FINISH / DOC). If a command spans multiple phases, split it.

### 3. Commands define the "what", not the "how"

Describe what steps to take and in what order. Leave the detailed "how" to skills. A command's step descriptions should be 1-3 lines each.

### 4. Command size: target ≤150 lines

Target 150 lines or fewer. If a command significantly exceeds this, consider whether it's doing too much and whether specialized knowledge can be extracted into a skill. However, complex orchestrators (like `awf-run`) will naturally run longer — do not compress at the expense of completeness or readability.

### 5. Command structure template

```markdown
# [命令名]

[一句话描述这个命令做什么]

## 参数
[如何传递参数]

## 前置 Skill 调用
[哪些 skill 由系统自动加载]

## 关联 Skill
[哪些 skill 在流程中持续生效]

## 硬性规则（可选）
[绝对不能违反的规则]

## 执行流程
[步骤序列 — 每个步骤 1-3 行]

## 注意（可选）
[边界情况和约束]
```

## Skill Design Rules

### 1. Skills own one concept completely

A skill should encapsulate all knowledge about a single concept. `code-standards` owns everything about writing code — naming, error handling, function design. `design-standards` owns everything about system architecture — component design, data modeling, state management.

If a skill's description needs "and" or "or", it's trying to own two concepts.

### 2. Skills are self-contained and independently usable

A skill should make sense when read alone. It should not assume a specific command called it. This allows commands to mix and match skills freely.

### 3. Skills are stateless

Skills provide rules and principles, not workflow state. A skill doesn't know about the current task, milestone, or phase — that belongs to commands and the state machine.

### 4. High cohesion, low coupling

- **Cohesion**: everything inside a skill relates directly to its concept
- **Coupling**: a skill should not reference details of another skill (cross-references by name are fine, e.g., "follow code-standards")

### 5. Skill size: target ≤300 lines

Skills are detailed reference documents, naturally longer than commands. Target 300 lines or fewer. Beyond this, consider whether the skill is covering too many concepts and could be split. But a skill that comprehensively covers a genuinely broad concept (like a testing standard) may legitimately exceed 300 — functional completeness takes priority over line count.

### 6. Skill file structure

```
.claude/skills/<skill-name>/
├── SKILL.md            # 英文版（必须）
├── SKILL.zh-CN.md      # 中文版（必须）
└── candidates.md       # 候选规则池（可选，如 code-patterns）
```

### 7. Skill frontmatter

Every SKILL.md must have YAML frontmatter:

```yaml
---
name: skill-name
description: One-line summary of what this skill covers and when to invoke it
---
```

## Decision Flowchart

When creating a new workflow capability, decide where it belongs:

```
需要做什么？
  ├── 定义一个流程步骤的顺序？ → COMMAND
  ├── 编码专用知识/规则？ → SKILL
  ├── 两者都需要？
  │     ├── 先创建 SKILL（编码知识）
  │     └── 再创建 COMMAND（编排流程，引用 SKILL）
  └── 不确定？
        └── 默认先做成 SKILL。命令可以后续再建，技能可以独立使用。
```

## Existing Commands and Skills Snapshot

When creating new capabilities, check this snapshot to avoid placing knowledge in the wrong bucket:

| Command | Skill(s) Used | Phase |
|---------|--------------|-------|
| awf-run | design-standards, code-standards, quality-standards | 全流程 |
| w-plan | design-standards | PLAN |
| w-design | design-standards | DESIGN |
| w-dev | brainstorming, tdd, code-standards, design-standards | CODE |
| w-debug | systematic-debugging | DEBUG |
| w-review | requesting-code-review, code-standards, quality-standards | REVIEW |
| w-test | quality-standards | TEST |
| w-commit | verification-before-completion, quality-standards, workflow-standards | COMMIT |
| w-finish | verification-before-completion, quality-standards | FINISH |
| w-doc | quality-standards | DOC |
| w-tree | design-standards | PLAN |
| w-ui | figma-use | CODE |
