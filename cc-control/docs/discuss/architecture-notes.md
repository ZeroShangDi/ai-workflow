# 架构笔记

> 记录架构讨论、技术决策、外部工具调研等，随代码一起演进。

---

## 与 Tmux-AI-Team / Loop Orchestrator 的对比分析（2026-07-17）

### 调研背景

调研了 tmux + AI Agent 编排领域的三个代表性工具：

| 工具 | 实现 | 模型 |
|------|------|------|
| **Tmux-AI-Team** | 100% Shell | 角色驱动（PM + Dev + QA） |
| **Loop Orchestrator** | TypeScript/Node.js | 27 个 SME 角色 + git worktree 隔离 |
| **NTM** | Go | tmux 控制面板 + 安全审批层 |

### awf 的当前定位

awf 现阶段走**单 Agent 阶段驱动**模型（PLAN → DESIGN → CODE → REVIEW → TEST → COMMIT → FINISH），但这不代表架构哲学上否定多 Agent。选择单 Agent 先跑通闭环是务实的工程决策：

> **补注（2026-08-27）**：多 Agent 已实现——`awf run` 支持滑动窗口并行执行（单 tmux + 原生子 Agent + CLI 中央调度），调度路线从最初的**批次屏障**修正为**滑动窗口**。单 Agent 仍是默认形态（`run.agents` 默认 `max: 1` = 零变化）。详见「多 Agent 滑动窗口决策（2026-08）」。

- 单 Agent 多轮对话保留完整上下文，REVIEW 阶段能回溯 DEV 阶段的决策过程
- 通过 Hook（`SessionStart`/`Stop`）+ tmux-http 注入按键，实现持久会话的状态感知
- 通过 `/w-prompt` 的 one-shot 智能提示词生成，每一阶段可以重新聚焦注意力

### 多 Agent 路线的设计原则

> **状态（2026-08-27）**：本条为早期设想，已被实现部分推翻/修正——见「多 Agent 滑动窗口决策（2026-08）」。

引入多 Agent 时曾设想遵守以下约束：

1. **并行任务必须无关联** — 有依赖的任务并行会导致协调复杂度快速攀升，且需要 Agent 之间共享上下文，这恰是多 Agent 模型最不可靠的部分。✅ **已保留**：滑动窗口按 deps 门禁图 + `plannedFiles` 冲突过滤，保证并行任务互不关联
2. **调度 Agent + 多 tmux session** — 并行时多开 tmux session，而非在一个 session 内多 pane 共享上下文。❌ **未采用**：改为单 tmux + 原生子 Agent 并发（方案 C，CLI 中央调度）
3. **git worktree 隔离** — 借鉴 Loop Orchestrator 的做法，每个并行 Agent 在自己的 worktree + branch 上工作，完成后通过 review gate 合并，避免工作区冲突。❌ **未采用**：改为 `plannedFiles` 文件集冲突过滤，冲突任务串行化

### 值得借鉴的外部设计

| 特性 | 来源 | 说明 |
|------|------|------|
| **测试文件 hash 防作弊** | Loop Orchestrator | 在每个任务前后对测试文件做 hash，如果 Agent 修改了测试代码来让不完整的实现通过，可以被检测到。在 REVIEW/TEST 阶段引入 |
| **自调度机制** | Tmux-AI-Team | 使用 `at` 命令让 Agent 在等待外部条件时主动挂起并定时唤醒。awf 目前借助 Hook + 提示词生成已经可以实现连续运行，但缺少"等待一段时间再继续"的显式调度能力 |
| **回归门禁** | Loop Orchestrator | HEAD 快照 + 任务前后测试对比，绿色变红色自动 revert |
| **安全审批层** | NTM | allowed / blocked / approval-gated 三级权限 + 可审计的审批记录，对有 human-in-the-loop 需求的生产环境操作有价值 |

### awf 的差异化优势

以下能力是 tmux AI Agent 生态中其他工具不具备的：

1. **全生命周期覆盖** — 从需求对齐（交互式 Q&A）→ UI 设计（三选一 + Figma 双向）→ 开发 → 审查 → 测试 → 提交 → 里程碑收尾，而非仅覆盖编码环节
2. **方法论内置** — 16 个命令 + 31 个 skill（双插件：core 4 命令 + 7 skill，plugin-code 12 命令 + 24 skill）不只是工具，是一套可复现的开发方法论（721 测试金字塔、约定式提交、WBS 分解、Issue 升级机制）
3. **Figma 双向集成** — `w-ui-design` 和 `w-ui-code` 打通设计到代码的自动化链路
4. **PC 控制层** — VM 控制（Parallels Desktop）+ 浏览器自动化，可操控完整桌面环境
5. **中英双语** — 命令和 skill 同时支持中文和英文

### 关于安装简便性

最终用户形态是标准的 npm 工作流：

```bash
npm install -g awf
awf init
awf plan "build feature X"
awf run
```

tmux、HTTP server、plugin 配置等基础设施对用户透明，体验上不逊于 Tmux-AI-Team 的 `source bashrc` 方式，且 npm 分发更标准化。

---

## 多 Agent 滑动窗口决策（2026-08）

> 参考：[multi-agent-mode.md](multi-agent-mode.md)（方案 C 定稿）、[multi-agent-sliding-window.md](multi-agent-sliding-window.md)（滑动窗口定稿 + 实证记录）、`plugin/core/agents/awf-worker.md`（执行单元身份）。

### 决策路径

1. **方案 C 定稿（2026-08-26）** — 多 Agent 实现方案三选一，最终定稿 **C = 单 tmux + 原生子 Agent + CLI 中央调度**：保留单会话、低基础设施改动，同时 DAG / 门禁 / 配额 / 并发策略全部由 CLI 决定。**关键澄清：「调用原生子 Agent」≠「调度权交给 AI」**——子 Agent 只是执行载体，调度权仍在 CLI。
2. **批次屏障被用户否定（2026-08-26）** — 第一版调度用批次屏障（整批结束才下一批），用户明确否定，期望**滑动窗口**（动态补位、维持满并发；配额是硬上限而非目标）。
3. **滑动窗口定稿（2026-08-27，实证 + 全真 eval 验证）** — inbox socket 派发 + runScheduler 就绪池 / 配额 / plannedFiles 冲突 + SubagentStop 落账 + M5 决策上抛。

### 关键设计

- **CLI 拥有调度权** — 主 Agent 不负责滑动窗口；CLI 只通知主 Agent「生成子 Agent」（经 inbox socket 注入派生指令），就绪池 + 配额 + 补位循环都在 CLI（`src/cli/scheduler.js` / `run-batch.js`），完成后即时补位。
- **子 Agent 禁写 state** — awf-worker 身份硬约束：只调 `awf_read_state` 读上下文，绝不允许调用任何写工具；state.json 由主会话 / CLI 更新。
- **落账原子化** — awf-state 新增 `awf_task_complete`（一次提交 status+result+files+commits），CLI / MCP 共用 `.awf/state.lock` 文件锁，防并发写丢更新。
- **完成感知** — 子 Agent 结束输出固定格式 `RESULT: {...}`，`SubagentStop` hook 解析 `last_assistant_message` 落账；解析失败走补发安全网（主 Agent SendMessage 恢复子 Agent 补齐字段）。
- **M5 决策上抛** — 子 Agent 遇需决策输出 `NEEDS_INPUT: {...}` 上抛主 Agent，主 Agent 统一 `AskUserQuestion` / `awf_await_choice|input` 问用户，子 Agent 不直接提问。
- **派发通道** — inbox socket（官方 messaging 通道）注入派生指令；socket 内部开关实证失效，当前降级 tmux `/send` 补位。

---

## 阶段内上下文管理：自动 Checkpoint 与主动压缩（2026-07-17）

### 问题

awf 的阶段间上下文边界已经被 Hook + `/w-prompt` one-shot 重新生成 prompt 覆盖——每个阶段开始时 prompt 是重新构造的，携带了阶段所需的所有上下文。但在**阶段内部**（尤其是大型 DEV 任务），模型可能经历几十甚至上百轮对话，中间细节存在丢失风险。

外部有方案通过在 CLAUDE.md 中要求模型每次回复带上特殊标识来探测上下文丢失（金丝雀探针），但这种被动标记方案有三个缺陷：

- **假阳性高**：模型忘记输出标识 ≠ 上下文丢失，可能只是当前推理路径没走到那条指令
- **假阴性高**：CLAUDE.md 在 system prompt 最前面不会丢失，模型每次都能输出标识，不代表中间轮次的业务细节还在
- **噪音大**：每轮回复都带无业务意义的标记

### 方案

采用**主动探针 + 自动 checkpoint / compact**，而非被动标记：

1. **轮次计数** — `tmux-http` 维护当前阶段的轮次计数器，阶段切换时归零
2. **静默探针** — 每达到阈值轮次（如 N 轮），tmux-http 向 session 注入一个静默探测问题：
   ```
   请回答（无需解释）：当前任务目标是什么？上一步做了什么？下一步要做什么？
   ```
3. **质量判断** — 如果回复准确 → 上下文健康，继续；如果回复模糊或偏离 → 触发干预
4. **干预策略**（按优先级）：
   - **主动 compact** — 调用 Claude Code 的 `/compact` 压缩上下文，保留关键决策和当前状态
   - **重新聚焦** — 通过 `/w-prompt` 重新生成当前阶段的提示词，注入 session，让模型重新建立上下文锚点
   - **硬重置** — 极端情况下保存当前状态到 `.awf/state.json`，重启 session 从状态恢复

### 设计要点

- 探针注入应**静默**——不给用户看探针问题和回复，只在后台判断
- 探针内容应探测**具体业务记忆**（任务目标、当前进度、下一步），而非检测指令遵守
- 阈值 N 应可配置，且不同阶段可能需要不同的 N（DEV 通常比 COMMIT 需要更多轮次）
- 所有 checkpoint/compact 事件应有日志，便于事后诊断上下文是否是导致 bug 的根因

---

## Token 成本优化：聚焦输出端，利用 CLAUDE.md（2026-07-17）

### 前提

awf 构建在 Claude Code 之上。Claude Code 已内置 Prompt Cache、自动摘要、`/compact`、并行工具调用等优化。**awf 不应重复造 Claude Code 已经做了的轮子**，优化空间应限定在 awf 独有的概念和能力范围内。

### 真实的成本结构

- 输入 token（缓存命中）→ 极便宜
- 输入 token（未命中）→ 一般
- **输出 token → 贵，且是主要支出**

优化输入 token 打错了靶子。真正烧钱的是模型废话太多——每次回复中有效内容可能只有 10-20%，其余是仪式性输出（复述已知信息、解释意图、为决策附加大段合理性辩护）。

### 核心方案：CLAUDE.md 注入简洁人设

与其在每个 skill 里分散添加简洁要求，不如在 `awf init` 初始化 CLAUDE.md 时注入一句全局约束：

```markdown
## 沟通原则

- 直接执行，不解释你打算做什么
- 不复述用户已知道的信息
- 不为修改附加合理性辩护，除非被问
- 除非遇到阻塞，否则只输出结果，不输出过程
- 优先用结构化格式（表格、列表、diff）代替大段叙述
```

一句覆盖所有阶段、所有 skill。CLAUDE.md 作为 system prompt 的一部分在每个 session 持久生效。

### awf 层能做的 vs 不该做的

| 能做（Claude Code 不具备的能力） | 不该做（Claude Code 已内置） |
|----------------------------------|------------------------------|
| 阶段间结构化状态传递代替完整历史 | 自己实现上下文压缩 |
| 按阶段裁剪 skill 加载 | 手动管理 Prompt Cache |
| 阶段完成后主动重置上下文 | 优化工具调用往返 |
| 探针驱动的预处理 | 文件读取缓存 |
| 简洁人设全局注入 | 实现自动摘要 |
| 场景模型路由（one-shot 用便宜模型） | — |

### 补充：场景模型路由

one-shot 提示词生成（`/w-prompt`）在 awf CLI 层面控制，可以指定便宜模型（如 Haiku），不走 Claude Code session。这是 awf 层面能做的少数输入侧优化，因为提示词生成是简单的文本组装任务，不需要强推理。
