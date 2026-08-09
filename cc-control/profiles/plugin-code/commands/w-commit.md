# w-commit

提交流程。将通过审查和测试的代码提交到版本库。

## 关联 Skill

- **code-commit-gitflow** — git 使用说明 + 版本管理

## 提交流程

1. 检查变更范围（git diff / git status）
2. 确认不包含敏感文件（.env、credentials 等）
3. 按逻辑分组（一个提交只做一件事）
4. 生成 conventional commit 信息
5. 执行提交（不跳过 hooks）

## 提交信息格式

```
<type>: <简短中文描述>

[可选 body — 解释为什么，不是做了什么]
```

## 原则

- 原子提交：每个提交可独立 review、独立 revert
- Hook 失败 → 修问题 → 新建提交（不使用 amend）
- 不强制推送 main/master
