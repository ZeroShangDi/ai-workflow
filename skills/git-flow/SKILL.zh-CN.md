---
name: git-flow
description: >
  Git Flow 分支管理模型。定义分支命名规范、feature/release/hotfix 工作流和合并规则。
  由 w-commit 在分支管理步骤中引用。触发场景："分支策略"、"git flow"、"feature 分支"、"release 分支"、"hotfix"。
---

# Git Flow — 分支管理模型

此 skill 定义默认的 Git Flow 分支管理模型。命令（w-commit）引用此 skill 进行分支操作。

## 分支架构

```
main        ●───●─────────●─────────●───  (生产发布)
            │             │         │
develop     ●───●───●─────●───●─────●───  (集成)
                  │         │
feature/*   ●─────●         │            (功能开发)
                            │
release/*         ●─────────●            (发布准备)
                              │
hotfix/*                     ●───────────  (紧急修复)
```

## 分支类型

| 分支 | 用途 | 命名 | 生命周期 |
|--------|------|------|----------|
| `main` | 生产就绪代码。每个 commit 即一个 release。 | 固定 | 永久 |
| `develop` | 集成分支。feature 分支合并到这里。 | 固定 | 永久 |
| `feature/*` | 新功能。从 `develop` 分出，合并回 `develop`。 | `feature/<kebab-case>` | 合并后删除 |
| `release/*` | 发布准备。从 `develop` 分出，合并到 `main` 和 `develop`。 | `release/v<版本号>` | 合并后删除 |
| `hotfix/*` | 紧急线上修复。从 `main` 分出，合并到 `main` 和 `develop`。 | `hotfix/<kebab-case>` | 合并后删除 |

## Feature 分支工作流

w-commit 在任务为新增功能时调用：

1. **创建**：`git checkout -b feature/<名称> develop`（若无 develop 则从当前分支创建）
2. **开发**：在 feature 分支上自由提交
3. **完成**：`git checkout develop && git merge --no-ff feature/<名称>` — 始终使用 `--no-ff` 保留分支历史
4. **清理**：`git branch -d feature/<名称>`

若项目尚无 `develop`，从 `main` 创建：`git checkout -b develop main`。

## Release 分支工作流

里程碑完成、准备发布时调用：

1. **创建**：`git checkout -b release/v<版本> develop`
2. **稳定化**：升级版本、最终修复、更新 changelog — 不添加新功能
3. **完成**：
   - `git checkout main && git merge --no-ff release/v<版本>`
   - `git tag -a v<版本> -m "Release v<版本>"`
   - `git checkout develop && git merge --no-ff release/v<版本>`
4. **清理**：`git branch -d release/v<版本>`

## Hotfix 工作流

紧急线上修复时调用：

1. **创建**：`git checkout -b hotfix/<名称> main`
2. **修复**：提交修复（升级 PATCH 版本）
3. **完成**：
   - `git checkout main && git merge --no-ff hotfix/<名称>`
   - `git tag -a v<版本> -m "Hotfix v<版本>"`
   - `git checkout develop && git merge --no-ff hotfix/<名称>`
4. **清理**：`git branch -d hotfix/<名称>`

## 分支命名规则

- 使用 kebab-case：`feature/user-auth`、`hotfix/login-crash`
- 名称简短有描述性
- 不允许空格和特殊字符（仅 `-` 和 `/`）
- 版本分支：`release/v1.2.0`、`release/v2.0.0-rc.1`

## 简化模式（小型项目）

小型项目或单人开发可用简化版：

- 跳过 `develop` — `feature/*` 从 `main` 分出，合并回 `main`
- 跳过 `release/*` — 合并后在 `main` 上直接打 tag
- 保留 `hotfix/*` 用于紧急修复

团队人数 > 1 建议使用完整 Git Flow。

## 未来：用户配置

待用户设置系统实现后：
- `gitFlow.mode`：`full` / `simplified`（默认） — 使用哪种流程
- `gitFlow.autoFeatureBranch`：`true`（默认）/ `false` — 是否自动为每个任务创建 feature 分支
- `gitFlow.deleteAfterMerge`：`true`（默认）/ `false` — 合并后是否自动删除分支
