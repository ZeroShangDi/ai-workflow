# w-commit 增强 & 工作流规范 — 需求文档

## 背景与目标

当前 `/w-commit` 仅覆盖了"分析变更 → 生成 message → 提交"的基本流程。实际开发中还需要：
- 提交前的质量核验（lint、typecheck、test）
- 版本号管理（npm version / git tag）
- 分支管理（创建 feature 分支、合并回主线）

同时，当前项目的 commands 和 skills 缺乏统一的设计规范，需要明确各自的职责边界和规模约束。

## 用户场景

1. **完整提交流程** — 开发完成一个功能后，执行 `/w-commit`，自动完成核验 → 版本判断 → 分支处理 → 提交 → 打 tag
2. **设计新命令/技能时参考规范** — 后续扩展时，查阅 `workflow-standards` skill 确定新功能应该做成 command 还是 skill

## 功能范围

- **包含**：
  - w-commit 增加提交前核验步骤（lint + typecheck + test）
  - w-commit 增加版本管理（自动判断 semver 级别、执行 npm version、打 git tag）
  - w-commit 增加分支管理（feature 分支创建、合并回主线）
  - 新增 `workflow-standards` skill：定义 command 和 skill 的职责边界、规模约束、设计原则

- **不包含**：
  - 自动 push（已有硬性规则禁止）
  - 复杂的多分支合并策略（rebase vs merge 决策由用户自己选择）

## 验收标准

- [ ] `/w-commit` 执行时先运行 lint + typecheck + test，全部通过后才进入提交
- [ ] `/w-commit` 支持 `--bump` 参数自动升级版本号并打 tag
- [ ] `/w-commit` 支持 `--branch <name>` 参数管理 feature 分支的创建和合并
- [ ] 新增 `workflow-standards` skill，定义 commands（≤150行）和 skills（≤300行）的规范
- [ ] 现有 commands 和 skills 的行数符合新规范
