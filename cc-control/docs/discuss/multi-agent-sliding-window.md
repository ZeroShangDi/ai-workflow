# 多 Agent 滑动窗口讨论（交接备忘）

- 日期：2026-08-26（下班交接，回家后继续）
- 状态：**讨论中，未定稿**——调度模型从「批次屏障」修正为「滑动窗口」，待确认关键架构决策后重新设计
- 前置文档：[multi-agent-mode.md](multi-agent-mode.md)（方案 C 定稿 + M1-M4 里程碑）

## 1. 当前已实现（M1–M4，已提交）

| 里程碑 | 内容 | 提交 |
|---|---|---|
| **M1** 调度骨架 | 单 tmux + CLI 中央调度 + 原生子 Agent + **批次屏障**（整批结束才下一批）；`run.agents` 四级配额；task `kind`；runBatchLoop；batch 模板；eval 用例 | `b77d55b` |
| **M4** plannedFiles | plan 侧 `plannedFiles` + 调度按文件集不相交过滤（缺失即串行，review 只读可并行） | `9dbb92a` |
| **M3** 落账原子化 | awf-state 新增 `awf_task_complete`（一次提交 status+result+files+commits）+ state 文件锁（CLI/MCP 共用 `.awf/state.lock`） | `518811c` |
| **M2** hooks 观测 | 生命周期 hook 透传 stdin → server 记录 `mainSessionId`；`UserPromptSubmit/Stop` 只认主 session 驱动闩锁；注册 `SubagentStart/Stop`（只观测）；`/status` 暴露 `activeAgents` | `0c0c32e` |
| **M5** 决策上抛 | 待做（子 Agent `needs_input` → 主 Agent `awf_await_choice/input` 归属路由，独立任务） | — |

全部 329 测试 + lint 通过。未提交的无关改动：`plugin/PLAN.md`、`plugin/interview-questions.md`（非本次工作，勿动）。

## 2. eval 重跑发现（multi-agent-parallel，M1–M4 后）

链路基本工作：4 dev 真并行（marker 时间跨度 6.3s）、B1→B2→B3 批次、`awf run` exit 0、文件冲突/落账工具正常。

**但暴露系统性问题**：B1/B2/B3 每批派发后**主 Agent 都没主动落账**——CLI 每批报「未落账，补发收尾」，靠 `batch-reconcile` 收尾 prompt 才补记（T1-T4/R1-R4/X1 被补记 done）。其中 **X2（模块 model 测试门禁）收尾后仍未完成 → 标 blocked → D1（doc）依赖 X2 不 ready 未执行**，`test/model.test.js`、`README.md` 缺失。

**根因**：不是代码 bug，是 **batch-dispatch 模板第 5 条（落账指令）主 Agent 执行批次时没遵循**（派发子 Agent 后直接结束回合，没调 `awf_task_complete`）。编排确定性让渡给 AI 的已知代价（文档早已列为「批处理 skill 可靠性兜底」）。

## 3. 调度模型重大修正：批次屏障 → 滑动窗口

**用户明确否定批次屏障**。期望的是滑动窗口（动态补位、维持满并发）：

```
示例：10 模块 × 10 功能 × 10 任务，配额 12/6/2
  = 总并发 12（同时 2 模块 × 每模块 3 功能 × 每功能 2 任务）

时刻 T： 2模块 × 3功能 × 2任务 = 12 个任务并行
某任务完成（如 模块1-功能1-任务1 done，任务2还在跑）：
  → 立即把 模块1-功能1-任务3 补进池子（保持该功能 2 并行）
  → 池子不空等，有就绪就补
功能 10 个任务全完成 → 该功能「审查」补进池子
模块下所有功能审查完成 → 模块「测试」补进池子
```

**重要**：配额是**硬上限，不是目标**——池子按实际就绪任务填充，就绪量不足时不满（比如某功能只剩 1 个任务就只派 1 个），不强行凑满 12。

## 4. 用户确定的架构分工（待实现）

- **CLI 负责调度算法（滑动窗口）**：就绪池 + 配额 + 补位循环。**主 Agent 不负责滑动窗口**。
- CLI 只通知主 Agent「生成子 Agent」。
- **子 Agent 完成 → `SubagentStop` hook → 写状态**（释放配额）。
- CLI 感知完成（server 收到 hook）→ 池子补位 → 通知主 Agent 派生下一个。

## 5. 三个待确认的技术约束（关键）

1. **子 Agent 必须「后台」派生（`run_in_background`）解锁滑动窗口**
   前台派子 Agent 会阻塞主 Agent 回合直到全部返回，CLI 无法在中间补位（tmux send 的新消息只能主 Agent 回合结束后生效）。后台派发让主 Agent 回合立即结束，CLI 才能持续补位。**需先验证**：后台子 Agent 完成信号、能否继承 MCP、SubagentStop 是否触发。

2. **hook 无法直接「调 MCP」**——`awf-state` 是 stdio server，只活在 claude 进程内，hook（独立 bash 进程）够不到。落账路径三选一：
   - **hook 直写 state.json**（带锁）——最简单；hook 是系统层，可绕过「只能经 MCP」（该规则约束 AI）
   - **hook POST 到 session server（8787）→ server 落账**——多一跳，有校验机会
   - **子 Agent 自写**（继承 MCP，完成时自己 `awf_task_complete`）——依赖子 Agent 自觉（用户倾向不让子 Agent 写）

3. **必须建立 taskId ↔ 子 Agent 关联**（M2 当时「不做映射」；滑动窗口下 hook 落账必须知道「哪个子 Agent 完成了」）
   → 派发时在子 Agent prompt 里带 taskId，SubagentStop payload 读取。

## 6. 调整清单（相对 M1，待重设计）

| 组件 | 现状（M1） | 调整后 |
|---|---|---|
| `runBatchLoop` | 批次屏障（整批结束才下一批） | **滑动窗口调度器**：就绪池 + 配额 + 补位循环，感知完成即补 |
| 主 Agent 派发 | 前台并行派 N 个 + 等返回 | **后台派生**，派完即结束回合 |
| 落账 | 主 Agent 收尾 `awf_task_complete` | **SubagentStop hook 落账**（直写或经 server） |
| taskId 关联 | 不做 | **子 Agent prompt 带 taskId，hook 读取** |
| batch 模板 | 主 Agent 执行整批（含落账） | 主 Agent 只「按 CLI 指令派生后台子 Agent」 |
| M2 `SubagentStop` | 只观测 | **升级为触发落账** |

## 7. 手段讨论结论（今天聊过，供参考）

「AI 不遵循协议」的分层应对：
- **安全网（代码层 hook/reconcile）不可省**——检测是代码，AI 没做对系统一定知道，是唯一能「保证」的手段。
- **skill 承载完整协议**（按需加载），模板只留每轮必做的少量关键指令（长 prompt 会稀释注意力——正是当前落账被忽略的原因）。
- **结构性约束**（工具设计减少 AI 动作数）有价值，但：
  - 用户否决「文件校验算完成」（plannedFiles 文件存在 ≠ 任务完成）
  - 用户否决「awf_batch_submit 一次性提交整批」（滑动窗口是逐任务完成，逐任务落账才对）

## 8. 待办清单（回家后按序）

1. **验证 `run_in_background` 子 Agent 实际行为**（完成信号 / MCP 继承 / SubagentStop 触发）——这是滑动窗口的解锁点
2. **确认落账路径**（hook 直写 state / 经 server / 子 Agent 自写）与 **taskId ↔ 子 Agent 关联机制**
3. **重设计 `runBatchLoop`**：批次屏障 → 滑动窗口调度器（就绪池 + 配额上限语义 + 补位循环 + reconcile 兜底）
4. **batch 模板改写**：主 Agent 只派生后台子 Agent，不落账；落账走 hook
5. **M2 `SubagentStop` 从观测升级为落账触发**
6. **M5 决策上抛**（独立任务，不并入本次）
7. **eval 用例更新**（滑动窗口语义，去掉批次 banner 断言）+ 重跑验证

## 9. 下一步建议

先做第 1 项（验证后台子 Agent 行为），它决定第 2、3 项怎么设计。可用最小实验：单主会话里让主 Agent 派生 2 个后台子 Agent，观察：主 Agent 回合是否立即结束、SubagentStop 是否触发、子 Agent 能否调 MCP。
