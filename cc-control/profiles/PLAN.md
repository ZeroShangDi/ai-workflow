

## AWF-CLI 所需

一、commands

- w-start-plan/run 一次行命令，标记state.json 进入awf对应运行模式
- w-pause 一次行命令，标记暂停，用于暂停awf模式，进入人工介入状态
- w-monitor 一次行命令，用于相同目录下非tmux调用的cc建立对tmux中cc的loop检测机制并在合适的时机进行调整

- w-plan 主规划流程（归一化，需求澄清，现状分析，自由讨论，逐级产出）
- w-plan-wbs 一次性命令，生成wbs空间树，任务拆分在这里实现
- w-plan-tasks 一次性命令，生成tasks任务列表，门禁任务插入在这里实现
- w-plan-check 一次性命令，检查产出的state.json是否符合标准

- w-ui-design 设计原型界面，UI设计稿流程
- w-ui-code 按照原型稿实现静态页面流程
- w-doc 文档管理方法论
- w-dev 开发流程
- awf-run-reset 反复失败时的重开（回撤 + 复盘 + 重新探索实现，由 AI 判断调用）
- w-review 审查流程
- w-test 测试流程
- w-commit 提交流程
- w-debug 调试流程
- w-cicd 构建流程？
- w-performance 性能优化？
- w-security 安全与权限？
- w-estimate 工时预估方法论？
- w-onboard 新人、交接文档？（模仿员工离职的场景来解决模型上下文不足的场景）
- w-ask 提问求助流程？（规定“遇到阻塞性问题时，必须先整理好背景、尝试过的方法、具体阻塞点，再找人”）
- w-retro 项目复盘流程？（固定格式的“Stable（保持） + Improve（改进） + Experiment（尝试）”，专门用来沉淀踩坑经验）

二、skills

- awf-skill 项目内skill创建，修改，聚合，拆分等

- awf-answer cc回复时可能需要的一些沟通建议。

- awf-state mcp 的使用指南
- awf-state 数据模型解释说明（核心字段，扩展字段，运行时字段，关联字段）

- awf-plan-norm 规范化需求（目标/边界/场景/验收，输入归一化，结构化）
- awf-plan-wbs 生成wbs空间树的技能
- awf-plan-tasks 生成任务树
- awf-plan-prompt 在plan阶段生成wbs和tasks时填入任务中的提示词生成技能

- awf-run-error 当tmux的cc运行异常时的处理方案。
- awf-run-review 当tmux的cc运行审查时对审查结果的处理方案。
- awf-run-test 当tmux的cc运行测试时对测试结果的处理方案。
- awf-run-decision 当tmux的cc出现需要决策时的处理方案。

- code-context-onboard 跨阶段上下文传递格式、上下文压缩规则，用于开发接力

- code-doc-base 需求文档（必选）
- code-doc-test 测试用例（必选）
- code-doc-issues 项目问题中心
- code-doc-bugs 记录出现的bug以及产生原因，解决过程等
- code-doc-reuse 记录组件/代码/模块等可复用资源
- code-doc-decision 技术、架构、决策偏好记忆

- code-dev-cto 技术选项
- code-dev-rule 开发原则
- code-dev-design 设计模式
- code-dev-fallback 渐进增强与优雅降级
- code-dev-quilaty 高质量代码最佳实践
- code-dev-performance 性能优化最佳实践
- code-dev-security 防御性编程与安全实践
- code-dev-experience-vue vue最佳实践经验
- code-dev-experience-react react最佳实践经验
- code-dev-design-style 样式生成最佳实践经验
- code-dev-design-package 第三方依赖引入与使用
- code-dev-design-function 函数设计最佳实践经验
- code-dev-design-component 组件设计最佳实践经验
- code-dev-design-organization 代码组织最佳实践经验

- code-review-performance 性能分析
- code-review-security 安全漏洞检查
- code-review-quilaty 代码质量
- code-review-simplify 代码简化

- code-test-case AI生成测试用例

- code-commit-gitflow git使用说明
- code-commit-tag git版本管理

- code-ask-question 如何描述一个问题

- code-retro-point 如何进行项目复盘


三、MCP 协议

- awf-state 状态机（贯穿全流程的状态管理）



-------------
- 拆分第一性原理 ｜ 先确认维度，时间，空间，相关性。
- 不死板 ｜ 任务量评定（不一定拆到最后一级）
- 先收敛工作量 ｜ 范围需要优先锁定，技术细节到60%-70%，范围要百分百确认。其实应该也相当于验收标准。
- 踩坑记忆 ｜ 需要有学习闭环，同样的错误不犯第二次。
- 重开 ｜ 没有“撤销这个任务的所有变更回到干净状态”的选项
- 可观测性为零 │ 没有耗时统计、返工率、阶段通过率，无法判断流程瓶颈  