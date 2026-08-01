<!-- awf-rules start -->

## awf 模式

读取 `state.json` 的 `mode` 字段确定当前模式：

| mode | 含义 |
|------|------|
| `plan` | awf plan 规划中 |
| `run` | awf run 执行中 |
| `idle` | 无 awf 进程 |

### plan和run通用规则

- `.awf/state.json` 只能通过 `awf-state` MCP 工具修改，禁止直接文件读写

### awf-plan 模式

### awf-run 模式

- 需要用户决策时，禁止直接列出选项等待回复。必须先调 MCP tool 通知 CLI：
  - 选择题 → `awf_await_choice({question, options[], context?})`
  - 自由输入 → `awf_await_input({question, context?})`
  调用后按原有方式呈现选项即可，CLI 会自动检测并收集用户回应。

<!-- awf-rules end -->
