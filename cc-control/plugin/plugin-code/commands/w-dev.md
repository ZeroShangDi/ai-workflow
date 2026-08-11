# w-dev

开发流程。按照任务列表逐个执行开发任务。

## 关联 Skill

- **code-dev-rule** — 开发原则
- **code-dev-cto** — 技术选项
- **code-dev-design** — 设计模式（样式/函数/组件/代码组织/第三方依赖）
- **code-dev-quality** — 高质量代码最佳实践
- **code-dev-performance** — 性能优化最佳实践
- **code-dev-security** — 防御性编程与安全实践
- **code-dev-fallback** — 渐进增强与优雅降级
- **code-dev-experience-vue** — Vue 最佳实践经验（决策取舍）
- **code-dev-experience-react** — React 最佳实践经验（决策取舍）

## 执行流程

1. 读取当前 task 的执行提示词（awf-plan-prompt 产物）
2. 探索相关代码上下文
3. 按设计方案实现
4. 自检 / lint / 构建验证

## 重开机制

当连续多次修复无法收敛时，引用 **awf-run-reset** 进行回撤 + 复盘 + 重新探索实现。
