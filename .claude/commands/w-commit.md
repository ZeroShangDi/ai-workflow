# 智能提交

分析当前变更、核验质量、管理分支与版本，生成规范的 commit 并提交。

## 参数

`$ARGUMENTS` — 可选 flag 或补充说明：

| 参数 | 说明 |
|------|------|
| `--bump [major\|minor\|patch]` | 提交后升级版本号并打 tag。留空自动判断 semver 级别 |
| `--branch <name>` | 在 feature 分支上操作：不存在则创建，存在则切换。提交后合并回主线 |
| `--dry-run` | 预览模式：展示将要执行的步骤但不实际提交 |
| `<直接输入>` | 手动指定 commit message（如 `fix: 修复缓存过期问题`），留空自动生成 |

示例：
- `/w-commit` — 标准提交流程，自动分析变更生成 message
- `/w-commit --bump patch` — 提交后升级 patch 版本号并打 tag
- `/w-commit --branch feat/cache` — 创建/切换到 feat/cache 分支后提交，合并回 main

## 硬性规则

- **禁止附带 Co-Authored-By 签名**
- **禁止自动 push**

## 前置 Skill 调用

自动调用 `superpowers:verification-before-completion` skill。

## 关联 Skill

遵循 **quality-standards** skill（Conventional Commits、小提交原则）和 **workflow-standards** skill（命令/技能规模约束）。

## 执行流程

### 步骤 0：提交前核验

提交前必须通过以下检查，任一失败则中止提交：

1. `pnpm lint`（或 `tsc --noEmit`）— 零错误
2. `pnpm typecheck` — 零类型错误
3. `pnpm test` — 存量测试全部通过（无测试脚本则跳过）

核验通过后显示：`✓ 核验通过: lint / typecheck / test`

### 步骤 1：分支管理（仅 --branch）

1. 检查当前是否已有未提交变更，如有则先 stash
2. 目标分支 `$branch` 不存在 → 从当前分支创建并切换
3. 目标分支已存在 → 切换到该分支
4. 如有 stash → `git stash pop`
5. 提交完成后 → 切回原分支 → `git merge $branch`（fast-forward）

### 步骤 2：分析变更

1. `git status` — 文件变更状态
2. `git diff` + `git diff --cached` — 具体改动内容
3. `git log --oneline -10` — 参考近期 commit 风格

### 步骤 3：生成 commit message

- 格式：`<type>: <简短中文描述>`
- type：`feat` / `fix` / `refactor` / `style` / `docs` / `chore` / `perf`
- 复杂改动追加 body 说明

### 步骤 4：暂存并提交

- 精确 `git add` 相关文件，不用 `git add -A`
- 排除 `.env`、凭据等敏感文件
- `git commit`

### 步骤 5：版本管理（仅 --bump）

1. 从 `package.json` 读取当前版本
2. `--bump` 未指定级别 → 根据 commit type 自动判断：
   - `feat` → `minor`，`fix` / `perf` → `patch`，`refactor` / 含 BREAKING CHANGE → `major`
3. 执行 `npm version <level>` — 自动升级版本号 + 打 git tag
4. 输出：`✓ 版本升级: 1.0.0 → 1.0.1 (patch)`

### 步骤 6：验证

`git log --oneline -3` 确认提交成功。

## 注意

- pre-commit hook 失败时修复后新建 commit，不 amend
- 一次改动涉及多个不相关功能时拆分为多次提交
- 分支合并仅使用 fast-forward 策略，冲突时提示用户手动处理
- `--bump` 和 `--branch` 可组合使用
