# 提示词生成

为 run 工作流的指定阶段智能生成提示词。CLI 通过 `claude -p` one-shot 调用此命令，拿到返回的 prompt 后转发给 tmux session 执行。

## 参数

```
/w-prompt <phase> <task-id> [--from <phase>] [--error <description>]
```

| 参数 | 说明 |
|------|------|
| `<phase>` | 目标阶段：DEV / REVIEW / TEST / COMMIT / FINISH / DEBUG / DOCS |
| `<task-id>` | 任务 id |
| `--from` | 可选，触发阶段（DEBUG/DOCS 时指明从哪个阶段切入） |
| `--error` | 可选，错误描述（DEBUG 时携带） |

## 执行流程

1. 读取 `.awf/state.json`，找到 `plan.tasks` 中 `id` 匹配的任务
2. 调用 awf-task-model skill 理解 task schema，调用 awf-spec skill 理解阶段定义和规则
3. 根据阶段、任务数据和上下文，智能生成一条完整的阶段入口 prompt
4. **只输出最终提示词文本，不要任何解释、标记或代码块包裹**
