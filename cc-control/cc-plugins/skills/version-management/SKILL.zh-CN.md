---
name: version-management
description: >
  语义化版本管理方法论。定义何时及如何升级版本号、tag 命名规范、从 conventional commits 自动判断级别的规则。
  由 w-commit 在版本/tag 步骤中引用。触发场景："版本管理"、"semver"、"打 tag"、"升级版本"、"发布管理"。
---

# 版本管理 — 语义化版本与 Tag

此 skill 定义版本管理的方法论。命令（w-commit）引用此 skill，不内联版本规则。

## Semver 核心规则

给定 `MAJOR.MINOR.PATCH`（如 `1.4.2`）：

| 级别 | 触发条件 | 示例 |
|------|---------|------|
| **MAJOR** | 破坏性变更 — API 移除、行为不兼容的改变 | `1.4.2` → `2.0.0` |
| **MINOR** | 新增功能，向后兼容 | `1.4.2` → `1.5.0` |
| **PATCH** | Bug 修复、性能优化、重构（API 不变） | `1.4.2` → `1.4.3` |

1.0.0 之前（0.x.y）：将 MINOR 视为可能破坏性变更，可自由升级 MINOR。

## 从 Conventional Commits 自动判断

当 `--bump` 不带明确级别时，从上一次 tag 以来的提交信息推导：

| 提交类型 | Semver 级别 |
|---------|------------|
| `feat:` | **MINOR** |
| `fix:`、`perf:` | **PATCH** |
| `refactor:`、`docs:`、`style:`、`chore:`、`test:` | **PATCH**（默认） |
| 任意提交的 body 中含 `BREAKING CHANGE:` | **MAJOR**（覆盖所有） |

上次 tag 以来无 conventional commits → 默认 PATCH。

## Tag 规范

```
v<MAJOR>.<MINOR>.<PATCH>
```

示例：`v1.0.0`、`v2.3.1`、`v0.1.0`

Tag 为**附注标签**（`git tag -a`），消息总结上次 tag 以来的变更。

## 预发布版本

不稳定发布追加预发布标识：

```
v1.0.0-alpha.1
v1.0.0-beta.2
v1.0.0-rc.1
```

顺序：`alpha` → `beta` → `rc` → 正式发布。

## 执行步骤（由 w-commit 调用）

1. 从 `package.json`（或自动检测 `pyproject.toml`、`Cargo.toml`）读取当前版本
2. 判断升级级别：显式 `--bump <level>` > 从提交自动检测 > 默认 `patch`
3. 执行 `npm version <level>`（或对应包管理器）：
   - 升级包文件中的版本字段
   - 创建 `git tag -a v<新版本>` 附变更摘要
   - 提交版本升级（message: `chore: bump version to v<新版本>`）
4. 输出摘要：`版本升级: 1.4.2 → 1.5.0 (minor) — tag v1.5.0 已创建`

## 跳过版本升级

- 变更仅为 `docs:`、`style:`、`chore:` 且无用户可感知影响
- 上次 tag 以来无提交（无内容可发布）
- 显式设置 `--no-bump`

## 未来：用户配置

待用户设置系统实现后，以下将变为可配置：
- `version.autoBump`：`true`（默认）/ `false` — 是否自动升级版本
- `version.tagPrefix`：`v`（默认）— tag 前缀
- `version.preRelease`：`false`（默认）/ `alpha` / `beta` / `rc` — 预发布模式
