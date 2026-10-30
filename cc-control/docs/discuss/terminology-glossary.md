# 软件开发专有名词术语表

## 一、核心思想 / 方法论

| 术语 | 说明 |
|------|------|
| Agile / 敏捷开发 | 迭代式开发方法论 |
| Scrum | 敏捷框架，Sprint、Daily Standup、Retro |
| Kanban / 看板 | 可视化工作流管理 |
| Waterfall / 瀑布模型 | 线性顺序开发模型 |
| TDD / 测试驱动开发 | 先写测试再写代码 |
| BDD / 行为驱动开发 | 用业务语言描述测试 |
| DDD / 领域驱动设计 | 以业务领域为核心建模 |
| CI/CD | 持续集成 / 持续交付 |
| DevOps | 开发运维一体化 |
| Git Flow | 分支管理模型（feature/release/hotfix） |
| Trunk-Based Development | 主干开发 |
| Shift Left | 测试左移，越早发现问题成本越低 |
| 12-Factor App | 云原生应用方法论 |
| SOLID | 面向对象五项设计原则 |
| KISS | Keep it simple, stupid |
| YAGNI | You aren't gonna need it |
| DRY | Don't repeat yourself |
| Clean Architecture | 整洁架构（同心圆分层） |
| Hexagonal Architecture | 六边形架构（端口-适配器） |
| Event Sourcing | 事件溯源 |
| CQRS | 命令查询职责分离 |
| MECE | 相互独立、完全穷尽（任务分解原则） |
| WBS / 工作分解结构 | Work Breakdown Structure |
| MVP / 最小可行产品 | Minimum Viable Product |
| Prototyping / 原型法 | 快速构建原型验证想法 |
| Incremental Development | 增量式开发 |
| Iterative Development | 迭代式开发 |
| Conway's Law | 康威定律，系统架构反映组织沟通结构 |
| Pareto Principle | 二八定律 |
| CAP Theorem | 一致性、可用性、分区容错不可兼得 |
| SLA / SLO / SLI | 服务等级协议 / 目标 / 指标 |
| IaC / 基础设施即代码 | Infrastructure as Code |
| GitOps | 以 Git 为唯一真相源的运维模式 |
| Platform Engineering | 平台工程 |
| Inner Source | 内部开源 |
| Tech Debt / 技术债 | 短期方案带来的长期成本 |
| Refactoring / 重构 | 不改变外部行为的前提下改善内部结构 |
| Boy Scout Rule | 离开时比来时更干净 |

## 二、架构 / 设计模式

| 术语 | 说明 |
|------|------|
| Monolith / 单体架构 | 单一部署单元 |
| Microservices / 微服务 | 独立部署的小型服务 |
| SOA / 面向服务架构 | Service-Oriented Architecture |
| Serverless | 无服务器架构 |
| Event-Driven Architecture | 事件驱动架构 |
| MVC | Model-View-Controller |
| MVP | Model-View-Presenter |
| MVVM | Model-View-ViewModel |
| Observer Pattern | 观察者模式（发布-订阅） |
| Factory Pattern | 工厂模式 |
| Singleton | 单例模式 |
| Strategy Pattern | 策略模式 |
| Decorator Pattern | 装饰器模式 |
| Adapter Pattern | 适配器模式 |
| Facade Pattern | 外观模式 |
| Repository Pattern | 仓储模式 |
| Unit of Work | 工作单元模式 |
| Dependency Injection / DI | 依赖注入 |
| IoC / 控制反转 | Inversion of Control |
| Sidecar Pattern | 边车模式（如 Envoy） |
| Circuit Breaker | 熔断器模式 |
| Bulkhead | 隔舱模式 |
| Retry / Backoff | 重试与退避策略 |
| Saga Pattern | 分布式事务的 Saga 模式 |
| Outbox Pattern | 发件箱模式 |
| Strangler Fig Pattern | 绞杀榕模式（渐进式迁移） |
| Feature Flag / Toggle | 特性开关 |
| Blue-Green Deployment | 蓝绿部署 |
| Canary Release | 金丝雀发布 |
| Rolling Update | 滚动更新 |
| A/B Testing | A/B 测试 |
| Anti-Corruption Layer | 防腐层 |
| Bounded Context | 限界上下文 |
| Aggregate / Entity / Value Object | 聚合 / 实体 / 值对象 |
| API Gateway | API 网关 |
| BFF / Backend for Frontend | 面向前端的后端 |
| Service Mesh | 服务网格 |
| State Machine | 状态机 |

## 三、专项技术

### 3.1 前端

| 术语 | 说明 |
|------|------|
| SPA / 单页应用 | Single Page Application |
| SSR / 服务端渲染 | Server-Side Rendering |
| SSG / 静态站点生成 | Static Site Generation |
| CSR / 客户端渲染 | Client-Side Rendering |
| ISR / 增量静态再生 | Incremental Static Regeneration |
| Hydration | 水合（SSR 后激活客户端交互） |
| Virtual DOM | 虚拟 DOM |
| Reactive Programming | 响应式编程 |
| Bundler / 打包器 | Webpack, Vite, esbuild, Turbopack |
| Tree Shaking | 死代码消除 |
| Code Splitting | 代码分割 |
| Lazy Loading | 懒加载 |
| JAMstack | JavaScript + API + Markup |
| Web Components | 自定义元素 + Shadow DOM |
| Micro Frontend | 微前端 |
| CSS-in-JS | CSS Modules, styled-components |
| Design System | 设计系统 |
| Design Tokens | 设计令牌 |
| Atomic Design | 原子设计（Atoms → Molecules → Organisms） |
| Responsive / Adaptive | 响应式 / 自适应 |
| a11y / 可访问性 | Accessibility |
| i18n / l10n | 国际化 / 本地化 |
| PWA / 渐进式 Web 应用 | Progressive Web App |
| WebAssembly / Wasm | 浏览器中的低级字节码 |
| Core Web Vitals | LCP, FID, CLS |

### 3.2 后端

| 术语 | 说明 |
|------|------|
| REST / RESTful | 表述性状态转移 |
| GraphQL | 声明式数据查询语言 |
| gRPC | 高性能 RPC 框架 |
| WebSocket | 全双工通信协议 |
| SSE / Server-Sent Events | 服务器推送事件 |
| Message Queue | 消息队列（RabbitMQ, Kafka） |
| Pub/Sub | 发布-订阅模式 |
| Stream Processing | 流处理 |
| Batch Processing | 批处理 |
| CRUD | Create-Read-Update-Delete |
| Idempotency | 幂等性 |
| Rate Limiting | 限流 |
| Throttling | 节流 |
| Pagination | 分页（Offset / Cursor-based） |
| Serialization / Deserialization | 序列化 / 反序列化 |
| Middleware | 中间件 |
| JWT | JSON Web Token |
| OAuth 2.0 | 开放授权协议 |
| OIDC / OpenID Connect | 身份认证层 |
| RBAC / ABAC | 基于角色 / 属性的访问控制 |
| CSRF | 跨站请求伪造 |
| XSS | 跨站脚本攻击 |
| SQL Injection | SQL 注入攻击 |
| CORS | 跨域资源共享 |
| TLS / mTLS | 传输层安全 / 双向 TLS |
| Zero Trust | 零信任安全模型 |

### 3.3 数据 / 存储

| 术语 | 说明 |
|------|------|
| RDBMS | 关系型数据库（MySQL, PostgreSQL） |
| NoSQL | 非关系型（MongoDB, Redis, Cassandra） |
| OLTP / OLAP | 在线事务处理 / 在线分析处理 |
| ACID | 原子性、一致性、隔离性、持久性 |
| BASE | 基本可用、软状态、最终一致 |
| Sharding / 分片 | 数据水平拆分 |
| Partitioning | 分区 |
| Replication | 主从复制 |
| Normalization / Denormalization | 规范化 / 反规范化 |
| Indexing | 索引（B-Tree, Hash, GIN, GiST） |
| Connection Pooling | 连接池 |
| ORM / 对象关系映射 | Object-Relational Mapping |
| Migration | 数据库迁移 |
| CDC / 变更数据捕获 | Change Data Capture |
| Data Lake / Data Warehouse | 数据湖 / 数据仓库 |
| ETL / ELT | Extract-Transform-Load |
| Vector Database | 向量数据库 |
| Embedding | 嵌入向量 |
| RAG / 检索增强生成 | Retrieval-Augmented Generation |

### 3.4 AI / LLM

| 术语 | 说明 |
|------|------|
| LLM / 大语言模型 | Large Language Model |
| Prompt Engineering | 提示工程 |
| Few-shot / Zero-shot | 少样本 / 零样本 |
| Chain of Thought / CoT | 思维链 |
| Tool Use / Function Calling | 工具调用 |
| Agent / Agentic | 智能体 / 自主式 |
| RAG | 检索增强生成 |
| Token / Context Window | 令牌 / 上下文窗口 |
| Embedding / 向量化 | 文本转向量 |
| Fine-tuning / 微调 | 模型微调 |
| RLHF | 基于人类反馈的强化学习 |
| Hallucination / 幻觉 | 模型生成不实内容 |
| Guardrails | 安全护栏 |
| MCP / Model Context Protocol | 模型上下文协议 |
| System Prompt | 系统提示词 |
| Temperature / Top-P | 采样参数 |
| Prompt Caching | 提示词缓存 |
| Streaming | 流式输出 |
| Multimodal | 多模态（文本+图像+音频） |

## 四、工程质量

| 术语 | 说明 |
|------|------|
| Unit Test / 单元测试 | 测试最小功能单元 |
| Integration Test / 集成测试 | 测试模块间交互 |
| E2E Test / 端到端测试 | 模拟真实用户操作 |
| Smoke Test / 冒烟测试 | 基本功能快速验证 |
| Regression Test / 回归测试 | 确保修改未破坏已有功能 |
| Performance Test / 性能测试 | 负载 / 压力 / 并发测试 |
| Test Pyramid | 测试金字塔（70/20/10 比例） |
| Test Fixture | 测试夹具 |
| Mock / Stub / Spy / Fake | 测试替身分类 |
| Code Coverage | 代码覆盖率 |
| Mutation Testing | 变异测试 |
| Static Analysis | 静态分析（ESLint, Pylint） |
| Linter / Formatter | 代码检查 / 格式化 |
| Pre-commit Hook | 提交前钩子 |
| Conventional Commits | 规范化提交信息 |
| Semantic Versioning / SemVer | 语义化版本 |
| Changelog | 变更日志 |
| Code Review | 代码评审 |
| Pair Programming | 结对编程 |
| Rubber Duck Debugging | 小黄鸭调试法 |
| Root Cause Analysis / RCA | 根因分析 |
| Postmortem | 事后复盘 |
| Blameless Culture | 无指责文化 |
| Monitoring / Observability | 监控 / 可观测性 |
| Three Pillars: Logs, Metrics, Traces | 三大支柱 |
| APM / 应用性能监控 | Application Performance Monitoring |
| Alerting / On-Call | 告警 / 值班 |
| Runbook | 应急处置手册 |
| Incident Response | 事件响应 |
| Chaos Engineering | 混沌工程 |
| Error Budget | 错误预算 |
| MTTD / MTTR | 平均检测时间 / 平均恢复时间 |

## 五、协作 / 管理

| 术语 | 说明 |
|------|------|
| Sprint / Iteration | 迭代周期 |
| Standup / 站会 | 每日同步 |
| Retrospective / 回顾 | 迭代复盘 |
| Backlog Grooming / Refinement | 待办项梳理 |
| User Story / Epic | 用户故事 / 史诗 |
| Acceptance Criteria | 验收标准 |
| Definition of Done / DoD | 完成定义 |
| Story Point | 故事点（相对估算） |
| Velocity | 团队速率 |
| Burndown Chart | 燃尽图 |
| Roadmap | 路线图 |
| OKR / KPI | 目标与关键结果 / 关键绩效指标 |
| Spike | 技术调研 |
| RACI Matrix | 责任分配矩阵 |
| Stakeholder | 干系人 |
| RFC / Request for Comments | 技术方案征求意见 |
| ADR / Architecture Decision Record | 架构决策记录 |
| PRD / 产品需求文档 | Product Requirements Document |

## 六、通用缩写

| 缩写 | 全称 |
|------|------|
| PR | Pull Request |
| MR | Merge Request |
| LGTM | Looks Good To Me |
| WIP | Work In Progress |
| POC | Proof of Concept |
| FYI | For Your Information |
| TL;DR | Too Long; Didn't Read |
| AFAIK | As Far As I Know |
| IMO / IMHO | In My (Humble) Opinion |
| TIL | Today I Learned |
| SGTM | Sounds Good To Me |
| TBD | To Be Determined / Decided |
| N/A | Not Applicable |
| OOS | Out of Scope |
| Blocked / Blocker | 阻塞项 |
