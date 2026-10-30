---
id: "009"
title: "真机会话 hook 链偶发失效：run 以 still busy (ready timeout) 挂掉"
status: open
labels: [bug, tooling, reliability, real-run]
assignee: null
milestone: null
priority: high
created: 2026-09-11
updated: 2026-09-11
deps: []
related: ["T3-011", "005", "007", "008"]
---

# 真机会话 hook 链偶发失效：run 以 `still busy (ready timeout)` 挂掉

**一句话**：`awf run` 会偶发地在**第二个任务派发前**死亡，错误 `still busy (ready timeout)`；
真正坏掉的是**该 tmux 会话的 hook 链**（SessionStart 没到 → Stop 也不会到 → server 侧会话状态永挂 `busy`
→ 宿主等不到 ready 就放弃）。现象像产品缺陷，根因在会话启动/hook 时序。

## 一、现象

- `awf run` 退出码 1，CLI 抛 `still busy (ready timeout)`（`src/cli/run.js:129` ← 宿主 `outcome.error`）；
- server 侧同一 run 记为 `status: error, error: "still busy (ready timeout)"`；
- 卡点位置固定：**前一个任务正常 done，下一个任务已被 `markTaskActive`（state 里是 `active`），
  但它的「提示词」段从未出现在 run 日志里** —— 即死在 `waitReady` 之前，prompt 根本没注入
  （`src/server/server.cjs:529`）。

## 二、相关性证据（2026-09-11 同机实测）

启动日志里的 `⚠ 等待会话就绪超时（60s 未收到 SessionStart），继续派发` 与失败**同现**：

| 运行 | SessionStart 警告 | 结果 |
|---|---|---|
| `eval --only dynamic-planning`（12:39） | 无（`✔ 会话已就绪`） | 通过 1/1 |
| `eval --only dynamic-planning`（13:31） | **有** | 失败：`still busy` |
| `test:real --case dynamic-planning-run`（13:22） | 无法回查（日志已被复跑覆盖） | 失败：`still busy` |
| `test:real --case dynamic-planning-run`（复跑） | 无 | 通过 22/22 |

约 **1/2 的会话启动丢 SessionStart**。注意 `state` 仍是 `busy`（说明 UserPromptSubmit 到了）——
不是「hook 全丢」，而是**启动期那一条丢了**，于是 `sessionSeq` 不增长、`waitSessionReady` 永远等不到。

## 三、影响

1. 真机门禁不稳定：`--case all` 十几个 case 连跑，任何一次抖动都会把门禁打红，且**红得没有信息量**
   （看起来像产品回归，实际是环境时序）。
2. 失败被放大：`waitSessionStarted` 的兜底是「超时告警后**继续派发**」（设计意图是别把偶发慢启动升级成 run 失败），
   但实际结果是 prompt 打进一个半就绪的会话 → 之后的 `Stop` 也不来 → 拖到 `READY_TIMEOUT_MS` 才失败，
   **把「早期可恢复的启动问题」变成了「几十分钟后的 run 死亡」**。

## 四、现场

失败沙箱保留（`sandbox/eval/dynamic-planning-2026-09-11T13-31-01/`，另有 regression 侧同名目录被复跑覆盖），
可查 `eval.log` / `.awf/logs/server.log` / `.awf/logs/<stamp>/main.log` / tmux pane。

## 五、待查方向（未定论）

1. 启动期 `SessionStart` 的投递链路：`plugin/core/hooks/hooks.json`（端口为渲染期写死的 argv）→ `gateway.cjs`
   → server `/hook`；丢在哪一环？（对比 `007` 的命名空间漂移，这条更像时序/竞态）
2. `sessionSeq` 的记账口径：是否只有 SessionStart 增量，是否存在别的启动信号可交叉验证。
3. 兜底策略是否该改：超时后**显式失败并重建会话**，而不是「带病继续派发」。
4. 与 `005`（server 可观测性）合并考虑：这类失败要能一眼看出「是会话没起来」而不是「产品坏了」。

## 六、进展与当前决议

### 2026-09-12：第 1 层「让错误响亮」已落地

- `plugin/core/hooks/gateway.cjs`：**run 会话内**失败一律留痕 —— `CC_PROJECT` 缺失（会被 400 丢）、
  连接失败/超时、HTTP ≥400，各写一行到 stderr 与 `<项目>/.awf/logs/hook-gateway.log`；
  SessionStart 成功也留一行（hook 链是否建立的唯一判据）。普通交互会话（非 run）保持安静，避免刷屏。
- `src/server/server.cjs`：`缺 ?p` 的 400 分支补 `console.warn`（这条路径以前完全不留痕）。

这一层不修故障本身，只保证**下次复现时一眼能看出是 hook 没到**，而不是「产品坏了」。

### 仍未做

- 第 2 层（无条件注入 `CC_PROJECT` / `waitReady` 多信号判据 / 超时后重建会话）与
  第 3 层（丢在哪一环）**待复现取证后再定**；
- 结论口径：动态规划两个 case 的「复跑同结论」目前只能声明为
  「case 逻辑稳定；端到端成功率受本条影响」。真机门禁收口前必须先解决或隔离它。
