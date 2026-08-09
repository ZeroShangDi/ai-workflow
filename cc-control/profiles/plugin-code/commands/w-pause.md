# w-pause

标记暂停 awf 模式，进入人工介入状态。暂停期间 CLI 轮询等待用户解除暂停。

## 执行流程

1. 设置 state.json 中 mode 为 `pause`
2. 通知 Session Server 当前状态变更
3. tmux session 保持挂起，等待人工处理
4. 用户解除暂停后，恢复原 mode 继续执行

## 暂停原因

- 需要用户决策（选择题 / 自由输入）
- 发现阻塞问题需要人工介入
- 阶段性确认点

## 关联

- 触发时机：AI 通过 `awf_await_choice` 或 `awf_await_input` 通知 CLI
- 恢复方式：用户输入后 CLI 自动恢复
