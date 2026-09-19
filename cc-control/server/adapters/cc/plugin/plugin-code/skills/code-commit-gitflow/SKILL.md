---
name: code-commit-gitflow
description: >
  Git 使用说明 + 版本管理 — 什么时候提交、怎么提交、什么时候打版本。
  触发条件：w-commit 命令或需要提交代码时。
  引用方：w-commit
---

# Git 工作流与版本管理

> 参考：Conventional Commits 规范、SemVer 语义化版本

## 一、分支策略（code-commit-gitflow）

### 默认：Trunk-Based（主干开发）

- `main` 永远可部署，每次合入都可能发布
- 功能分支**短命**：1-3 天内合回 main，长期分支是隐形成本（合并冲突越积越多）
- 未完成的工作用**特性开关**发布，而不是长期挂在分支上
- 适合高频发布 + 强 CI/CD 的团队（DORA 研究显示与高效团队强相关）

### 何时退回 GitFlow（main/develop/release/hotfix）

- 有排期发布、移动端发版、需同时维护多个生产版本
- 简单团队/小项目用 GitHub Flow（单 main + 短命分支 + PR 审查）即可，别上 GitFlow

## 二、提交规范（code-commit-gitflow）

### 提交时机

- 一个逻辑单元完成且通过本地验证
- 不要攒一堆不相关的改动一起提交

### 提交信息格式（Conventional Commits）

```
<type>(<scope>): <简短中文描述>

[body: 为什么改，不是改了什么]
[footer: BREAKING CHANGE: ...]
```

| type | 用途 | 版本影响 |
|------|------|---------|
| feat | 新功能 | 次版本 |
| fix | 修复 bug | 补丁版本 |
| perf | 性能优化 | 补丁版本 |
| refactor | 重构（无行为变化） | 无 |
| docs | 文档 | 无 |
| test | 测试 | 无 |
| chore | 构建/依赖/工具 | 无 |
| style | 格式（无逻辑变化） | 无 |
| ci | CI 配置 | 无 |

**破坏性变更**：`feat!:` 或在 footer 写 `BREAKING CHANGE: ...`，触发主版本。

### 提交原则

- **原子提交**：一个提交 = 一个可独立 review 的变更；提交信息需要"and"就拆
- **说明为什么**：diff 展示"改了什么"，信息解释"为什么这么改"
- **控制体积**：单提交 ~100 行、上限 ~1000 行；超过拆分
- 不把重构和功能混在一个提交里
- 不跳过 hooks；不修改已发布的提交历史
- 分支名：`<type>/<ticket>-<描述>`，如 `fix/LOGIN-321-redirect-bug`

### 合并与历史

- 开 PR 前先 rebase 到最新 main，提前暴露冲突
- 合入用 squash merge，保持 main 历史线性整洁
- 绝不 force-push 共享分支（必须时用 `--force-with-lease`）；绝不 force-push main

## 三、版本管理（code-commit-tag）

### 版本号（SemVer）

```
MAJOR.MINOR.PATCH

MAJOR: 破坏性变更
MINOR: 新增向后兼容功能
PATCH: Bug 修复
```

### 打版本时机

- 里程碑完成时
- 发布前
- 不提前打版本

### 变更日志

- 从 commit 历史自动生成（conventional-changelog / semantic-release）
- 按类型分组：Features / Fixes / Breaking Changes

## 四、自动化（可选）

- commitlint + Husky：提交信息格式校验
- CI：PR 校验提交信息、跑测试、分支保护（必审 + 状态检查 + 禁 force-push）
- semantic-release / changesets：从提交自动提升版本 + 生成 changelog
