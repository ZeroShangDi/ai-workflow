# 仓库提交绝对 node_modules 符号链接导致 worktree 不可安装

- 状态: fixed-in-recovery-branch
- 严重度: high
- 发现: 2026-09-09 恢复审计

## 现象与根因

`cc-control/node_modules` 被 Git 跟踪为绝对符号链接，目标是旧环境的 `/Users/shangjunhao/.../node_modules`。新 worktree 中该链接断开，`pnpm install` 创建目录时报 `ENOTDIR`，测试无法启动。

仓库根 `.gitignore` 已忽略 `node_modules/`，因此该符号链接不应被版本控制。

## 本轮处理

- 从恢复分支删除已跟踪的绝对符号链接。
- 依据当前 `package.json` 安装本地依赖。
- 同步漂移的 `pnpm-lock.yaml`；后续以 frozen lockfile 作为环境门禁。

## 防回归

- CI 增加 `git ls-files node_modules` 必须为空。
- CI 使用 `pnpm install --frozen-lockfile`，锁文件漂移直接失败。
- 禁止提交指向开发机绝对路径的符号链接。
