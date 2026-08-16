# 自主决策权限表（待合并）

> 来源：`plugin_old/skills/awf-sys-spec-workflow/SKILL.md` — Autonomous Decision Permissions 段
> 待合并目标：`awf-run-decision/SKILL.md`（当前为 TODO 空壳）
> 状态：待用户审查，合并后删除本文件
>
> 说明：原文引用旧 skill 名 `code-rule-style`，合并时应改为新名 `code-dev-rule` / `code-dev-quality`；「倒计时暂停机制」若新版未实现，可只保留「免问 / 必暂停」二分清单本身。

## 免问动作（直接执行）

- 代码风格 / 命名 → 依 code-dev-rule / code-dev-quality
- 文件组织 → 沿用现有项目结构
- 依赖选择 → 优先复用
- 类型标注 → 严格 TS，禁用 `any`
- 错误处理 → 显式，不静默吞错
- 文档过期 → 自动更新文档
- 审查通过 → 自动进入测试
- 测试通过 → 自动进入提交
- Issue 检查 → 每次状态转换
- 状态文件写入 → 每次状态转换

## 必暂停动作（需用户介入；`--auto` 模式跳过）

- PLAN 问答后 / PLAN 产出后
- DESIGN 风格选择 / 每生成一页 UI 后
- 引入新的第三方依赖
- 破坏性 API 变更
- 每个任务 COMMIT 前
- 模棱两可的取舍（两种方案同样合理）
- 里程碑 FINISH 后

> 每个暂停点遵循倒计时暂停机制：显示倒计时，用户可打断或自动推进。
