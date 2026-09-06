# w-start

标记 state.json 进入 awf 对应运行模式（plan / run）。CLI 的 `awf run` 会在启动环境前直接设置 `mode=run`；本命令用于 Claude Code 内部入口或人工恢复。

## 执行流程

1. 读取 `.awf/state.json`，检查当前 mode 是否为 `idle`
2. 校验前置条件（目标目录已 init、state.json 存在）
3. 设置 mode 为目标值（`plan` 或 `run`）
4. 记录启动时间戳
5. 输出模式切换确认

## 关联

- 触发时机：Claude Code 内部模式切换或人工恢复；`awf run` 的初始切换由 CLI 直接完成
- 后续步骤：w-pause（暂停）/ 阶段循环（run 模式）
