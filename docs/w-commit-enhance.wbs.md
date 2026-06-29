# w-commit 增强 & 工作流规范 — WBS

```
1. w-commit 增强 — 完整提交流程（≤150行）
   1.1 提交前核验 — 验收：执行时自动运行 lint → typecheck → test 三道检查
   1.2 分支管理 — 验收：支持 --branch 创建/切换 feature 分支、合并回主线
   1.3 版本管理 — 验收：支持 --bump 自动判断 semver 并执行 npm version + git tag

2. workflow-standards 技能 — 命令/技能设计规范（≤300行）
   2.1 技能创建 — 验收：包含职责边界、规模约束、设计原则三部分
   2.2 规范落地 — 验收：现有 commands 和 skills 行长符合新标准
```
