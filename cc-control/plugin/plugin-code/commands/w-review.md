# w-review

审查流程。对开发产出进行多维度审查。

## 关联 Skill

- **awf-task-context** — 统一读取并应用任务结构化字段
- **code-review-quality** — 代码质量
- **code-review-security** — 安全漏洞检查
- **code-review-performance** — 性能分析
- **code-review-simplify** — 代码简化
- **code-review-architecture** — 变化轴、模块边界和变更传播审查

## 审查维度

1. 正确性 — 逻辑是否正确，边界是否覆盖
2. 安全性 — 注入、XSS、密钥泄露、权限
3. 性能 — N+1、内存泄漏、不必要的重渲染
4. 可维护性 — 命名、结构、重复代码
5. 架构 — 变化是否集中在正确边界，重构时机是否合理
6. 规范 — 是否符合 code-dev-* 系列定义的规则

输入含 task ID 时，先按 awf-task-context 确定审查目标、范围、硬约束和通过条件。

## 审查输出

- 问题列表（严重程度 + 修复建议）
- 简化建议（哪些可以更简单）
- 架构结论必须进入门禁 verdict；非 pass 时给出变化轴、边界证据和修复方向
