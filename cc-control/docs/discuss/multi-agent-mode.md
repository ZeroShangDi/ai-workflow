# 多 Agent 模式讨论

- 日期：2026-08-26
- 状态：**讨论中，未定稿**（待明天定方案）
- 相关分支：feature/cc-control-v0.1.3

## 1. 目标

`awf run` 支持多 agent 并行执行任务；单 / 多 agent 通过配置切换（仅 `.awf/config.json`，不加 CLI 旗标）。

## 2. 已确认约束（用户）

1. **同质池**，不拆分角色；调度器把任务派给任意空闲 agent。
2. **文件冲突需谨慎处理**；必要时在 plan 阶段预规划每个任务要改动的文件。
3. **并行引发的审查 / 测试问题需仔细考量**（跨 agent 产出由谁审、测试冲突归谁）。
4. 配置入口仅 `.awf/config.json`（`run.agents`，默认 1 = 现状零变化）。

## 3. 两条路线

### 路线一：多 tmux 会话 + CLI 中央调度

- CLI 启动 N 个 tmux session（`cc-<id>`）+ 各自状态机，CLI 是任务循环的唯一所有者。
- 调度器（CLI 代码）`findNextTask` → 派给空闲 agent → 等 ready → 收尾协商。
- **已有完整设计**：见 `docs/discuss/multi-session-design.md`（方案 B，已设计、暂缓实现）。该文档解决了 hook 反向路由（hook payload 带 `id`，server 按 `body.id` 分流状态机）。
- 改动规模：约 10-12 个文件（server.cjs 按 session 分片、tmux.cjs 去全局 SESSION、config.json hooks 带 id、run.js 调度器、state.js 集群拆分、run-config.js、client.js、awf-state 文件锁、测试等）。

### 路线二：cc 原生多 agent（Agent/Tool 工具）+ AI 编排

- 只保留**一个**主 tmux 会话；主 agent 在会话内用 Agent 工具并发派生多个子 agent 做并行任务，自己聚合结果、经 awf-state MCP 写回 state.json。
- 任务循环从 CLI 代码**移入 AI 行为**（由插件 skill 驱动）。
- 改动主要在插件层（新增编排 skill + prompt），CLI 变薄（发一个编排 prompt + 等待兜底）。

## 4. 关键确认：hook 监控在路线二下是否还有问题（今日实证）

**结论：路线一的多会话 hook 路由问题在路线二下消失** —— 仍是单 tmux、单端口、单 ready/busy 状态机，server 完全不需要按会话分片。

但出现一个**更轻的新问题**（依据官方文档 + issue #33049 实证）：

- 子 agent 的 `UserPromptSubmit / PreToolUse / PostToolUse` **会触发**项目级 hooks（带子 agent 自己的 session_id）→ 会 POST busy。
- 子 agent 完成的 `Stop` **不会触发**（运行时转换为 `SubagentStop`）→ 子 agent 从不 POST ready。
- 后果：
  - server 若保持**闩锁语义**（busy 自上次 UserPromptSubmit 起、由主会话的 Stop 清空）→ 能自愈。
  - server 若是**引用计数**（每次 busy +1、每次 Stop −1）→ 子 agent 的 busy 永不归零 → 永久 busy 悬挂。
- 修复方案（按可靠性排序）：
  1. **hook 侧按 session_id 白名单过滤**：SessionStart 时记录主 session_id；hook 命令只对 session_id === 主 session_id 的 UserPromptSubmit POST busy，其余丢弃。官方认可的最可靠方案。
  2. server 的 busy/ready 保持闩锁语义，只认主会话的 Stop。
  3. `awf_oneshot` 这类 `claude -p` 子进程也会跑 hooks：hook 命令用 `CLAUDE_CODE_ENTRYPOINT` 区分 headless，避免计入交互状态机（具体取值需实测）。
  4. 后台子 agent（`run_in_background`）结束对 hook 流完全不可见 → 靠它们结束时经 awf-state MCP 写回 state.json（现有链路已具备）。

## 5. 路线二的其他实证利好 / 风险

- 子 agent **继承父会话的 MCP servers** → 能调 awf-state / awf-session / awf-oneshot。
- 单会话内 Agent 工具**原生支持并行**（同一条消息多个 Agent 调用同时启动）。
- 子 agent **上下文与主会话隔离**（全新上下文窗口），完成以纯文本返回主会话 → 正好契合项目「阶段间上下文天然断裂」的既有设计，子 agent 间无需再做上下文压缩。
- 主会话自身上下文随聚合增长 → 现有的 `maybeCompactContext` 仍需要保留。
- **状态并发**：多个并行子 agent 同时经 awf-state 写 state.json → 仍是 read-modify-write 丢更新风险；路线二可让**主 agent 独写**（子 agent 只回文本，主 agent 统一 awf_task_result），从根上避开。
- **决策处理**：子 agent 内 `AskUserQuestion` 的 PreToolUse hook 会打到主 server，但 `/respond` 是 tmux send-keys，回不到进程内子 agent → 子 agent 的决策应**上抛主 agent**，由主 agent 统一 `awf_await_choice/input`，机制待设计。

## 6. 优劣势对比

| 维度 | 路线一（多 tmux + CLI 调度） | 路线二（原生多 agent + AI 编排） |
|------|------------------------------|----------------------------------|
| 编排确定性 | 高（CLI 状态机） | 低（依赖 AI 遵循 skill） |
| 基础设施改动 | 大（server 分片等 ~10-12 文件） | 小（server 基本不动，插件为主） |
| hook 复杂度 | 高（payload 带 id 分流） | 中（session_id 过滤 + 闩锁语义） |
| 上下文压缩 | 每会话独立，现机制复用 | 子 agent 天然隔离；主会话继续压缩 |
| attach / dashboard | 需多会话视图 | 单会话，基本不变 |
| 决策处理 | 每 agent 独立决策 | 子 agent 决策上抛主 agent（机制待设计） |
| 并行度控制 | CLI 精确控制 | 靠 skill 指示 + 模型判断 |
| 与现有哲学契合 | 符合「CLI 中央调度」 | 偏离（编排移入 AI），更贴「插件改动 CLI 零感知」 |

## 7. 两条路线共同问题（无论选哪条都要解决）

1. **文件冲突**：deps 只保顺序、不保文件不重。plan 阶段 `task.files` 预规划 + 调度按文件集不相交（并集门禁）。
2. **审查 / 测试**：建议并行度按 DAG 连通子图（cluster）收敛 —— 审查 / 测试任务（deps 多）天然只跨一个 agent 的产出，可审查、可归责。
3. **state.json 并发写**：文件锁，或收敛写者（路线二 → 主 agent 独写）。
4. **任务认领竞态**：集中认领（CLI 调度器 或 主 agent），派活前复查 pending + 置 active。
5. **决策并发**：多 agent 同时 await_choice/input 的处理与归属标注。

## 8. 待明天讨论的开放问题

- 路线一 vs 路线二，选哪个？（当前倾向路线二：基础设施改动小、hook 问题更轻，代价是编排确定性让渡给 AI）
- 若路线二：编排 skill 的可靠性如何兜底？CLI 保留怎样的「心跳 / 超时」监督？
- 文件冲突：`task.files` 规划做进 MVP，还是先靠 cluster 隔离？
- 审查 / 测试任务的调度归属与跨 agent 归责。
- 子 agent 决策上抛主 agent 的机制（`awf_await_choice` 如何在子 agent 场景正确路由）。
