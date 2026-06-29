# 智能提交

分析当前变更，生成规范的 commit message 并提交。

## 参数

`$ARGUMENTS` — 可选的补充说明（如 `fix: 修复划词不生效的问题`）。留空则自动分析生成。

## 硬性规则

- **禁止附带 Co-Authored-By 签名**。任何时候都不在 commit message 末尾追加 AI 模型的 co-author 信息。
- **禁止自动 push**。提交后不推送到远端，由用户自行决定。

## 前置 Skill 调用

自动调用 `superpowers:verification-before-completion` skill — 提交前确认改动正确、lint 通过。

## 关联 Skill

提交规范遵循 **quality-standards** skill 中的 Conventional Commits 格式和小提交原则。

## 执行流程

1. **查看变更**：
   - `git status` 查看文件变更状态
   - `git diff` 和 `git diff --cached` 查看具体改动内容
   - `git log --oneline -10` 参考近期 commit 风格

2. **分析变更**：理解本次改动的性质和目的

3. **生成 commit message**：
   - 格式：`<type>: <简短中文描述>`
   - type 选择：`feat`（新功能）/ `fix`（修复）/ `refactor`（重构）/ `style`（样式）/ `docs`（文档）/ `chore`（杂项）/ `perf`（性能）
   - 如果改动较复杂，加上 body 详细说明

4. **暂存并提交**：
   - 精确 `git add` 相关文件（不用 `git add -A`）
   - 排除 `.env`、凭据等敏感文件
   - 执行 `git commit`

5. **验证提交**：`git log --oneline -3` 确认提交成功

## 注意

- 不自动 push 到远端
- 如果 pre-commit hook（lint-staged）失败，修复问题后重新提交（新建 commit，不 amend）
- 一次改动涉及多个不相关功能时，建议拆分为多次提交
