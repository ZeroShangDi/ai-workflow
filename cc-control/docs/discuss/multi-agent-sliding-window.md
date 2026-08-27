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

1. **验证 `run_in_background` 子 Agent 实际行为** — ✅ 官方行为已查证（见 §10）；**剩 2 个实证点**：后台子 Agent 是否触发 SubagentStart/Stop、inbox socket 注入实测
2. **确认落账路径**（hook 直写 state / 经 server / 子 Agent 自写）与 **taskId ↔ 子 Agent 关联机制**
3. **重设计 `runBatchLoop`**：批次屏障 → 滑动窗口调度器（就绪池 + 配额上限语义 + 补位循环 + reconcile 兜底）
4. **batch 模板改写**：主 Agent 只派生后台子 Agent，不落账；落账走 hook
5. **M2 `SubagentStop` 从观测升级为落账触发**
6. **M5 决策上抛**（独立任务，不并入本次）
7. **eval 用例更新**（滑动窗口语义，去掉批次 banner 断言）+ 重跑验证

## 9. 下一步建议

已从「先验证后台子 Agent」推进到「**实证 2 个关键点 + 按 socket 注入重构派发通道**」：

- **实证 A**：后台子 Agent 是否触发 SubagentStart/SubagentStop（决定落账是否走 hook）
- **实证 B**：CLI 经 inbox socket 向主会话注入派生指令（决定派发通道）
- 实证通过后：CLI 滑动窗口调度器（socket 注入补位 + SubagentStop 落账）

## 10. run_in_background 行为查证（2026-08-27，claude-code-guide，版本 2.1.227）

**核心结论**：滑动窗口架构**可行**，且有官方通道支持。

### 后台子 Agent（官方明确）
- **不阻塞主回合**：主会话可继续做自己的工具调用，回合自然结束；子 Agent 结果作为「后续回合的完成通知」到达，非 in-band 返回值
- **继承全部 MCP 工具**（built-in 收窄到 19 个但 MCP 一个不砍）→ 子 Agent 可自调 `awf_task_complete`（备选落账路径）
- 主会话可感知完成（后续回合通知），但 **CLI 不依赖主会话唤醒**

### SubagentStart/Stop hooks（部分需实证）
- hook 存在、payload 字段明确（session_id / agent_id / agent_type / prompt_id / last_assistant_message 等）
- **⚠ 需实证：官方未显式声明对 run_in_background 后台子 Agent 是否触发**（描述不分前后台，倾向会触发，但设计依赖它必须先实测）
- 已确认：子 Agent 内部每次工具调用也会触发 PreToolUse/PostToolUse（带 agent_id/agent_type）→ hook 通道已能观测子 Agent 活动

### 前台子 Agent（重要纠正）
- **逐个返回即继续（串行阻塞）**，不是并行等待 → 前台模型本来就不支持并行，滑动窗口必须走后台

### ★ inbox socket（官方通道，滑动窗口派发的关键）
- 每个启用 messaging 的会话绑 inbox socket（Unix domain socket，路径在 `CLAUDE_CODE_MESSAGING_SOCKET` env / `/status` Peer address）
- **CLI 可在主会话活动回合的工具调用间隙注入文本消息，不打断运行中的工具**；主会话 idle → 立即开新回合
- 版本门槛 v2.1.224+（本机 2.1.227 ✅）
- 约束：
  1. **纯文本**——命令字符串（如 `/compact`）不执行，只是普通文本
  2. 需显式配置主会话 `crossSessionInbound: "accept"`（否则 bypassPermissions 默认 hold 他人消息等批准）
  3. CLI 是 claude 的祖先进程（非子进程），own-child 快速通道不适用

### 版本注意
- 升级到 v2.1.232+ 后交互会话默认开 **fork mode**：`run_in_background` 参数移除、子 Agent 一律 fork 后台、结果全部走消息回传 → 提示词层需兼容「带参数 / 无参数」两种形态

### ★ socket 集成落地（2026-08-27 查证，反编译 2.1.227 bundle + 实测活会话）

**决定性前提**：本机 env `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`（及 `DISABLE_TELEMETRY`/`DO_NOT_TRACK`/`DISABLE_GROWTHBOOK`）会**关闭 cross-session messaging**——实测当前活会话无文件系统 inbox socket。**必须先处理**：bootstrap 启动 claude 时 unset（仅影响 claude 会话，不改用户全局 telemetry 偏好）。

**socket 路径（三选一，推荐 A）**：
- **A. 隐藏 flag 固定路径**：`claude --messaging-socket-path <固定路径>`（`--help` 不显示，bundle 确认存在；启动即固定，CLI 不用猜）。需实证与 feature-flag 交互。
- B. CLI 按 pid 算：`$TMPDIR/cc-socks/<pid>.sock`（macOS，os.tmpdir() 实际值）
- C. SessionStart hook 落盘：`CLAUDE_CODE_MESSAGING_SOCKET`/`TOKEN` 在 SessionStart 前导出给 hooks，hook 写到 `.awf/messaging.json`，CLI 读
- 预设 `CLAUDE_CODE_MESSAGING_SOCKET` env 无效（路径只由 flag/tmpdir 决定，不读该 env 作输入）

**`crossSessionInbound: "accept"` 必须配**（主会话 bypassPermissions 默认 hold 未证明权限的消息）：配在项目 `.claude/settings.json`（bootstrap 用 `--settings` 注入 run-settings.json 也可）。注意 managed/项目级 `hold`/`refuse` 会压过用户级 `accept`。

**Node socket 客户端（线格式 NDJSON，`\n` 结尾）**：
```js
conn.write(JSON.stringify({
  type: 'user',
  message: { role: 'user', content: '<指令文本>' },
  priority: 'next',
}) + '\n');
// macOS：写后延时 ~200ms 再 end()
```
- 官方示例：`echo '{"type":"user","message":{"role":"user","content":"hello"}}' | socat - UNIX-CONNECT:<path>`
- auth：macOS/Linux 可选（官方示例无 auth）；Windows 必填首行
- 可选字段：`msgV:1` / `msg_id` / `from` / `file_attachments`（官方示例仅 type+message，倾向可接受，正式接入前实证）

**注入行为**：`type:"user"` 消息 = 主会话收到一条用户 prompt（等价终端输入）→ 会执行"派生后台子 Agent"；mid-turn 在工具间隙读取不打断运行工具；`/` 命令按纯文本不执行。

**待实证**：`--messaging-socket-path` 与 feature-flag 交互；最小信封（无 msgV/msg_id/priority）被接受；去 env 后 socket 绑定到公式路径。

### 对滑动窗口架构的落地
```
CLI 滑动窗口调度器
  ├─ 派发：经 inbox socket 向主会话注入「派生下一个后台子 Agent」文本指令（不打断回合）
  ├─ 完成感知：SubagentStop hook → /hook → 落账（若实证不触发 → 改子 Agent 自写 / 主会话通知）
  ├─ 补位：socket 注入下一个
  └─ 兜底：reconcile
```

## 11. 落账路径定稿（2026-08-27 用户确认方向）

**子 Agent 结构化返回 + SubagentStop hook 解析落账**（用户否决「子 Agent 自调 MCP」，因工具调用易失败）：

```
子 Agent 结束 → 输出固定格式 JSON（含 taskId/status/result/files）
  → SubagentStop hook → 读 payload.last_assistant_message（= 子 Agent 最终文本，官方明确）
  → 解析 → 落账（hook 直写 state 或经 server）
  → 解析失败 → CLI 兜底（该任务未落账 → 重试/收尾，复用 reconcile 模式）
```

关键依据 / 风险：
- `last_assistant_message`：SubagentStop/Stop 专用字段 = 子 Agent 最后一次回复文本（官方明确，建议用它而非读 transcript）
- 比子 Agent 自调 MCP **更稳**（输出文本成功率高）；风险：子 Agent 不按格式（prompt 强约束 + 兜底）、后台子 Agent 是否触发 SubagentStop（**需实证**）
- **SubagentStop 之后可再通话**（官方明确：主会话 SendMessage 可恢复已完成的后台子 Agent，保留历史）——但那是主会话工具，CLI 不能直接调；hook 落账是一次性的，失败走 CLI 兜底，不需要再通话

### ✅ 实证通过（2026-08-27，subagent-hooks-probe eval 用例）

沙箱：`sandbox/eval/subagent-hooks-probe-2026-08-27T02-22-59`（保留）

| 检查项 | 结果 |
|---|---|
| 后台子 Agent 触发 SubagentStart/Stop | ✅ payload `hook_event_name` 确认 |
| `last_assistant_message` 含固定格式 | ✅ `"RESULT: {\"taskId\": \"T1\", \"status\": \"done\", \"result\": \"probe-done\"}"` 完整落在该字段 |
| 子 Agent 真执行 | ✅ `probe-result.txt` = `probe-done` |

**两个重要结论**：
1. 落账路径可行：固定格式 RESULT 完整落在 `last_assistant_message`，hook 解析即可落账。
2. **taskId 关联自动解决**：taskId 在 RESULT 里，**无需 agent_id ↔ taskId 预映射**。

⚠️ 留意：SubagentStart/Stop 的 `session_id` 是**主会话的**（子 Agent 靠 `agent_id` 区分）。已验证子 Agent 生命周期事件不进主闩锁判断（M2）；但子 Agent 其他活动事件（Pre/PostToolUse）是否带主 session_id、是否影响 `isMainSession` 过滤，后续滑动窗口实现时留意。

### 落账流程修正（2026-08-27 用户补充，覆盖上方「解析→落账」简化描述）

**问题**：`runBatchLoop` 现有的 reconcile（发 `batch-reconcile` 收尾让主 Agent 落账）是沿用**单 agent 的 settle/wrapup 思路**——主回合结束后 CLI 检测未落账 → 补发提示词。多 agent 滑动窗口下**时机和对象都错**：任务状态应由 **SubagentStop hook** 驱动，不该让主 Agent 收尾落账。

**正确流程（用户定稿）**：
```
子 Agent 结束 → SubagentStop hook
  → hook 读 last_assistant_message，校验字段完整（taskId/status/result）
  ├─ 完整 → 解析 → 落账 → 调度器释放配额 → 补位
  └─ 缺失 → 补发提示词：主 Agent 用 SendMessage 与该子 Agent（其 sid）对话，要求补齐固定格式字段
        → 子 Agent 补齐输出 → 再次进入 hook → 有字段 → 落账
```

**关键**：
- 补发对象是「主 Agent 与对应子 Agent 对话」（SendMessage 恢复子 Agent 要字段），**不是**发 batch-reconcile 让主 Agent 自己标。
- 单 agent 靠 CLI settle（检测→提示词→主会话自改）；多 agent 靠 **hook 字段校验落账**（检测在 hook、补发走 SendMessage 恢复子 Agent）——**两套机制不通用**，`runBatchLoop` 的 reconcile 在滑动窗口实现里**移除**。这正是单/多 agent run 必须隔离的原因。

## 12. 调度器设计要求（2026-08-27 用户要求）

- **滑动窗口调度器算法独立成单独文件**（不塞进 run.js）
- **预留「完成时延时补位」逻辑**：完成信号可能有延迟（hook 异步/解析耗时），补位循环不能依赖即时信号，需容忍延迟窗口
- 派发用 **socket 即时补位**（已确认用方案 1）

## 13. 实证后下一步（待办更新）

落账前提已实证，进入滑动窗口实现设计：

1. **滑动窗口调度器**（新文件，如 `src/cli/scheduler.js`）：就绪池 + 配额上限语义 + 补位循环 + 完成信号（SubagentStop → 解析 last_assistant_message → 落账）+ 延时补位预留
2. **inbox socket 派发集成**：CLI 注入「派生后台子 Agent 执行 taskX」指令；主会话配 `crossSessionInbound: accept`
3. **taskId 解析**：hook/server 解析 RESULT 拿 taskId + 结果 → 落账（`awf_task_complete` 或直写 state）
4. **batch 模板改写**：主 Agent 只派生后台子 Agent（含"子 Agent 结束时输出固定格式"约束），不落账
5. **M2 SubagentStop 从观测升级为落账触发**（实证已确认触发）
6. **兜底**：reconcile（解析失败/超时 → 重试/收尾）
7. **M5 决策上抛**（独立任务）；**eval 用例更新**（滑动窗口语义）+ 重跑验证

