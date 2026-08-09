# w-review

审查流程。对开发产出进行多维度审查。

## 关联 Skill

- **code-review-quality** — 代码质量
- **code-review-security** — 安全漏洞检查
- **code-review-performance** — 性能分析
- **code-review-simplify** — 代码简化

## 审查维度

1. 正确性 — 逻辑是否正确，边界是否覆盖
2. 安全性 — 注入、XSS、密钥泄露、权限
3. 性能 — N+1、内存泄漏、不必要的重渲染
4. 可维护性 — 命名、结构、重复代码
5. 规范 — 是否符合 code-dev-* 系列定义的规则

## 审查输出

- 问题列表（严重程度 + 修复建议）
- 简化建议（哪些可以更简单）
