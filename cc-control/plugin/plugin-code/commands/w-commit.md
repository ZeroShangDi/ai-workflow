# w-commit

提交流程。将通过审查和测试的代码提交到版本库。

## 关联 Skill

- **awf-task-context** — 输入含 task ID 时统一读取任务范围、约束和验收
- **code-commit-gitflow** — git 使用说明 + 版本管理

## 硬性规则

- **禁止 Co-Authored-By 签名**
- **禁止自动 push**
- **禁止盲 add**（`git add -A` / `git add .`）—— 必须精确指定本次提交的目标文件

## awf 模式检查

独立于提交流程的前置门控，仅在 awf 工作流（`.awf/state.json`）存在且处于 run 模式时生效：

1. 检查 `.awf/state.json` 是否存在
   - 不存在 → 跳过本检查，进入提交流程
2. 存在 → 读取 `mode` 字段
   - `mode != "run"` → 跳过本检查，进入提交流程
3. `mode == "run"` → 检查 `canCommit` 字段
   - `canCommit == true` → 进入提交流程；**提交完成后将 `canCommit` 改回 `false`**
   - 其他（false / 缺失） → **中止提交流程**，提示先通过 w-test 验证

## 提交流程

1. 检查变更性质与范围（git diff / git status / git log --oneline -10）
   - 无变更（工作区干净） → **中止**，提示无改动可提交
2. 确认不包含敏感文件（.env、credentials 等）
3. 按「一件事」判定逻辑分组（见下）
4. 生成 conventional commit 信息
5. 精确 add 目标文件 + 执行提交（不跳过 hooks）
6. 输出提交摘要（commit hash + message）

## 「一件事」判定逻辑

判断一组改动是否构成一个提交：

1. **动机归组**：对每个改动文件问「为什么改它」，答案相同的归为一组
2. **独立回滚**：这组改动能否独立 revert 而不破坏其他功能？能 → 粒度合适
3. **type 校验**：同一提交的 conventional type 应唯一——`feat`/`fix`/`refactor` 共存即提示该拆

该拆的信号：

- 一次改动涉及多个不相关功能 → 拆分为多次提交
- 跨模块边界（如 API 定义 + 前端样式）混在同一提交

该合的信号：

- 接口 + 实现 + 调用方是同一改动的不同侧面，拆开任何一中间态都编译不过

## 提交信息格式

```
<type>: <简短中文描述>

[可选 body — 解释为什么，不是做了什么]
```

`<type>` 可选值（与 **code-commit-gitflow** 定义一致）：

| type | 含义 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修复 |
| `refactor` | 重构（不改变行为） |
| `perf` | 性能优化 |
| `docs` | 文档 |
| `test` | 测试 |
| `chore` | 杂务（构建、工具等） |
| `style` | 格式化（无逻辑变更） |
| `ci` | 持续集成 |

## 原则

- 原子提交：每个提交可独立 review、独立 revert
- Hook 失败 → 修问题 → 新建提交（不使用 amend）
- 不强制推送 main/master
