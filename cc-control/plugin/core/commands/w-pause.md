# w-pause

将工作流 mode 设置为 `pause`，通过 state 闩锁暂停 CLI 编排，供人工或 `w-monitor` 安全介入。恢复为 `run` 后 CLI 自动从原位置继续。

## 执行流程

1. 调用 `awf_read_state`，确认当前 mode 为 `run`；非 run 时说明当前状态并停止，不覆盖 `idle` / `plan`
2. 调用 `awf_mode({ mode: "pause" })`
3. 再次读取 state，只有确认 `mode=pause` 后才报告暂停成功
4. CLI 在派发、补发、决策处理和任务收尾边界轮询该闩锁；pause 期间不产生新的 tmux 指令
5. tmux Claude Code 不会被本命令强制中断；需要中断时由介入方在确认 pause 后单独执行
6. 介入完成后调用 `awf_mode({ mode: "run" })`，CLI 自动继续

## 暂停原因

- 需要用户决策（选择题 / 自由输入）
- 发现阻塞问题需要人工介入
- 阶段性确认点

## 关联

- 触发时机：AI 通过 `awf_await_choice` 或 `awf_await_input` 通知 CLI
- 恢复方式：人工介入或 `w-monitor` 修复验证成功后将 mode 设回 `run`
- 安全要求：任何自动修复都必须先复核 `mode=pause`；修复失败转人工时保持 pause
