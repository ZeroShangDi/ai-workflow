<!-- awf-rules start -->

## awf 工作流规则

本项目由 **ai-workflow (awf)** 驱动，以下规则对所有 awf 命令生效。

### 命令前缀

所有 awf 命令通过 `/ai-workflow:<command>` 调用，常用的有：

| 命令 | 用途 |
|------|------|
| `/ai-workflow:w-dev` | 执行开发任务 |
| `/ai-workflow:w-review` | 代码审查 |
| `/ai-workflow:w-test` | 执行测试验证 |
| `/ai-workflow:w-commit` | 智能提交 |
| `/ai-workflow:w-doc` | 文档更新 |
| `/ai-workflow:w-debug` | 系统排查 |
| `/ai-workflow:w-finish` | 里程碑收尾 |

### MCP 工具

awf 提供 3 组 MCP 工具，在 awf run 模式下自动可用：

| Server | 工具 | 用途 |
|--------|------|------|
| `awf-state` | `awf_read_state`, `awf_task_status`, `awf_task_result`, `awf_task_commit`, `awf_phase` 等 14 个 | 读写 .awf/state.json |
| `awf-session` | `awf_session_status`, `awf_capture_pane` | 查询 session 状态 |
| `awf-oneshot` | `awf_oneshot` | 无状态 LLM 调用 |

### 状态文件

- 工作流状态文件：`.awf/state.json`
- 运行日志目录：`.awf/logs/`
- 任务详情目录：`.awf/tasks/`

### 阶段约定

任务执行遵循阶段链，门禁由任务级别驱动：

```
DEV（开发实现）→ REVIEW（代码审查）→ TEST（测试验证）→ COMMIT（提交）→ DOCS（文档更新）
```

- awf run 模式下：任务完成后自动进入下一阶段，少问问题，自主执行
- 每个阶段完成后通过 MCP 工具更新 state.json
- 异常时自动重试，仍失败则暂停等人工介入

### 任务级别

| 级别 | 触发门禁 |
|------|---------|
| 任务级 | 无（DEV 即完成） |
| 功能级 | 无（子任务完成即可） |
| 模块级 | REVIEW |
| 需求级 | REVIEW + TEST + COMMIT + DOCS |

### 自主执行原则

- 能自己判断的不问用户
- 结果写入 state.json，保持状态可追踪
- 遇阻塞才暂停，附带上下文让用户能快速决策

<!-- awf-rules end -->
