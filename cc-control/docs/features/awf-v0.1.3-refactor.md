# ai-workflow v0.1.3 架构重构 需求文档

## 背景与目标

当前 v0.1.x 的核心问题是**能力与规则的边界模糊**——工作流决策逻辑硬编码在 `run.js` 中，改一处牵全身。

v0.1.3 四个目标：

| # | 目标 | 说明 |
|---|------|------|
| 1 | **解耦** | 工具层只提供能力，编排层集中管理所有决策逻辑 |
| 2 | **前置** | 工作流决策从 run 前移到 plan——plan 产出完整 task 列表（含门禁），run 只顺序执行 |
| 3 | **可配置** | 任务级别体系、门禁规则、工作流 profile 可替换 |
| 4 | **可观测** | 完整运行日志、token 记录、健康检测 |

### 核心架构变更

```
v0.1.x（现状）:
  plan → 产出 tasks（扁平列表，无门禁）
  run  → 遍历 tasks
         → resolvePhases() 运行时决策阶段链 ←── 逻辑硬编码
         → executePhase()  执行
         → MCP follow-up   硬编码

v0.1.3（目标）:
  plan → WBS 树（层级结构）
       → 后序遍历 + 门禁插入 → 产出扁平 task 列表（含 gate task）
       → 预生成所有 prompt
  run  → 遍历 tasks（纯迭代器，不决策）
       → 执行 task.prompt
       → 遇 gate task 执行对应门禁
       → 异常重试 → 暂停
```

---

## 用户场景

### 场景 1：开发者用 awf 驱动功能开发

```
awf init                              → 初始化 .awf/ + 生成/注入 CLAUDE.md
awf plan "添加用户认证系统"            → Q&A 对齐 → WBS 树 → 后序遍历插入门禁
                                      → 产出 tasks + 预生成 prompt
awf run                               → 顺序执行 tasks，遇门禁自动 REVIEW/TEST/COMMIT
                                      → 异常自动重试，仍失败暂停
```

### 场景 2：awf run 过程中手动调用 slash command

```
用户: /ai-workflow:w-review
  → 检测 awf run 模式（MCP 存活 + .awf/ 标记）
  → 自动关联当前 task，结果写 state.json，不问多余问题

用户（无 awf run）: /ai-workflow:w-review
  → 正常交互模式，反问审查范围
```

### 场景 3：换领域使用

```
awf init --profile novel-writing      → 门禁：章节→REVIEW，卷→PUBLISH
                                      → 阶段：DRAFT→REVIEW→PUBLISH（无 COMMIT）
awf plan "创作玄幻小说"               → 按 profile 的 WBS 模板拆分
awf run                               → 按 profile 的阶段链执行
```

---

## 功能范围（6 期）

### Phase 1：工作流解耦（地基）

**目标**：代码重组，外部行为不变。

- 将 `run.js` 中的决策逻辑（resolvePhases、门禁规则、prompt 策略）从执行逻辑中分离
- 定义模块边界：
  ```
  engine/      ← 执行引擎（task 迭代、phase 执行、状态轮询）
  profile/     ← 规则配置（level 定义、gate 映射、phase chain）
  tools/       ← 能力提供（MCP servers、session、tmux）——基本不动
  ```
- profile 目录结构：
  ```
  profile/
  ├── programming/          ← 默认编程 profile
  │   ├── levels.yaml       ← 级别定义 + 门禁映射
  │   ├── phases.yaml       ← 阶段定义 + 阶段链
  │   └── prompts/          ← 各阶段 prompt 模板
  └── novel-writing/        ← 未来：小说创作 profile
  ```
- **不包含**：profile 切换机制（只保留一个 programming profile）、WBS 树后序遍历（plan 行为暂不变）

### Phase 2：Run 阶段重构

**目标**：run 从「决策+执行」退化为「纯执行」。

- `run.js` 变成 task 迭代器：按 `state.json` 中的 task 列表顺序执行，不自行决策阶段链
- **Gate task**（`type: "gate"`）：
  - plan 阶段插入到 task 列表中的特殊 task
  - 包含字段：`gateType`（REVIEW/TEST/COMMIT/DOCS）、`scope`（门禁覆盖的 task id 列表）
  - run 遇到 gate task 时：发送对应 phase 的 prompt 到 tmux → 等待完成 → 继续下一个
- 异常处理：
  - task 执行失败 → 自动重试（默认 2 次）
  - 重试仍失败 → 标记 task 为 `blocked`，暂停 run，等待人工介入
  - 后续 phase 增加通知工具（本期不做）
- MCP follow-up 统一由 gate task 的 prompt 驱动，不再硬编码在 run.js

### Phase 3：Plan 阶段重构

**目标**：plan 产出完整可执行的 task 列表。

#### 3a. WBS 树结构

扩展现有 WBS schema，增加层级：

```json
{
  "id": "W1",
  "name": "用户认证系统",
  "desc": "...",
  "level": "requirement",
  "parent": null,
  "children": ["W1.1", "W1.2"],
  "acceptance": "...",
  "deps": []
}
```

**Level 体系**（9 级定义，当前启用 5 级）：

| Level | 含义 | 门禁行为 | 状态 |
|-------|------|---------|------|
| `atomic` | 原子操作 | 无 | 定义预留 |
| `task` | 模型一次可完成的单元 | 无 | 叶子节点 |
| `function` | 功能 | 无（其子 task 完成即可） | 中间节点 |
| `module` | 模块 | REVIEW | 触发 REVIEW gate |
| `requirement` | 需求 | REVIEW + TEST + COMMIT + DOCS | 触发完整门禁 |
| `milestone` | 里程碑 | 集成验证 + CHANGELOG | 本期暂不做 |
| `project` | 项目 | 汇总归档 | 本期不做 |
| `system` | 系统 | 架构评审 | 本期不做 |
| `ecosystem` | 生态 | 合规审查 | 本期不做 |

门禁规则在 profile 中配置，可调整。

#### 3b. 后序遍历 + 门禁插入

```
算法：
  function flattenWBS(wbsNode, tasks):
    1. 对每个 child，递归调用 flattenWBS(child, tasks)
    2. 如果当前节点是叶子（level == 'task'）：
       → 生成一个 DEV task，加入 tasks
    3. 如果当前节点有门禁（level 对应的 gateRules 非空）：
       → 为每个 gateRule 生成一个 type='gate' 的 task，scope=该节点的所有子孙 task
       → 按门禁顺序加入 tasks
    4. 返回 tasks

示例：
  W1（需求级：REVIEW→TEST→COMMIT→DOCS）
  ├── W1.1（模块级：REVIEW）
  │   ├── T1（任务级）
  │   └── T2（任务级）
  └── W1.2（模块级：REVIEW）
      ├── T3（任务级）
      └── T4（任务级）

  后序遍历产出 task 列表：
    T1(DEV) → T2(DEV) → GATE(W1.1 REVIEW) → T3(DEV) → T4(DEV)
    → GATE(W1.2 REVIEW) → GATE(W1 TEST) → GATE(W1 COMMIT) → GATE(W1 DOCS)
```

#### 3c. Prompt 预生成

- plan 阶段 AI（plan 运行的 CC 实例）为每个 task 的每个阶段生成完整 prompt
- DEV task：生成 `prompt` 字段（开发指令）
- GATE task：生成 `prompt` 字段（门禁执行指令，如 "审查 W1.1 下所有 task 的代码变更"）
- 首次解耦尽量保持现有 prompt 生成逻辑不变——DEV 仍用 task.desc 直接作为 prompt，gate task 的 prompt 由 profile 中的模板拼装
- Prompt 存储在 task 文件中（.awf/tasks/<task-id>.json）

#### 3d. State 拆分

```
Before（v0.1.x）:
  .awf/state.json    ← 一个大文件，包含所有内容

After（v0.1.3）:
  .awf/
  ├── state.json              ← 总纲：currentState、version、milestones、plan 元数据
  ├── wbs.json                ← WBS 树（独立文件，因为内容多、增量变化）
  └── tasks/
      ├── T1.json             ← task 详情（id、desc、prompt、status、exec、commits）
      ├── T2.json
      └── ...
```

**state.json（总纲）**：
```json
{
  "currentState": "CODE",
  "version": "0.2.0",
  "lastUpdated": "...",
  "plan": {
    "summary": "...",
    "reqDoc": "docs/...",
    "taskOrder": ["T1", "T2", "G1", "T3", "T4", "G2", "G3"],
    "wbsFile": ".awf/wbs.json"
  },
  "milestones": [...]
}
```

**wbs.json**：
```json
{
  "tree": {
    "id": "W1",
    "name": "...",
    "level": "requirement",
    "children": [
      { "id": "W1.1", "level": "module", "children": [...] }
    ]
  },
  "flatMap": {
    "W1": {...},
    "W1.1": {...}
  }
}
```

**tasks/<task-id>.json**：
```json
{
  "id": "T1",
  "type": "dev",
  "desc": "...",
  "prompt": "...",
  "status": "pending",
  "deps": [],
  "wbsRef": "W1.1",
  "level": "task",
  "exec": { "result": null, "files": [] },
  "commits": []
}
```

### Phase 4：命令双模式 + No-Arg

#### 4a. 双模式检测

```
检测逻辑（每个 slash command 启动时）：
  1. 调用 awf-state MCP 的 awf_read_state 或其他轻量工具
  2. 检查 .awf/ 目录是否存在
  3. 两者都满足 → awf-run 模式
  4. 否则 → 正常模式
```

#### 4b. 模式差异

| 行为 | awf-run 模式 | 正常模式 |
|------|-------------|---------|
| state.json | 自动读写，通过 MCP 更新 | 不触碰 |
| 交互风格 | 自主执行，少问问题 | 交互式，多确认 |
| 参数 | 从 state.json 获取上下文（当前 task 等） | 从用户输入获取 |
| 结果 | 写入 state.json | 仅输出给用户 |

核心差异就是：**是否感知并操作 state.json**。

#### 4c. No-Arg 支持

除 dev 以外的命令，无参数时根据上下文推算默认行为：

| 命令 | 无参数行为 |
|------|-----------|
| `/w-review` | 审查当前活跃 task 的 exec.files，无活跃 task 则审查所有未提交变更 |
| `/w-test` | 对当前活跃 task 关联的模块执行测试 |
| `/w-doc` | 为当前活跃 task 的 wbsRef 模块更新文档 |
| `/w-commit` | 提交当前 task 的变更，自动生成 conventional commit message |
| `/w-debug` | 读取上一个失败 task 的错误信息，启动排查 |
| `/w-finish` | 执行所有收尾项 |
| `/w-plan` | 进入交互式需求对齐（现有行为） |
| `/w-tree` | 读取 state.json 中的 WBS 生成可视化树 |
| `/w-design` | 读取 state.json 中 plan.hasUI 决定是否进入设计流程 |

### Phase 5：Init CLAUDE.md

```
awf init 流程增强：

1. 检查项目根目录 CLAUDE.md 是否存在
   ├── 存在 → 检查是否已有 awf 注入标记（如 <!-- awf-rules -->）
   │         ├── 有 → 跳过
   │         └── 无 → 追加注入内容
   └── 不存在 → 执行 claude /init 生成基础 CLAUDE.md → 追加注入内容

2. 注入内容源：cc-control/templates/awf-rules.md
   （独立文件，方便后续调整注入内容）

3. 注入方式：直接 copy 内容追加到项目 CLAUDE.md 末尾，
   以 <!-- awf-rules start --> / <!-- awf-rules end --> 包裹
```

### Phase 6：日志 + 稳定性

#### 6a. 运行日志

- 按 session 记录：`.awf/logs/<session-id>/`
- 每个 task 执行记录：
  ```
  .awf/logs/<session-id>/
  ├── session.json        ← session 元数据（开始时间、task 列表、总 token）
  ├── T1/
  │   ├── request.md      ← 发送给 AI 的完整 prompt
  │   └── response.md     ← AI 返回内容（优先白字，否则全量）
  └── ...
  ```
- 模型返回过滤：优先只保留白字（用户可见文本），工具调用等系统输出不存。如果技术上无法区分，全量存储

#### 6b. Token 记录

- 每次 AI 调用记录估算 token 数
- Dashboard 展示累计消耗
- 不做硬限制，仅记录 + 展示（重要不紧急）

#### 6c. 文档边界

| 位置 | 内容 | Git |
|------|------|-----|
| `.awf/` | 运行时产物：state、wbs、tasks、logs、issues、bugs、review report、test report、commit report | 不追踪 |
| `docs/` | 人读产出：需求文档、测试用例、设计文档、架构设计、技术选型、开发指南、运维手册等 | 追踪 |

---

## 排除项（本期不做）

- **测评体系**：独立子项目，涵盖 AI 表现评分 + 硬流程健康检测
- **通知/双向接管工具**：异常时通知用户并允许远程接管
- **文档可选清单**：plan 阶段可选择产出哪些文档模板
- **项目/系统/生态级门禁**：暂定到里程碑级
- **多 task 并行执行**：task 列表仍然严格顺序执行
- **Token 硬管控**：仅记录展示，不做预算限制

## 后续版本预留

- `task.conversation` 字段（多轮对话历史）
- `task.parallel` 字段（并行执行标记）
- profile 市场/共享机制
- 测评框架

---

## 验收标准

- [ ] `awf init` 自动生成/注入 CLAUDE.md（含 awf 规则，`<!-- awf-rules -->` 包裹）
- [ ] `awf plan` 产出 WBS 树 → 后序遍历 → 含 gate task 的扁平列表 + 预生成 prompt
- [ ] `awf run` 纯顺序执行，不包含 resolvePhases 等决策逻辑
- [ ] gate task（type='gate'）正确触发 REVIEW/TEST/COMMIT/DOCS
- [ ] state.json 拆分为总纲 + wbs.json + .awf/tasks/*.json
- [ ] engine/ profile/ tools/ 三层目录边界清晰
- [ ] 所有 slash command 检测 awf-run 模式并切换行为（自主 vs 交互）
- [ ] 非 dev 命令无参数时根据上下文推算默认行为
- [ ] 异常自动重试 2 次后暂停，不丢失状态
- [ ] .awf/logs/<session-id>/ 记录 prompt + 模型返回
- [ ] Dashboard 展示 token 累计消耗
- [ ] 现有功能无回归（awf init → plan → run 核心流程）
