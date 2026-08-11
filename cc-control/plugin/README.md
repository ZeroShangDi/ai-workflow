# Profiles — 领域配置骨架

## 三层模型（道法术）

```
principles/  → 原则、理念、核心思想      → 定方向（WHY）
commands/    → 方法、流程、框架          → 定框架（WHAT）
skills/      → 技能、技巧、执行细节      → 定执行（HOW）
```

| 层 | 作用域 | Plan 阶段 | Run 阶段 |
|------|-------|-----------|----------|
| **principles** | 贯穿全程 | 指导发现维度、验收标准 | 约束 AI 行为底线 |
| **commands** | Phase 级 | 定义规划方法论 | 定义阶段链 + phase 对应关系 |
| **skills** | Task 级 | 指导任务拆解 + prompt 质量 | 指导每个 phase 的具体执行 |

## 目录结构

```
plugin/
├── shared/                     # 跨领域引擎代码
│   ├── plan-executor.js.stub   # Plan 主引擎
│   ├── step-runner.js.stub     # 通用步骤执行器
│   └── validator.js.stub       # 产出校验
├── software-dev/               # 软件开发 profile
│   ├── profile.json            # 元配置：绑定三层 + phaseChain + 维度 + 门禁
│   ├── principles/             # 道：原则/理念
│   ├── commands/               # 法：方法/commands
│   └── skills/                 # 术：技能/skills
└── novel-writing/              # 小说创作 profile
    ├── profile.json
    ├── principles/
    ├── commands/
    └── skills/
```

## init 注入

`awf init --profile software-dev` 渲染 .claude/settings.json：
```json
{
  "extraSkillsDir": [
    "<pkg>/plugin/software-dev/skills/"
  ],
  "extraCommandsDir": [
    "<pkg>/plugin/software-dev/commands/"
  ]
}
```

principles 不直接注入 CC（不是 command 也不是 skill），而是由引擎在 prompt 中按需引用。
