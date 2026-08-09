---
name: awf-skill
description: >
  Skill 生命周期管理 — 创建、修改、聚合、拆分、审计。
  触发条件：用户要求"创建 skill"、"管理 skills"、"审计 skills"、或新 skill 即将创建时。
  引用方：sys-rule-workflow
---

# Skill 管理

管理 skills/ 下所有 skill 的完整生命周期。

---

## 命名规则

### 三段式命名

```
{level}-{role}-{scope}

level:  sys    系统架构层 — 状态机、模块划分、数据结构
        flow   工作流程层 — 开发/审查/测试/提交/调试 阶段链条
        code   代码实践层 — 函数、命名、风格、组件设计

role:   spec   规范定义 — 描述一个东西是什么、怎么设计
        rule   行为规则 — 约束怎么做才对
        exec   执行工具 — 生成、转换、操作

scope:  具体的领域名称
```

### 命名检查清单

| 检查项 | 规则 |
|--------|------|
| level | 必须是 sys / flow / code 之一 |
| role | 必须是 spec / rule / exec 之一 |
| scope | 一个英文单词，不用缩写 |
| 唯一性 | 同格子内不能有两个 skill |

---

## 体积规则

| 规则 | 限制 |
|------|------|
| 单文件上限 | SKILL.md ≤ 300 行 |
| 超出时 | 拆分 → 精简 → 外迁（按此顺序处理） |

---

## 边界规则

- 两个 skill 不能说同一件事
- 同一个格子已有 skill，必须合并到已有 skill
- 不确定是否重叠时，先对比 description 和 scope

---

## 文件结构

```
skills/{name}/
├── SKILL.md          # 英文版（必须）
└── SKILL.zh-CN.md    # 中文版（必须）
```

## SKILL.md 模板

```markdown
---
name: {level}-{role}-{scope}
description: >
  [一句话说明这个 skill 做什么]
  [触发条件：什么时候自动加载]
  [引用方：被哪些命令使用]
---

# [标题]

[内容：核心定义 → 具体规则/流程 → 示例 → 边界和注意事项]
```

---

## 生命周期

| 状态 | 条件 | 操作 |
|------|------|------|
| 活跃 | 被引用 | 保持 |
| 待清理 | 连续多月未触发 | 确认后删除 |
| 已废弃 | 功能已被覆盖 | 删除 |
