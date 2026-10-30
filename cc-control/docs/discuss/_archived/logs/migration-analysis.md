# 旧项目资产迁移分析

> 对 `ai-workflow-claude`、`ai-workflow-framework`、`api-code` 三个旧项目的全面审计，
> 与 `cc-control` 现状交叉对比，识别值得融入的资产。

## 源项目概览

| 项目 | 性质 | 完成度 | 核心范式 |
|------|------|--------|----------|
| `api-code` | Node.js 脚本原型 | ~30% | SDK API 调用 + 4 阶段流水线 |
| `ai-workflow-claude` | 纯 Markdown 配置集 | ~60%（设计完成） | Agent 角色分工 + Hook 驱动 |
| `ai-workflow-framework` | npm 包 + CLI 工具 | ~20% | spawn 编排 + SDK 调用 双轨 |
| `cc-control`（当前） | Claude Code 插件 | 最成熟 | Phase 状态机 + Command/Skill 分离 |

## 演变路径

```
api-code ──→ ai-workflow-claude ──→ ai-workflow-framework ──→ cc-control（当前）
(原型)       (纯配置版)              (npm 包尝试)               (monorepo 重组)
```

三个旧项目的设计思路已被 cc-control 吸收并改进：
- 4 阶段流水线 → 7 状态状态机（PLAN→DESIGN→CODE→REVIEW→TEST→COMMIT→FINISH）
- Agent 角色分工 → Phase 导向命令（w-plan/w-dev/w-review/w-test/w-finish）
- spawn 编排 → awf-run 单 session 状态机

---

## 资产清单与融入建议

### 🔴 第一优先级 — cc-control 完全缺失

#### 1. 反幻觉 Skill

**来源**：`ai-workflow-claude/claude/skills/anti-hallucination.md` + `evidence-first.md`

**现状**：cc-control 所有 skill 都在教 AI 怎么做，没有一个教 AI 怎么不胡说。

**核心内容**：
- 输出前自查 5 问（证据是否可验证、结论是否有来源、是否存在更简单解释等）
- 高幻觉风险模式清单：
  - "已验证"却无具体验证步骤
  - "符合需求"却无需求文档引用
  - "兼容旧逻辑"却无对比测试
  - "通常做法"替代了"当前项目实际做法"
- 禁用措辞列表（"显然"、"已经确认"、"和文档一致"等无证据表述）
- 置信度分级：high（已验证事实）/ medium（外部搜索结果）/ low（经验推断）
- 证据不足时必须输出"无法确认"

**融入方式**：新建 `skills/anti-hallucination/SKILL.md` + `SKILL.zh-CN.md`

---

#### 2. 结构化 Acceptance Criteria 方法论

**来源**：`ai-workflow-claude/claude/skills/acceptance-criteria.md`

**现状**：cc-control 的 `quality-standards` 覆盖测试/审查/提交，但无可验证验收标准的定义方法。

**核心内容**：
- 验收条件必须是可观测、可验证的行为
- pass / fail / conditional-pass 三级判定
- 验证步骤与验收条件的映射关系
- 边界条件必须明确（输入边界、状态边界、并发边界）

**融入方式**：合并到 `quality-standards/SKILL.md`，新增 "验收标准" 章节

---

#### 3. 任务拆分 4 层模型

**来源**：`ai-workflow-claude/.claude/skills/task-splitting/SKILL.md`

**现状**：cc-control 的 `w-plan` 做 WBS 拆分，但缺少统一的层级标准和拆分合格条件。

**核心内容**：
- Stage → Task → Subtask → Commit 四级定义
- 每级的拆分合格标准：
  - Stage：独立里程碑，可阶段性交付
  - Task：单一能力域，一个 session 内可完成
  - Subtask：单一 AI 上下文单元，不可再拆
  - Commit：最小可追溯变更
- 版本号映射：V\<stage\>.\<task\>.\<subtask\>

**融入方式**：作为 `w-plan` 命令的拆分参考标准，或新建 `skills/task-splitting/`

---

#### 4. State 数据结构补充

**来源**：`api-code/.ai/tasks/active.yaml`

**现状**：cc-control 的 `awf-state.json` 有 milestones/tasks/WBS/currentState，但缺少设计意图和范围边界字段。

**缺失字段**：
```yaml
design_input:          # 为什么做、要达成什么
  why: ""
  goal: ""
  constraints: []
  mainline: ""

boundary:              # 做什么、不做什么
  in_scope: []
  out_of_scope: []     # ← 防止范围蠕变的关键
```

**融入方式**：扩展 `awf-state.json` schema，`w-plan` 输出时填充

---

#### 5. 可执行校验器概念

**来源**：`api-code/.ai/rules/validators.js`

**现状**：cc-control 的 `code-standards` 和 `quality-standards` 都是文本规则——AI 读完后自己判断。无硬门禁。

**核心思路**：
> 所有约束都应该是可执行代码，而不仅仅是文本建议

```javascript
// 不是"建议函数不超过20行"，而是硬检查
function validateCode(code) {
  const violations = []
  if (lines > 20) violations.push(...)
  if (/console\.log/.test(code)) violations.push(...)
  return violations
}
```

**融入方式**：作为 `w-review` 或 `w-finish` 的硬门禁阶段。AI 做软审查，脚本做硬检查。

---

### 🟡 第二优先级 — 补强已有资产

#### 6. 人机交接协议

**来源**：`ai-workflow-claude/claude/skills/human-handoff.md`

**现状**：cc-control 有 Issue 升级机制（`ISSUE_TEMPLATE.md`），但缺少结构化的等待报告模板。

**核心内容**：
- 已完成什么
- 阻塞原因
- 方案 A / 方案 B + 影响分析
- 人类应该检查什么
- 如何恢复

**融入方式**：合并到 `.claude/issues/ISSUE_TEMPLATE.md`

---

#### 7. 开发日志 Skill

**来源**：`ai-workflow-claude/.claude/skills/development-logbook/SKILL.md`

**现状**：cc-control 的 `w-finish` 只在里程碑结束时输出摘要，`w-doc` 的 dev log 模板较简单。

**核心内容**（11 个日志段）：
任务标识 → 前置检查 → 目标 → 实施计划 → 实际变更 → 测试结果 → 审查问题 → 修复记录 → 验收结论 → 提交/标签 → 总结

**融入方式**：补充到 `w-doc` 命令的 dev log 模板

---

#### 8. 禁止自动 Push 规则

**来源**：`ai-workflow-claude/.claude/skills/git-task-versioning/SKILL.md`

**现状**：`w-commit` 命令里写了"禁止自动 push"但只在一条命令里生效。`git-flow` skill 无此规则。

**融入方式**：提升到 `git-flow` skill 和 `.claude/settings.json` deny 列表

---

#### 9. 结构化 Handover 文件格式

**来源**：`api-code/.ai/handover/current.yaml`

**现状**：cc-control 的 `w-finish` 第 6 步有 handoff 输出，但无标准化格式。

**格式**：
```yaml
previous_task:
  id: T001
  outputs: ["输出1", "输出2"]
current_task:
  depends_on: ["输出1"]
```

**融入方式**：标准化 `w-finish` 的 handoff 输出，建立 milestone 间的可靠衔接

---

#### 10. 经验记忆模板

**来源**：`api-code/.ai/memory/experiences.md`

**现状**：cc-control 的 `w-finish` 第 5 步有 memory extraction，但无输出格式。

**模板**：
```
- 版本号
- 问题描述
- 根因
- 解决方案
- 建议
```

**融入方式**：直接作为 `w-finish` memory extraction 的输出格式

---

### 🟢 不需要迁移的

| 资产 | 来源 | 原因 |
|------|------|------|
| 7 个 Agent 定义（coordinator/developer/tester 等）| ai-workflow-claude | Phase 驱动 ≠ Role 驱动，范式不同 |
| 5 个角色命令（/plan /develop /audit /accept /log）| ai-workflow-claude | cc-control 的 phase 命令更成熟 |
| ai-bridge.js（Claude/OpenAI 统一调用层）| api-code | SDK 调用 ≠ Claude Code 插件，范式不同 |
| WorkflowEngine（spawn + HTTP 通知编排）| ai-workflow-framework | 已验证有 I/O 冲突和通知可靠性问题 |
| task-closure-spec.md（多 Agent 闭环规范）| ai-workflow-framework | 多 agent 模型，与 cc-control 单 session 状态机不同 |
| 架构设计文档（success-architecture 等）| ai-workflow-framework | 历史参考价值，不作为功能融入 |

---

## 融入执行计划

### Phase 1 — 补空白（本次）
- [ ] 新建 `skills/anti-hallucination/` — 反幻觉 + evidence-first
- [ ] 在 `quality-standards` 中新增验收标准章节
- [ ] 扩展 `w-plan` 任务拆分标准（4 层模型）
- [ ] 扩展 `awf-state.json` schema（design_input + boundary 字段）

### Phase 2 — 补强（后续）
- [ ] 合并 human-handoff 模板到 `ISSUE_TEMPLATE.md`
- [ ] 补充 `w-doc` dev log 格式（11 段日志模型）
- [ ] 将禁止 push 规则写入 `git-flow` skill 和 `settings.json`
- [ ] 标准化 `w-finish` handoff 输出格式
- [ ] 标准化 `w-finish` memory extraction 模板

### Phase 3 — 长期探索
- [ ] 可执行校验器集成到 `w-review` 硬门禁阶段
- [ ] 评估是否引入 AI Bridge 双模型调用模式
