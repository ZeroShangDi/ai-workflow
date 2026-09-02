# w-dev

开发流程。按照任务列表逐个执行开发任务。

## 关联 Skill

- **awf-task-context** — 统一读取并应用任务结构化字段
- **code-dev-rule** — 开发原则
- **code-dev-cto** — 技术选项
- **code-dev-design** — 设计模式（样式/函数/组件/代码组织/第三方依赖）
- **code-architecture** — 识别变化轴、判断何时重构、控制变更传播
- **code-dev-quality** — 高质量代码最佳实践
- **code-dev-performance** — 性能优化最佳实践
- **code-dev-security** — 防御性编程与安全实践
- **code-dev-fallback** — 渐进增强与优雅降级
- **code-dev-experience-vue** — Vue 最佳实践经验（决策取舍）
- **code-dev-experience-react** — React 最佳实践经验（决策取舍）

## 执行流程

1. 输入含 task ID 时，先按 awf-task-context 获取目标、范围、约束和验收；普通交互调用直接使用用户目标
2. 探索相关代码上下文，并读取 `.awf/context/architecture.md`（存在时）
3. 按 code-architecture 判断 `extend` / `refactor-then-change` / `split`；`split` 时停止并上抛，不带病实现
4. 实现首个纵向切片，复查变更是否沿预期边界传播，再完成剩余实现
5. 自检 / lint / 构建验证
6. 完成后主动收尾：`awf_task_complete` 原子记录状态、结果、文件和 architecture；未完成则不要标 done，继续做或标 blocked

## 重开机制

当连续多次修复无法收敛时，引用 **awf-run-reset** 进行回撤 + 复盘 + 重新探索实现。
