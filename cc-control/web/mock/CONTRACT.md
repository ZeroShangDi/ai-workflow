# Web 接口协议 v1（以可执行 mock 为准）

这是前端期望的接入协议。已有地址沿用当前服务；新增地址需要后端实现。页面只通过 `src/shared/api/index.js` 和统一 transport 调用接口，生产构建剔除 `mock/`。后端接入时保留页面、替换 transport 即可；不要将 mock 状态机复制为真实业务引擎。

## 通用规则

- JSON 请求/响应；所有项目读写请求带 `?p=<encodeURIComponent(projectRoot)>`。全局目录接口和 `/status` 不需要项目。
- 成功 `{ ok: true, ... }`；失败 `{ ok: false, error: string }`；字段校验 400、不存在 404、状态或版本冲突 409、暂不可用 503。读取状态 `/awf/state` 保留旧版直接对象返回。
- 创建需求/打开项目 201；启动运行、重试运行、生成计划、读取环境、诊断 202；其余成功 200。
- 写请求不自动重试；重复运行 ID、重复审批/替代、旧计划版本拒绝，不能重复插入任务。计划保存/确认携带 version；服务端在同一事务内验证和提交。
- 异步操作先返回，再轮询读取最终结果。前端不根据成功响应自行伪造结果。Mock 每 3 秒推进一拍，环境读取和 Plan 生成两拍完成；控制条可以暂停时钟和手动推进。
- 事件 `{ seq, runId?, type, at, payload }` 按项目单调递增；`at` 为 ISO 8601。环境/规划发生在 Run 之前，允许无 runId。事件轮询与 socket 使用同一事件源。
- 取消请求通过 AbortSignal；刷新页面重置 mock。不同项目状态互不污染。未知请求 404，永不回退真实服务。

## 项目、目录与环境（新增）

| 方法/地址 | 请求 | 响应/变化 |
|---|---|---|
| GET `/projects/directories` | 无 | `{ ok, directories: [{path,name,existing}] }`；供目录选择器展示 |
| POST `/projects/open` | `{path}` | `{ok,projectRoot}`；新目录开始读取环境，已有项目保留原状态 |
| GET `/workspace` | p | `{ok,projectRoot,environment,requirements,plan}` |
| POST `/workspace/environment/read` | `{}` | environment.status → reading；轮询到 ready 或 failed；失败显示 error，可重试 |
| POST `/requirements` | `{text}` | `{ok,requirement}`；trim 非空、环境 ready、没有进行中的规划/运行；创建需求并清空当前计划草稿 |

Environment：`{status: unread|reading|ready|failed, files:[{path,status,summary}], branch, runtime, warnings:[], error?}`。
Requirement：`{id,text,status:submitted|planned,at}`。项目界面不访问真实文件系统，由后端返回可选择目录和解析结果。

## Plan（新增）

Plan：`{status:empty|generating|ready|approved|failed, version:number, summary:string, tasks:Task[], error?}`。
Task：`{id,title,description?,status:pending|active|done|blocked|failed,kind?,deps:string[],acceptance:string[],wbsRef?,source?}`。

| 方法/地址 | 请求 | 响应/变化 |
|---|---|---|
| POST `/plan/generate` | `{}` | `{ok,plan}`；要求有需求且没有活动 Run；version+1，generating → ready；失败用 failed/error，可重新生成 |
| POST `/plan/save` | `{version,summary,tasks}` | `{ok,plan}`；仅 ready，验证非空标题、唯一 ID、存在的依赖、无自引用/环；成功 version+1 |
| POST `/plan/approve` | `{version}` | `{ok,plan}`；仅 ready，任务复制到 `/awf/state`，需求 planned，Plan approved；之后可以启动 Run |

UI 草稿由用户编辑，保存前禁止确认；重新生成不覆盖正在执行的任务。后端必须保证计划确认与任务写入是同一事务。

## Run、任务与会话

| 方法/地址 | 请求 | 响应/变化 |
|---|---|---|
| GET `/status` | `p?`, `snapshot=1?` | `{ok,projectRoot?,projects?:[{projectRoot}],session,state,decisionPending,activeAgents,snapshot?}`；全局空状态 `projects:[]` |
| GET `/awf/state` | p | `{mode:idle|run|pause,version,tasks,wbs,currentState}` |
| GET `/run/status` | `runId?` | `{ok,runs:[Run]}` 或 `{ok,run}` |
| POST `/run/submit` | `{runId?,mode?}` | `{ok,runId,mode}`；要求有 pending 任务、无活动 Run；运行 ID 不可覆盖历史 |
| POST `/run/state/mode` | `{mode:run|pause|idle}` | `{ok,mode}`；run/pause 要求活动 Run；pause 停止调度 |
| POST `/run/:id/cancel`（新增） | `{}` | `{ok}`；running/queued → cancelled，活动任务回 pending，保留历史计数和结束时间 |
| POST `/run/:id/retry`（新增） | `{}` | `{ok,runId}`；仅 failed/cancelled 且无活动 Run；保留旧运行，创建新 ID，失败/阻塞任务回 pending |
| POST `/tasks/:id/retry` 或 `/unblock`（新增） | `{}` | `{ok,task}`；失败/阻塞任务回 pending，再恢复调度或启动运行 |
| GET `/conversation`（新增） | p | `{ok,messages:[Message],source:'structured'}` |
| POST `/send` | `{text}` | `{ok,sent}`；非空且会话 ready；追加用户消息，busy → ready，追加助手回复 |
| POST `/respond` | `{value}` | `{ok,sent}`；仅有待回复问题，选择项用 1-based 数字字符串，自由输入用文本；清除问题并恢复运行 |
| POST `/stop` | `{}` | `{ok}`；打断当前会话回复，与取消 Run 为不同操作 |

Run：`{runId,status:queued|running|done|failed|cancelled,mode,startedAt,endedAt?,counts:{total,done,active,pending,blocked,failed}}`。
Message：`{id,role:user|assistant|tool,type:text|tool|task|decision,title?,text,status?,at}`。会话属于项目；Run 下拉筛选编排事件，不能把当前会话标成历史 Run 会话。结构化会话的字卡、工具结果和决策卡沿用本仓 UI 交付约定；Plan/日志在交付稿中为局部设计，补充正常操作所需内容。

## 决策与动态任务

| 方法/地址 | 请求 | 响应/变化 |
|---|---|---|
| GET `/awf/decisions` | p | `{ok,total,decisions:[DecisionEvent]}`；前端按 runStamp + decision_id 聚合 |
| POST `/awf/decisions/:id/adopt`（新增） | `{}` | `{ok}`；pending_review → reviewed；重复采纳拒绝 |
| POST `/awf/decisions/:id/override` | `{instruction,original_answer?}` | `{ok,decision_id,reviewTaskId}`；非空替代指令，追加 overridden 事件和纠偏任务；不可重复 |
| POST `/awf/decisions/:id/resolve` | `{reviewer,note?,outcome:'approve'}` | `{ok,proposal}`；批准关联 decision_required 提案并生成完成决策 |
| GET `/awf/dynamic-planning/proposals` | `proposalId?` | `{ok,proposals:[Proposal]}` 或 `{ok,proposal}` |
| POST `/run/dynamic-planning/proposals/:id/approve` | `{reviewer,note?}` | `{ok,proposal}`；awaiting_approval → applied/conflicted；应用 insert_task 和 prerequisite_for 依赖 |
| POST `/run/dynamic-planning/proposals/:id/alternative`（新增） | `{reviewer,instruction}` | `{ok,proposal}`；仅 awaiting_approval/decision_required；原提案 rejected + 替代任务 + 关联 overridden 决策在一次提交中完成 |
| POST `/run/dynamic-planning/proposals/:id/retry`（新增） | `{reviewer,note?}` | `{ok,proposal}`；conflicted/failed → awaiting_approval，重新校验后再次批准 |
| POST `/run/dynamic-planning/proposals/:id/review`（新增） | `{reviewer,note?}` | `{ok,proposal}`；applied_review_pending → applied |

DecisionEvent：沿用 fixtures 与真实日志格式，`event:decision_requested|decision_completed|decision_overridden`、`decision_id`、`runStamp`、`status`、`subject?`、`result?`、`instruction?`。Result 包含问题、答案、依据、风险等。
Proposal：`{proposalId,status,reason,createdAt,updatedAt?,operations,analysis:{affectedTaskIds,decisionReasons?},decision?:{decisionId,runStamp},approvedBy?,reviewedBy?,alternative?}`。

冲突时 HTTP 200 仅代表审批被记录，必须检查 `proposal.status === 'conflicted'` 并显示“未应用”。待人工提案批准或替代后解除受影响任务的阻塞。UI 不提供无替代内容的独立拒绝按钮。

## 日志、指标与诊断

| 方法/地址 | 请求 | 响应 |
|---|---|---|
| GET `/run/events` | `afterSeq=0&limit=500&runId?` | `{ok,events,afterSeq,tailSeq,trimmed}`；按游标分页；trimmed 为最早保留序号减一 |
| GET `/logs/source`（新增） | p | `{ok,source,kind,text}`；静态真实日志样本与模拟会话严格分开 |
| GET `/awf/metrics` | p | `{ok,metrics:{agentMode,activeAgents,elapsedMs,tokens,context}}` |
| GET `/awf/diagnostics` | p | `{ok,diagnosis}` |
| POST `/awf/diagnostics` | `{}` | `{ok}`；running → complete，GET 返回结果 |

日志页支持搜索、自动跟随、按 Run 筛选、清屏；清屏只清当前视图游标，不删除服务器事件。当前会话输出也支持搜索。

## 接入验收

1. 依次实现以上新增地址，已有地址保持响应结构；目录根路径由后端返回，不应硬编码 `/mock/*`。
2. 用 `tests/lifecycle.test.mjs` 的时间轴和状态不变量检查实现，特别是事务、依赖顺序、取消、重复提交和历史隔离。
3. 浏览器验收 `tests/browser.cjs` 覆盖 7 个页面 × 4 个宽度，以及从空项目到运行完成的完整交互；真实服务验收时替换场景准备方式。
4. Mock 故意不执行命令、不读用户目录、不持久化。真实后端负责文件读取、真实生成/运行、安全边界、事件存储；这些不是模拟层已实现的后端能力。
