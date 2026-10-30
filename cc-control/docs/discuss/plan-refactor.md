# Plan 重构方案讨论

> 讨论日期：2026-08-04
> 目标：重构 Plan 流程，提升稳定性、可扩展性，支持多领域工作流

---

## 1. 背景

当前 Plan 实现为一个 `/w-plan` Markdown 命令 + `plan.js` spawn `claude -p` 自由会话。存在以下问题：

- Q&A 阶段无结构约束，AI 可能遗漏关键维度
- 复杂度判断靠关键词匹配，误判率高
- WBS 和 tasks 在一步产出，粒度失控
- prompt 一次性写完不校验
- 缺乏自动门禁任务
- 领域硬编码，无法支持非软件工作流
- AI 可能偏离流程

## 2. 核心设计决策

### 2.1 领域 Profile 抽象

在 state.json 中增加 `profile` 字段，指向 profiles 目录下的领域配置：

```json
{
  "profile": "software-dev",
  "profiles": {
    "software-dev": {
      "name": "软件开发",
      "complexityLevels": ["simple", "medium", "complex"],
      "phases": { ... },
      "gateTasks": [ ... ]
    },
    "novel-writing": {
      "name": "小说创作",
      "complexityLevels": ["chapter", "arc", "volume"],
      "phases": { ... },
      "gateTasks": [ ... ]
    }
  }
}
```

切换领域只需换 profile，Plan 引擎不关心具体内容。

### 2.2 两阶段 Plan

```
Phase A: 理解（确保做对的事）
  → 边界确认 → 场景分析 → 约束收集 → 验收标准 → 复杂定级
  → 产出：需求文档 + WBS 树
  → 门禁：WBS 完整性校验

Phase B: 执行规划（确保把事做对）
  → WBS → tasks 映射 → prompt 生成 + 校验 → 插入门禁 → 依赖排序
  → 产出：tasks 写入 state.json
  → 门禁：依赖链校验 + prompt 质量审查
```

### 2.3 Plan 的 CLI 驱动模式（混合模式）

Plan 不是自由会话，也不是完全僵硬的流水线，而是混合：

- **发现阶段**：AI 拿到覆盖清单（4 个维度 + 最低要求），自由提问/探索代码/回退修正，覆盖完成 → CLI 验证通过 → 进入产出阶段
- **产出阶段**：刚性流水线，每步一个 prompt，CLI 验证产出后进入下一步
- CLI 通过 session server + `/send` 驱动，和 `awf run` 同机制

### 2.4 项目隔离

- 所有 awf 能力（skills、commands、MCP）通过 settings.json 和 .mcp.json 引用，指向 npm 包绝对路径
- 零复制、零全局污染
- `awf init` 渲染这些配置

### 2.5 门禁任务

Profile 定义触发点，Plan 引擎自动插入：

| 触发点 | 门禁任务 |
|--------|---------|
| after-wbs | WBS 完整性校验 |
| after-tasks | 依赖链拓扑校验 |
| before-run | Task prompt 质量审查 |
| after-milestone | 交付物完整性检查 |

## 3. 状态

- 方案已讨论确认
- 待实现：Plan 重构（P0 优先）
- 后续：Profiles 体系、run 阶段读取 profile
