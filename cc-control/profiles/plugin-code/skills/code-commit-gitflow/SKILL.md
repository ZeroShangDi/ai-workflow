---
name: code-commit-gitflow
description: >
  Git 使用说明 + 版本管理 — 什么时候提交、怎么提交、什么时候打版本。
  触发条件：w-commit 命令或需要提交代码时。
  引用方：w-commit
---

# Git 工作流与版本管理

## 一、提交规范（code-commit-gitflow）

### 提交时机

- 一个逻辑单元完成且通过本地验证
- 不要攒一堆不相关的改动一起提交

### 提交信息格式

```
<type>: <简短中文描述>

type: feat / fix / refactor / perf / docs / test / chore / style / ci
```

### 提交原则

- 原子提交：一个提交 = 一个可独立 review 的变更
- 不跳过 hooks
- 不修改已发布的提交历史

---

## 二、版本管理（code-commit-tag）

### 版本号

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

- 从 commit 历史自动生成
- 按类型分组：Features / Fixes / Refactoring
