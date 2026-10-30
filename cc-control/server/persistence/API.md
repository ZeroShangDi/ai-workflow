# Persistence API

本文件是 `server/persistence/index.cjs` 对外公开接口的使用说明。调用方只依赖这里列出的 API；不要直接导入 `api/`、`repositories/` 或 `database.cjs` 内部文件。

数据模型、实体关系与持久化边界见[设计说明](./设计说明.md)。

## 使用方式

```js
const persistence = require('./server/persistence/index.cjs');

// 默认路径为 ~/.awf/awf.sqlite；首次调用时自动初始化并复用连接。
const created = persistence.requirements.createWithPlan({
  requirement: {
    projectId: 'project-id',
    title: '持久化改造',
    requestText: '将需求与会话信息保存到数据库',
  },
  plan: { title: '需求规划' },
}); // 成功直接返回 { requirement, planSession }；失败抛出 PersistenceError。

// 只有应用需要自定义路径时才在启动阶段初始化：
// persistence.initializePersistence({ filePath: '/path/to/awf.sqlite' });

// 长驻服务在优雅退出时调用一次；短命令通常不需要显式关闭。
persistence.shutdownPersistence();
```

- 首次 API 调用会按需打开 `~/.awf/awf.sqlite`；同一 Node.js 进程复用连接，不需要逐请求 open/close。
- `initializePersistence` 可在启动阶段显式配置路径和连接等待时间；使用默认路径时不需要调用。
- 除 `backupDatabase` 外，API 为同步方法；`backupDatabase` 返回 Promise。
- 成功时方法直接返回数据。失败时抛出 `PersistenceError`，由 Server/CLI 的统一错误处理入口记录日志并映射为响应；持久化模块本身不写控制台日志。

```ts
class PersistenceError extends Error {
  code: 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION' | 'STORAGE' | 'CLOSED';
  details?: object;
}
```

读取不存在的记录通常返回 `null`；违反数据库约束、校验规则或修订冲突时抛出 `PersistenceError`。

## 生命周期与诊断

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `initializePersistence(options?)` | `options: { filePath?: string; timeout?: number }` | `{ filePath, schemaVersion }` | 可选启动初始化。数据库已打开时不能改换数据库路径；失败时抛错。 |
| `shutdownPersistence()` | 无 | `undefined` | 关闭当前进程共享连接；供长驻服务优雅关闭使用。关闭后再次调用数据 API 会重新打开数据库。 |
| `getDatabaseInfo()` | 无 | `{ filePath, schemaVersion }` | 返回实际数据库路径和迁移版本。 |
| `integrityCheck()` | 无 | `{ ok, integrity: string[], foreignKeys: object[] }` | 执行 SQLite 完整性和外键检查。`ok` 表示两类检查均通过。 |
| `backupDatabase(destinationPath)` | `destinationPath: string` | Promise，解析为 `{ filePath }` | 创建一致性数据库备份；目标路径不能与源数据库相同。失败时 Promise reject。 |

## 项目与设备

### `projects`

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `create(input)` | `{ id?, name?, status? }` | `Project` | 创建项目；可传入项目清单中的稳定 ID。状态默认为 `active`。 |
| `get(id)` | 项目 ID 字符串 | `Project \| null` | 查询项目。 |
| `list(options?)` | `{ limit?: number; cursor?: string }` | `{ items: Project[]; nextCursor: string \| null }` | 按 ID 游标分页，limit 最大为 200。 |
| `update(id, patch)` | 项目 ID；`{ name?, status?, activeRequirementId? }` | `Project` | 更新项目元数据；active requirement 必须属于该项目。 |

### `environments`

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `register(input)` | `{ id?, name? }` | `Environment` | 登记或刷新一台设备的环境记录。建议调用方持久化并复用返回的 ID。 |
| `list()` | 无 | `Environment[]` | 按最近活跃时间倒序列出环境。 |
| `touch(id)` | 环境 ID 字符串 | `Environment \| null` | 更新最近活跃时间。 |

### `checkouts`

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `register(input)` | `{ id?, projectId, environmentId, rootPath }` | `ProjectCheckout` | 登记项目在设备上的实际目录；同环境、同项目、同规范路径会更新已有记录。 |
| `list(filters?)` | `{ projectId?, environmentId? }` | `ProjectCheckout[]` | 按项目或设备筛选 checkout。 |
| `resolve(projectId, environmentId)` | 项目 ID、环境 ID | `ProjectCheckout \| null` | 查询该项目在该设备上的最近 checkout。 |

## 需求、里程碑与会话

### `requirements`

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `create(input)` | `{ id?, projectId, title, requestText?, summary?, scope?, status? }` | `Requirement` | 创建一个需求。 |
| `createWithPlan(input)` | `{ requirement: RequirementInput; plan?: { title?, logDir?, originEnvironmentId? } }` | `{ requirement, planSession }` | 在同一事务中创建需求和 plan 会话。`plan` 可省略；省略时仍创建默认 plan 会话。任一步失败均回滚。 |
| `get(id)` | 需求 ID 字符串 | `Requirement \| null` | 查询需求。 |
| `list(options?)` | `{ projectId?, status?, limit?, cursor? }` | `{ items: Requirement[]; nextCursor: string \| null }` | 可按项目/状态筛选并按 ID 游标分页；limit 最大为 200。 |
| `update(id, patch)` | 需求 ID；`{ title?, requestText?, summary?, scope?, status?, expectedRevision? }` | `Requirement` | 更新需求并递增 revision；可通过 `expectedRevision` 检测并发冲突。 |

### `requirements.milestones`

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `create(input)` | `{ id?, requirementId, description?, status?, position? }` | `RequirementMilestone` | 创建需求里程碑。 |
| `update(id, patch)` | 里程碑 ID；`{ description?, status?, position? }` | `RequirementMilestone \| null` | 更新里程碑。 |
| `delete(id)` | 里程碑 ID 字符串 | `{ deleted: true }` | 删除里程碑及其任务关联。 |
| `list(requirementId)` | 需求 ID 字符串 | `RequirementMilestone[]` | 按 position 排序列出里程碑。 |
| `setTasks(milestoneId, taskIds)` | 里程碑 ID、任务 ID 数组 | `Task[]` | 原子替换里程碑关联任务；任务必须属于同一需求。 |
| `tasks(milestoneId)` | 里程碑 ID 字符串 | `Task[]` | 按关联顺序列出里程碑任务。 |

### `sessions`

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `create(input)` | `{ id?, requirementId, kind: 'plan' \| 'run', title?, logDir?, originEnvironmentId?, status? }` | `WorkflowSession` | 创建 plan/run 会话；未传 `logDir` 时使用 `.awf/logs/sessions/<sessionId>` 相对路径。 |
| `get(id)` | 会话 ID 字符串 | `WorkflowSession \| null` | 查询会话，不自动附带 attempts。 |
| `list(options?)` | `{ requirementId?, kind?, limit?, cursor? }` | `{ items: WorkflowSession[]; nextCursor: string \| null }` | 按 ID 游标分页；limit 最大为 200。 |
| `startAttempt(sessionId, input?)` | 会话 ID；`{ id?, environmentId?, provider?, runId? }` | `SessionAttempt` | 新建尝试并更新会话为 active；二者在同一事务中完成。可在 Run attempt 上保存 Server 的 `runId`；会话 ID 和日志目录保持不变。 |
| `finishAttempt(id, options?)` | 尝试 ID；`{ status?: string; errorText?: string \| null }` | `SessionAttempt \| null` | 结束一次运行尝试。默认状态为 `completed`。 |
| `finish(id, options?)` | 会话 ID；`{ status?: string }` | `WorkflowSession \| null` | 结束整个会话。默认状态为 `completed`。 |
| `attempts(sessionId)` | 会话 ID 字符串 | `SessionAttempt[]` | 按 attempt 编号列出重试记录。 |
| `linkConversation(sessionId, input)` | 会话 ID；`{ id?, provider, externalConversationId }` | `SessionConversation` | 关联外部 AI 平台 conversation ID。 |
| `conversations(sessionId)` | 会话 ID 字符串 | `SessionConversation[]` | 列出会话关联的外部 conversation。 |

## 任务、决策与执行

### `tasks`

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `create(input)` | `{ id?, requirementId, taskKey, title, kind?, status?, source?, prompt?, acceptance?, blockedReason?, details?, position? }` | `Task` | 创建需求内任务；`taskKey` 在需求内唯一。 |
| `get(id)` | 任务 ID 字符串 | `Task \| null` | 查询任务。 |
| `list(options)` | `{ requirementId, status?, limit?, cursor? }` | `{ items: Task[]; nextCursor: string \| null }` | 按需求分页列出任务；limit 最大为 200。 |
| `update(id, patch)` | 任务 ID；`{ taskKey?, title?, kind?, status?, source?, prompt?, acceptance?, blockedReason?, details?, position?, expectedRevision? }` | `Task` | 更新任务并递增 revision；可传 expectedRevision 检查并发冲突。 |
| `dependencies(taskId)` | 任务 ID 字符串 | `Task[]` | 列出该任务依赖的任务。 |
| `setDependencies(taskId, dependencyIds)` | 任务 ID、依赖任务 ID 数组 | `Task[]` | 原子替换依赖；拒绝跨需求关系和依赖环。 |
| `addCommit(taskId, input)` | 任务 ID；`{ id?, hash, message?, position? }` | `TaskCommit` | 追加关联 Git commit。 |
| `commits(taskId)` | 任务 ID 字符串 | `TaskCommit[]` | 按 position/创建时间列出 commit。 |
| `recordExecution(input)` | `{ id?, taskId, sessionId, requirementId, attemptId?, status?, result?, startedAt?, endedAt? }` | `TaskExecution` | 记录一次任务执行或重试结果。 |
| `executions(taskId)` | 任务 ID 字符串 | `TaskExecution[]` | 按开始时间倒序列出执行记录。 |

### `decisions`

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `create(input)` | `{ id?, projectId, requirementId, sessionId?, decisionType?, status?, question?, result? }` | `Decision` | 创建决策。 |
| `get(id)` | 决策 ID 字符串 | `Decision \| null` | 查询决策。 |
| `list(filters?)` | `{ requirementId?, projectId? }` | `Decision[]` | 按需求或项目筛选，按创建时间倒序。 |
| `update(id, patch)` | 决策 ID；`{ status?, question?, result? }` | `Decision \| null` | 更新决策当前状态或内容。 |
| `linkTask(id, taskId, relation?)` | 决策 ID、任务 ID、关系（默认 `informs`） | `DecisionTask[]` | 关联任务；关系可为 `informs`、`blocks`、`supersedes`、`caused_by`。 |
| `appendEvent(id, input)` | 决策 ID；`{ id?, eventType, payload?, actorType?, actorId?, occurredAt?, environmentId?, idempotencyKey? }` | `DecisionEvent` | 追加有序决策事件；相同幂等键会返回已有事件。 |
| `events(id)` | 决策 ID 字符串 | `DecisionEvent[]` | 按 sequence 列出事件。 |

## 提案、Bug 与产品 Issue

### `proposals`

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `create(input)` | `{ id?, projectId, requirementId?, status, payload? }` | `Proposal` | 创建提案；requirement 若提供必须属于该项目。 |
| `get(id)` | 提案 ID 字符串 | `Proposal \| null` | 查询提案。 |
| `list(filters?)` | `{ projectId?, status? }` | `Proposal[]` | 按项目、状态筛选。 |
| `recordEvent(id, input)` | 提案 ID；`{ id?, eventType, payload?, status? }` | `ProposalEvent` | 追加事件；若传 status，则事件和状态更新在同一事务提交。 |
| `events(id)` | 提案 ID 字符串 | `ProposalEvent[]` | 按创建时间列出提案事件。 |

### `bugs`

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `create(input)` | `{ id?, projectId, requirementId?, sessionId?, title, description?, severity?, status? }` | `Bug` | 创建 Bug；给出的需求/会话必须属于该项目。 |
| `get(id)` | Bug ID 字符串 | `Bug \| null` | 查询 Bug。 |
| `list(filters?)` | `{ projectId?, requirementId?, status? }` | `Bug[]` | 按创建时间倒序筛选。 |
| `linkTask(id, taskId, relation?)` | Bug ID、任务 ID、关系（默认 `discovered_by`） | `BugTask[]` | 关联发现、修复或验证任务；项目及需求必须匹配。 |
| `update(id, patch)` | Bug ID；`{ title?, description?, severity?, status? }` | `Bug \| null` | 更新 Bug。 |

### `issues`

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `create(input)` | `{ id?, projectId, title, body?, status?, priority? }` | `ProductIssue` | 创建 Issue 并在同一事务记录 created 事件。 |
| `get(id)` | Issue ID 字符串 | `ProductIssue \| null` | 查询 Issue。 |
| `list(filters?)` | `{ projectId?, status? }` | `ProductIssue[]` | 按优先级、更新时间排序。 |
| `update(id, patch)` | Issue ID；`{ title?, body?, status?, priority? }` | `ProductIssue \| null` | 更新 Issue，并在同一事务记录 updated 事件。 |
| `promote(id, input?)` | Issue ID；`{ requirementId?, title?, requestText? }` | `{ issue, requirement }` | 创建或复用关联需求，更新 Issue 并记录 promoted 事件；全部原子提交。 |
| `events(id)` | Issue ID 字符串 | `IssueEvent[]` | 按时间列出 Issue 事件。 |

## 项目结构、领域事件与文件元数据

### `architecture`

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `list(projectId)` | 项目 ID 字符串 | `ArchitectureNode[]` | 按 parent、position 列出项目 WBS 节点。 |
| `upsert(input)` | `{ id?, projectId, parentId?, nodeKey, title, description?, position?, details? }` | `ArchitectureNode` | 创建或更新节点；校验父节点属于同项目且树中无环。 |

### `events`

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `append(input)` | `{ id?, projectId, aggregateType, aggregateId, eventType, payload?, environmentId?, occurredAt? }` | `DomainEvent` | 为聚合追加下一个 sequence 的领域事件。 |
| `list(filters?)` | `{ projectId?, aggregateType?, aggregateId?, afterSequence?, limit? }` | `DomainEvent[]` | 读取领域事件；limit 最大为 500。 |

### `artifacts`

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `register(input)` | `{ id?, ownerType, ownerId, checkoutId?, relativePath, mediaType?, sizeBytes?, digest? }` | `Artifact` | 登记 `.awf/` 文件元信息；路径必须相对且不能向上越界。 |
| `list(ownerType, ownerId)` | 所有者类型、所有者 ID | `Artifact[]` | 列出该实体关联的文件元信息。 |

### `legacyIds`

| 方法 | 参数 | 成功返回 | 说明 |
|---|---|---|---|
| `register(input)` | `{ entityType, legacyId, entityId }` | `LegacyId` | 登记旧 ID 到稳定 ID 的映射；重复旧 ID 会更新映射。 |
| `resolve(entityType, legacyId)` | 实体类型、旧 ID | `LegacyId \| null` | 查询旧 ID 映射。 |

## 事务边界

跨表 API（`requirements.createWithPlan`、`sessions.startAttempt`、`proposals.recordEvent`、`issues.create/update/promote`）由 API 层管理事务。内部 Repository 失败会中止并回滚整个操作；调用方不需要拼接多表写入，也不接触事务句柄。

简单单表读写由对应模块方法处理。部分关联写入（如 `tasks.setDependencies`、`requirements.milestones.setTasks`）自身也是原子替换。
