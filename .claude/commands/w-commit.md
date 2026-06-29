# 智能提交

自动完成提交门控检查、版本判断、分支管理、生成 commit 并打 tag 的完整提交流程。

w-commit 不负责判断代码是否具备提交条件——该职责由 w-dev / w-review / w-test 承担。本命令仅检查 `.claude/awf-state.json` 中的 `canCommit` 标记。详见 **awf-spec** skill 中的"提交门控"章节。

## 参数

| 参数 | 说明 |
|------|------|
| `--bump [major\|minor\|patch]` | 提交后升级版本号并打 tag。留空自动从 commit 推导 |
| `--no-bump` | 跳过版本升级和 tag |
| `--branch <name>` | 在指定 feature 分支上操作，默认按 git-flow 自动创建 |
| `--no-branch` | 跳过分支管理，直接在当前分支提交 |
| `<直接输入>` | 手动指定 commit message，留空自动生成 |

示例：
- `/w-commit` — 全自动：门控检查 → 版本判断 → 分支管理 → 提交 → tag
- `/w-commit --no-bump` — 跳过版本和 tag
- `/w-commit feat: 新增搜索功能` — 手动指定 message，其余自动

## 硬性规则

- **禁止 Co-Authored-By 签名**
- **禁止自动 push**

## 关联 Skill

- **version-management** — 语义化版本方法论：semver 规则、自动判断级别、tag 规范
- **git-flow** — 分支管理模型：feature/release/hotfix 工作流、命名规范
- **quality-standards** — Conventional Commits 格式、小提交原则
- **workflow-standards** — 命令/技能规模约束

## 前置 Skill 调用

自动调用 `superpowers:verification-before-completion` skill。

## 执行流程

### 1. 前置检查 — `canCommit` 标记

检查 `.claude/awf-state.json`：

- **存在且 `canCommit == true`** → 继续
- **存在且 `canCommit == false`** → 拒绝："当前未达到可提交状态，请先通过 w-test 验证。"
- **不存在** → 询问用户："未检测到 awf 工作流状态，是否继续提交？"
  - 用户选"继续" → 跳过检查
  - 用户选"取消" → 中止

### 2. 分析

- `git status` + `git diff` + `git log --oneline -10`
- 理解本次变更的性质和范围

### 3. 版本判断（`--no-bump` 跳过）

遵循 **version-management** skill：

1. 读取 `package.json` 当前版本
2. 判断升级级别：显式 `--bump <level>` > 从 commit 自动推导 > 默认 patch
3. 跳过场景：仅 docs/style/chore 且无用户影响、无新提交、显式 `--no-bump`

### 4. 分支管理（`--no-branch` 跳过）

遵循 **git-flow** skill，默认使用简化模式：

1. `--branch <name>` 指定 → 切换到该 feature 分支
2. 未指定 → 自动从 commit type 推导是否需要 feature 分支（`feat:` → 创建 `feature/<desc>`）
3. 分支不存在则从当前分支创建，已存在则切换
4. 提交完成后合并回源分支（`--no-ff`）

### 5. 提交

- 生成 Conventional Commits message（未手动指定时）
- 精确 `git add` 相关文件
- `git commit`
- 提交成功后：若存在 `awf-state.json`，设 `canCommit = false`

### 6. 打 Tag

遵循 **version-management** skill：

1. 执行 `npm version <level>` — 升级版本号 + 创建附注 tag
2. Tag 格式：`v<MAJOR>.<MINOR>.<PATCH>`
3. 版本升级本身作为独立 commit：`chore: bump version to vX.Y.Z`

### 7. 完成

输出摘要：

```
✓ 提交完成
  Commit: feat: 新增搜索功能 (a1b2c3d)
  版本: 1.4.2 → 1.5.0 (minor)
  Tag: v1.5.0
  分支: feature/search → develop (merged --no-ff)
```

## 注意

- `--bump` 和 `--branch` 可组合使用
- 分支合并仅 fast-forward 安全时自动执行，有冲突提示手动处理
- pre-commit hook 失败 → 修复后新建 commit，不 amend
- 一次改动涉及多个不相关功能 → 拆分为多次提交
- 非 awf-run 工作流（无状态文件）亦可使用，会在前置检查时询问确认

## 未来：用户配置

功能稳定后将支持在 `.claude/user/` 中配置：

```json
{
  "commit": {
    "autoBump": true,
    "autoBranch": true,
    "gitFlowMode": "simplified"
  }
}
```
