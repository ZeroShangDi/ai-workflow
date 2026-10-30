# Server 持久化 API

Web 只调用 Server 的 API，不直接连接 SQLite。项目 URL 使用当前设备的 `projectRoot`；稳定 `projectId`、设备 `environmentId` 和本地 `checkoutId` 均由 Server 解析。

项目检查、初始化、登记等无项目作用域的写请求不需要 `?p`；已选项目下的需求、任务和会话写请求须包含 `?p=<projectRoot>`。成功响应为 `{ ok: true, ... }`；失败响应为 `{ ok: false, error, code? }`。

## 项目与工作区

| 方法 | 路径 | 输入 | 返回/说明 |
|---|---|---|---|
| GET | `/api/persistence/projects` | 无 | `{ projects: [{ projectId, projectName, projectRoot, environmentId }] }`，列出本设备已登记的 checkout |
| GET | `/api/persistence/init-options` | 无 | 返回 CLI `init` 可选参数与运行平台列表，供初始化弹窗展示 |
| POST | `/api/persistence/projects/select-folder` | `{}` | 在运行 Server 的电脑上打开系统目录选择器；选择后返回 `{ path }`，取消返回 `{ cancelled: true }` |
| POST | `/api/persistence/projects/inspect` | `{ path, adapter? }` | 检查目录、初始化状态、设备依赖和登记状态；返回 `{ project: { path, name, adapter, initialized, registered, status }, checks }` |
| POST | `/api/persistence/projects/initialize` | `{ path, adapter?, options: { force? } }` | 运行与 CLI `init` 一致的依赖检查、插件装配及 `.awf/` 初始化；不登记 SQLite 项目 |
| POST | `/api/persistence/projects/add` | `{ path }` | 要求 `.awf/config.json` 与 `state.json` 已存在，再登记稳定 project ID、environment 和本地 checkout；返回 `{ projectRoot, project, environmentId }` |
| GET | `/api/persistence/project` | 无 | 登记/刷新当前项目 identity，返回 project、environment、checkout |
| GET | `/api/persistence/workspace` | 可选 `requirementId` | 返回项目、需求、项目下 Plan/Run 会话、所选需求的任务与 Plan 摘要 |
| GET | `/api/persistence/state` | 无 | WBS 等项目文件数据加上从 SQLite 读取的任务列表；同时将 state 中任务状态同步回 SQLite |

项目稳定 ID 存于 `<projectRoot>/.awf/project.json`；设备环境 ID 存于 `~/.awf/environment.json`。同一项目可有多个设备 checkout，各自路径独立。

## 需求、会话与任务

| 方法 | 路径 | 输入 | 返回/说明 |
|---|---|---|---|
| GET | `/api/persistence/requirements` | 可选 `status, limit, cursor` | 当前项目需求分页 `{ data: { items, nextCursor } }` |
| POST | `/api/persistence/requirements` | `{ requirement: { title, requestText, summary?, scope?, status? }, plan?: { title?, logDir? } }` | 一个事务创建需求和 Plan 会话，并设为项目当前需求；返回 `{ data: { requirement, planSession } }` |
| GET | `/api/persistence/requirements/:id` | 无 | 当前项目需求；不存在或不属于当前项目返回 404 |
| GET | `/api/persistence/requirements/:id/sessions` | 可选 `kind, limit, cursor` | 该需求的 Plan/Run 会话分页 |
| POST | `/api/persistence/tasks/:id/retry` | `{}` | 将任务重置为 pending |
| POST | `/api/persistence/tasks/:id/unblock` | `{}` | 解除任务阻塞并重置为 pending |

## Plan 与 Run

| 方法 | 路径 | 输入 | 返回/说明 |
|---|---|---|---|
| POST | `/workflow/plan/start` | `{ requestText?, requirementId?, resume?, launch? }` | CLI 默认仍只准备 Plan 并返回提示词 `{ requirement, workflowSessionId, attemptId, prompt, title, detached }`；`launch: true` 时 Server 确保当前项目会话就绪并发送提示词，返回 `{ requirement, workflowSessionId, attemptId, launched: true }` |
| POST | `/workflow/plan/finish` | `{ workflowSessionId, attemptId, status?, errorText? }` | 结束交互式 Plan attempt；Plan 会话同步结束 |
| POST | `/api/persistence/plan/generate` | `{ requirementId }` | Web 用的 Server adapter Plan 启动入口。仅支持脱离请求终端的平台 |
| POST | `/api/persistence/plan/save` | `{ requirementId, version, summary, tasks }` | 原子保存需求摘要和任务修改；`version` 用于冲突检查 |
| POST | `/api/persistence/plan/approve` | `{ requirementId, version }` | 确认 Plan 并结束 Plan 会话 |
| POST | `/workflow/run/start` | `{ requirementId?, runId?, mode? }` | CLI 工作流入口。Server 同步 state 任务、校验 Plan 与 Run 前置条件、复用该需求现有 Run 会话并提交一次 attempt；返回 `{ runId, workflowSessionId, attemptId, mode }` |
| POST | `/workflow/run/finish` | `{ workflowSessionId, attemptId, status?, errorText? }` | 结束本次 Run attempt；中断后再次启动会复用同一 Run 会话 |
| POST | `/api/persistence/run/start` | `{ requirementId }` | Web 的 Run 启动入口，与 CLI 工作流入口共用 Server 编排 |

`runId` 是 Server Run Host 的一次运行标识，保存在对应的 `session_attempts.run_id`；`workflowSessionId` 是数据库中可跨多次 attempt 延续的逻辑会话 ID。Run 引擎暂时仍以 `.awf/state.json` 为任务执行源；Server 将任务投影同步到 SQLite，并校验对应任务存在后启动。CLI/MCP 不访问 SQLite。

Server 持久化工作流的文件产物按 `workflowSessionId` 归档；同一会话重试时目录不变，具体产物由 `attemptId` 区分。Run 日志写入 `.awf/logs/sessions/<workflowSessionId>/`，决策事件写入 `.awf/decisions/sessions/<workflowSessionId>.jsonl`，state 快照写入 `.awf/versions/sessions/<workflowSessionId>/attempts/<attemptId>/state.json`。`state.version` 仍保留在 state 内容与日志元数据中，不再用于这些新产物的路径。尚未迁移的旧 CLI 流程保留原有按版本号命名的路径。

MCP 状态工具通过 Server 的 `/awf/state` 与 `/run/state/apply` 读写 state；插件进程不会直接回退为项目文件写者。Server 对 state apply 成功后的任务列表做 SQLite 投影同步。

`/choice`、`/ask`、`/respond` 与 Claude 的 `AskUserQuestion` hooks 会在 Server 侧记录决策请求和结果；CLI/MCP 不直接写决策表。

## 决策与动态提案

| 方法 | 路径 | 输入 | 返回/说明 |
|---|---|---|---|
| GET | `/api/persistence/decisions` | 无 | 当前项目决策列表，含关联任务 |
| POST | `/api/persistence/decisions/:id/approve` | `{ reviewer?, note? }` | 标记已复审 |
| POST | `/api/persistence/decisions/:id/resolve` | `{ outcome?, reviewer?, note? }` | 处理决策 |
| POST | `/api/persistence/decisions/:id/override` | `{ instruction, reviewer? }` | 保存人工覆盖 |
| GET | `/api/persistence/proposals` | 无 | 当前项目动态任务提案 |
| POST | `/api/persistence/proposals/:id/approve` | `{ reviewer?, note? }` | 批准提案 |
| POST | `/api/persistence/proposals/:id/alternative` | `{ reviewer?, instruction? }` | 记录其他方案 |

## 日志

| 方法 | 路径 | 输入 | 返回/说明 |
|---|---|---|---|
| GET | `/api/persistence/log-files` | 无 | 日志文件列表；会话与路径元数据取自 SQLite，文件清单取自本地 `.awf/logs/` |
| GET | `/api/persistence/log-content` | `sessionId, file` | 读取所选日志文件；只允许读取对应会话目录中 basename 匹配的文件 |

Web 以 1.5 秒间隔重新读取选中的本地日志，查看运行中追加内容。日志正文不写入 SQLite。

## 隔离预览数据

运行 `node server/application/seed-preview.cjs <projectRoot> <databasePath>`，通过正式 Persistence API 向指定 SQLite 文件写入项目、需求、Plan/Run 会话、任务、决策和动态提案，并在项目 `.awf/logs/` 写入两份示例日志。预览 Server 设置 `AWF_DATABASE_PATH` 和 `AWF_ENVIRONMENT_FILE` 指向隔离文件；未设置时仍使用 `~/.awf/awf.sqlite`。验证结束后只删除隔离数据库、关联环境文件和 `preview-*.log` 文件，不清理正式数据库。

`createApi({ persistenceApplication })` 接受 Server 应用层接口；测试可通过 `global.__CC_PERSISTENCE_APPLICATION__` 注入替身。SQLite、SQL 和 repository 均留在 `server/persistence/` 内部。
