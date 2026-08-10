# 命令与技能清单

> **状态由用户手动维护**，AI 不修改本文件状态。已存在标记 `[x]`，待建标记 `[ ]`。
>
> 目录约定：
> - `commands/` — 通用命令
> - `runtime-commands/` — awf 特有命令
> - `prompts/` — 提示词模板命令
> - `skills/` — 通用技能
> - `runtime-skills/` — awf 特有技能

## 命令

### commands/（通用）

- [💡] w-commit — 提交流程
- [x] w-debug — 调试流程
- [x] w-dev — 开发流程
- [x] w-doc — 文档管理方法论
- [x] w-review — 审查流程
- [x] w-test — 测试流程
- [x] w-ui-code — 按原型稿实现静态页面
- [x] w-ui-design — 设计原型界面

### runtime-commands/（awf 特有）

- [💡] w-plan — 主规划流程
- [x] w-start — 标记进入 awf 运行模式
- [x] w-pause — 标记暂停，进入人工介入
- [x] w-monitor — tmux 循环检测机制

### prompts/（提示词模板）

- [x] w-plan-check — 检查产出的 state.json 是否符合标准
- [x] w-plan-tasks — 生成任务列表
- [x] w-plan-wbs — 生成 WBS 空间树

### 规划中（未建）

- [ ] w-cicd — 构建流程
- [ ] w-performance — 性能优化
- [ ] w-security — 安全与权限
- [ ] w-estimate — 工时预估方法论
- [ ] w-onboard — 新人、交接文档
- [ ] w-ask — 提问求助流程
- [ ] w-retro — 项目复盘流程

## 技能

### skills/（通用）

- [x] code-ask-question — 如何描述一个问题
- [x] code-commit-gitflow — Git 使用说明
- [x] code-context-onboard — 跨阶段上下文传递格式
- [x] code-dev-cto — 技术选项
- [x] code-dev-design — 设计模式
- [x] code-dev-experience-react — React 最佳实践经验
- [x] code-dev-experience-vue — Vue 最佳实践经验
- [x] code-dev-fallback — 渐进增强与优雅降级
- [x] code-dev-performance — 性能优化最佳实践
- [x] code-dev-quality — 高质量代码最佳实践
- [x] code-dev-rule — 开发原则
- [x] code-dev-security — 防御性编程与安全实践
- [x] code-doc — 文档管理
- [x] code-retro-point — 项目复盘方法论
- [x] code-review-performance — 性能分析
- [x] code-review-quality — 代码质量
- [x] code-review-security — 安全漏洞检查
- [x] code-review-simplify — 代码简化
- [x] code-test-case — AI 生成测试用例

### runtime-skills/（awf 特有）

- [x] awf-plan-norm — 需求规范化
- [x] awf-plan-prompt — 执行提示词生成
- [x] awf-plan-tasks — 生成任务列表
- [💡] awf-plan-wbs — 生成 WBS 空间树
- [x] awf-run-decision — 运行时决策处理
- [x] awf-run-error — 运行时异常处理
- [x] awf-run-reset — 反复失败时重开（回撤 + 复盘 + 重新探索）
- [x] awf-run-review — 审查结果处理
- [x] awf-run-test — 测试结果处理
- [x] awf-skill — skill 创建/修改/聚合/拆分
- [x] awf-state — awf-state MCP 使用指南

### 规划中（未建）

- [ ] awf-answer — 沟通建议
- [ ] code-commit-tag — Git 版本管理
- [ ] code-doc-base — 需求文档
- [ ] code-doc-test — 测试用例
- [ ] code-doc-issues — 项目问题中心
- [ ] code-doc-bugs — Bug 记录
- [ ] code-doc-reuse — 可复用资源
- [ ] code-doc-decision — 技术/架构决策记忆
- [ ] code-dev-design-style — 样式生成最佳实践
- [ ] code-dev-design-package — 第三方依赖引入与使用
- [ ] code-dev-design-function — 函数设计最佳实践
- [ ] code-dev-design-component — 组件设计最佳实践
- [ ] code-dev-design-organization — 代码组织最佳实践
