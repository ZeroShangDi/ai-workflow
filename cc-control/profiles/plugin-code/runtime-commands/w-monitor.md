# w-monitor

相同目录下，非 tmux 调用的 cc 建立对 tmux 中 cc 的 loop 检测机制，在合适的时机进行调整。

## 监控维度

- Session Server 健康状态（/status 端点）
- tmux pane 活跃度（是否卡死）
- 当前任务耗时（是否超时）
- 异常信号（重复错误、无响应）

## 调整动作

- 超时无响应 → 发送重试信号
- 重复错误 → 通知用户介入
- 任务完成 → 触发下一阶段

## 关联

- 通过 Session Server 中转状态信息
- 与 awf-run-error 协同处理异常
