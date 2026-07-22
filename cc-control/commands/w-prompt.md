# 提示词生成

为 run 工作流的指定阶段生成提示词。CLI 通过 `claude -p` one-shot 调用，拿到返回的 prompt 后转发给 tmux session。

## 参数

```
/w-prompt <phase> <task-id> [--from <phase>] [--error <description>]
```

| 参数 | 说明 |
|------|------|
| `<phase>` | 目标阶段：DEV / REVIEW / TEST / COMMIT / FINISH / DEBUG / DOCS |
| `<task-id>` | 任务 id |
| `--from` | 可选，触发阶段（DEBUG 时指明从哪个阶段切入） |
| `--error` | 可选，错误描述（DEBUG 时携带） |

## 执行流程

1. 读取 `.awf/state.json`，找到 `plan.tasks` 中 `id` 匹配的任务
2. 调用 `w-prompt` skill，传入阶段、任务数据、上下文
3. **只输出生成的提示词文本，不要任何解释、标记或代码块包裹**

## 关联 Skill

生成逻辑全部在 `skills/awf-flow-exec-prompt/SKILL.md` 中：
- **提示词字典** — 按场景分类的方法论提示词，标注了适用阶段
- **阶段生成规则** — DEV/DEBUG/REVIEW/TEST/COMMIT/FINISH 的组装逻辑
- **风格铁律** — 9 条从用户历史蒸馏的风格约束
- **上下文装配** — 从 state.json 提取对应字段拼入 prompt
- **状态更新模板** — 每个阶段末尾的状态更新指令
