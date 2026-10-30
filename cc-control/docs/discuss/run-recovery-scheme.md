# awf run 中断恢复方案讨论

> 日期：2026-08-31
> 背景：运行中 `awf run` 超时后进程报错退出，手动再次 run 时旧 tmux 被重建、会话上下文丢失。讨论恢复方向与方案，后续有需要再落地。

## 现状（现象 → 机制对照）

| 现象 | 对应机制 |
|------|---------|
| 超时后进程报错结束 | `run-batch` 单轮等待硬上限 `WAIT_TIMEOUT_MS`（15min），超时抛错 → CLI 退出（设计行为，非崩溃） |
| 退出后 tmux 还在 | 异常退出时 CLI 故意不清理：保留 tmux + Session Server + `mode=run`，打印「保留现场供 w-monitor 诊断」 |
| 手动 `awf run`（不带 `--resume`） | 走 `ensureServer/ensureSession`：发现端口/会话被占 → kill 重建 → tmux 对话历史丢，state.json 不丢 |
| `awf run --resume` | 走复用路径：校验 server 端口 + tmux cwd 匹配 → 复用现场，从 state 续跑 |

**「丢了什么」的分界**：
- **state.json（任务/状态/落账）**：权威数据，异常退出不清它，永远不丢。
- **tmux 里 CC 的对话上下文窗口**：复用则保留，重建则丢。AI 靠 state + `.awf/context/handoff.md` 快照续跑。
- **未落账的 exec 中间态**：丢（AI 做了一半没写 state），属合理——没完成不算完成。

## 方向判断

- **进程死 ≠ 任务死**。任务真相在 state.json，进程只是执行器，随时可换。
- 「进程已死」无法同窗口自愈；终端窗口还在时可同窗口重敲 `awf run --resume` 恢复。
- 「进程还活着（异常可捕获）」→ 进程内 catch 不退出、继续循环，是真正的同窗口续跑前提（仅覆盖可捕获异常；SIGKILL/内存炸/Ctrl-C 救不了）。

## 恢复方案（分层）

### L0 数据层 —— 不丢账（必做）
- `state.json` 是唯一权威，恢复只认它。
- 落账时机前移：AI 每个可验证步骤落一次账，缩小「做了但没写」的窗口。
- 决策写 `.awf/decisions/`，上下文写 handoff 快照——跨会话恢复的「记忆」，替代丢失的 tmux 对话。

### L1 现场层 —— 不丢上下文
- 恢复优先级：**复用 tmux 优先**（`--resume` 校验 cwd）；tmux/server 已死才重建。
- 重建兜底：启动时把 handoff 快照注入新会话 prompt，让新 CC 冷启动接上。
- 幂等续跑：从「第一个非 done 任务」继续，已完成任务不重做（gate 门禁 deps 保证时序）。

### L2 进程层 —— 不丢运行（可选，复杂度高）
- 跨进程 watchdog：`awf run` spawn detached 守护进程，检测 CLI 进程存活（pgrep/proc）+ `mode`；CLI 死后自动执行 `awf run --resume`。
- 这是「全自愈」唯一可靠形态——进程内自愈覆盖不了进程死亡。
- 代价：守护进程生命周期、孤儿回收、端口/锁管理。**建议先不做，用 L0+L1 + 半自动监控顶上。**

## 监控触发模型

目前既非自动监控、CLI 也不自愈——现状是「保留现场等人来救」。

| 模型 | 触发方式 | 适合场景 |
|------|---------|---------|
| 全手动 | 发现报错 → 同窗口 `awf run --resume` | 现在，零成本 |
| 半自动监控 | 另一个会话手动跑 `/w-monitor` 常驻，检测 state.mode + CLI 进程 liveness + tmux alive → 异常自动 `--resume` | 长任务、跑着人不在 |
| 全自动自愈 | L2 watchdog 守护进程（或 launchd/systemd 托管），无人值守 | 服务器/CI 场景 |

## 结论（本次落盘）

- 推荐路径：全手动（`--resume`）保底，做好 L0/L1 幂等与复用地基；需要无人值守时再补半自动监控（复用已有 w-monitor 探测/修复框架，补「CLI 进程死亡 → 自动 resume」链）。L2 守护进程除非上服务器，否则不值得。
- 一句话：**恢复靠 resume 不靠自愈，不丢靠落账不靠会话。**
