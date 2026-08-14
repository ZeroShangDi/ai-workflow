# w-start

标记 state.json 进入 awf 对应运行模式（plan / run），作为 awf run 的入口触发点。

## 执行流程

1. 读取 `.awf/state.json`，检查当前 mode 是否为 `idle`
2. 校验前置条件（目标目录已 init、state.json 存在）
3. 设置 mode 为目标值（`plan` 或 `run`）
4. 记录启动时间戳
5. 输出模式切换确认

## 关联

- 触发时机：用户执行 `awf plan` 或 `awf run` 时由 CLI 调用
- 后续步骤：w-pause（暂停）/ 阶段循环（run 模式）
