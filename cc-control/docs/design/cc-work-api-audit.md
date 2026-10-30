# cc-work：八页 UI 与根目录 server 接口盘点

盘点日期：2026-09-13。依据当前工作区的 `server/`，不是 `src/server/`；包含尚未提交的代码。Figma 文件 `ULzSTHZS6fW3uT08eBUcNe`，本轮只读，没有修改设计或 server。

本文分开记录**代码已存在的事实**与**建议供新 UI 使用的契约**。后者尚未实现，也不表示用户已确认全部业务细节。配套 [cc-work-api-contract.ts](cc-work-api-contract.ts) 是接口设计类型，不是可调用 SDK。源码指纹与 UI 文案快照见 [cc-work-api-evidence.json](cc-work-api-evidence.json)。

## 1. 结论与实现边界

现有 server 已有运行宿主、项目作用域、任务状态、决策存储、动态任务提案与事件流；缺的不是一整套引擎，而是面向产品的资源索引、读模型和若干完整业务动作。

| 页面 | UI 已确认范围 | 当前能力 | 接入判断 |
| --- | --- | --- | --- |
| 01 初始页 | 完整空态；添加本地项目；侧栏项目/Plan；状态栏 | `/status` 可列本进程已访问的项目 | 缺持久项目目录、添加/检测、恢复选择、Plan 列表；不能直接把 runtime registry 当用户项目库 |
| 02 Plan | 草案阶段、任务数、规划决策；确认后冻结基线并创建 Run | `/awf/state` 有当前 `plan/wbs/milestones/tasks`；`/run/submit` 可启动运行 | 缺独立 Plan ID、版本、草案生成入口、确认/冻结/启动事务；示例阶段不能硬编码 |
| 03 Run | 对话、输出块、输入/停止/暂停、概览、矩阵、执行任务、打开 Agent 会话 | state、run snapshot/events、metrics、主会话 send/stop | 状态和计数可适配；完整消息、Agent 会话定位、输出块、按 Run 控制和持久历史缺失/不完整 |
| 04 任务 | 全部任务列表及每项当前状态；旧面板左侧；UI 占位 | `state.tasks`、依赖图、holds、exec | 读模型可适配；不在本轮增添手工改状态/删除/重试按钮 |
| 05 决策 | 列表/筛选/详情；采纳，或提供非空替代决策 | append-only 记录；动态提案决议；已完成决策 override | 需要聚合读模型；通用采纳和原子替代动作缺失，现有 resolve/override 不能直接等价替换 |
| 06 动态任务复审 | 与决策页类似；具体 UI 尚未确认 | proposal 列表、分析、审批/拒绝；`applied_review_pending` | 审批已有；**应用后的复审提交能力缺失**，必须与应用前审批分开 |
| 07 日志 | Run 与 Agent 分流、搜索、跟随、清屏、导出、终端打开 | 宿主内存事件环、人读 main.log、Agent 转录和部分 jsonl | 缺历史日志/源索引/分页/检索/导出 HTTP；原始 stdout/stderr 与流式会话不能由人读日志假冒 |
| 08 设置 | 全局默认/项目覆盖；自动保存、恢复默认 | 仅项目配置加载器、运行参数、决策/动态规划模式 | 缺设置读写接口、全局存储、覆盖与生效时机；“自动 1–4”不是现有默认值 |

保留原 Run 页的组件拆分，接口按资源和业务动作组织，不按每个小组件各建一个接口。其他页面无需先重新拆组件。

## 2. 关键事实及不可误用处

1. **项目域不是持久项目库。** `registry` 用 `Map<absolutePath,runtime>` 懒注册，启动即有 boot 项目；`GET /status` 不带 `p` 才附 `projects`。没有添加、移除、命名、排序、扫描目录或重启恢复接口。请求一个 `p` 会创建 runtime，不能拿这条路径充当无副作用的项目检测。见 [registry](../../server/runtime/registry.cjs)、[project context](../../server/runtime/project.cjs)、[logger](../../server/observability/run-logger.cjs)。
2. **`p`、`sid`、`runId` 不可混用。** `p` 是项目根；`sid` 只在部分路由选择会话槽/磁盘分片；`/run/status` 与 HTTP events 使用 `runId`；`/send`、`/stop`、决策列表、metrics 不因附加 `sid` 自动变为按 Run 隔离。无效 sid 的 status 还会懒建 ready 槽，因此 ready 不等于会话真实存在。
3. **写请求缺 `?p` 直接 400**，唯一例外是 `/shutdown`；读请求可回退 boot。新 UI 必须显式选项目后才读写其业务数据。新增全局目录/全局设置接口应在项目 runtime 分派之前处理，不能为了它们放宽旧写接口的保护。见 [入口](../../server/web/api/index.cjs)、[工具](../../server/web/api/util.cjs)。
4. **同一项目的 run host 同时只驱动一个 Run。** 多 Agent 是同一个 Run 内并行，不代表同项目可并行多个 Run。运行记录和事件环在内存里；相同已结束 runId 可被再次提交覆盖，默认 ID 为 `default`。分片路径存在不等于当前 host 已按分片执行；生产装配使用项目主 state。见 [host](../../server/run/host.cjs)、[装配](../../server/runtime/index.cjs)。
5. **三种状态独立。** 会话 `ready/busy`、工作流 `idle/run/pause`、Run `queued/running/done/error/stopped` 不能合成一个字段。`done` 是驱动循环结束，也可能仍有 blocked/pending 任务；不能直接显示“所有任务完成”。host 的 stop 是内部生命周期能力，无对应 Run 取消 HTTP；`/stop` 只 Ctrl-C 主 tmux，不能当作取消整个 Run。
6. **决策列表返回的是事件，不是决策卡片。** `/awf/decisions.total` 为事件行数；同 decision 有 requested/completed/overridden。须按 `(project,runStamp,decision_id)` 聚合，不能按行计数，也不能仅按可能重复的 `D-001` 跨 Run 合并。override 只允许已完成记录；它先记 override 再建纠偏任务，失败可能是部分成功，重试不具备统一幂等保障。见 [decision API](../../server/web/api/decisions.cjs)、[store](../../server/features/decision/store.cjs)。
7. **`resolve` 是动态规划专用。** 调用 `dynamicPlanning().resolveDecision`，只接受 `approve/reject` 和 reviewer。UI 的“提供其他决策”要求内容，并且不能只把 reject 的 note 改个标签。替代决策、旧决策结论及后续动作必须作为可恢复的一次业务动作记录。
8. **复审不是审批的别名。** `approve/reject` 不接受 `applied_review_pending`；service 只有 `propose/approve/reject/resolveDecision/get/list`。`review.status=pending` 已落盘，但没有“复审通过/要求修正”的收口。高风险 proposal 无论策略都走正式决策，不能绕过。审批可能 HTTP 200 但 proposal 变 `conflicted`，不能提示“已应用”。见 [service](../../server/features/replanning/service.cjs)。
9. **WS 不提供重放或 Run 过滤。** `/run/events` 升级后订阅项目 host 全部新事件，未读取 `runId/afterSeq/sid` 作过滤；HTTP 轮询才过滤 runId。事件 seq 为项目 host 内单调计数，重启归零、容量 10000；返回 trimmed/tailSeq，但没有持久游标/epoch。装配没有为 host 注入持久 event sink；定义了 EVENT_DEFS 不表示全部事件已发布。见 [WS 入口](../../server/web/api/index.cjs)、[events](../../server/shared/events.cjs)。
10. **观测值不是全部可信实测。** metrics 已有 token coverage、context、速度；没有 TTFT、Git 分支/diff 和账号额度窗口。缓存命中百分比没有既定返回字段/分母；没有数据应显示 `null/未知`，不要沿用 Figma 的 42%、620ms、4 Agent 等例值。配置实际默认 max=1，不是“自动 1–4”。
11. **日志目前不是 UI 里描述的统一结构化日志库。** main.log 混排提示、回答、通知、决策；Agent 日志在停止后由 transcript 渲染，同名重试会覆盖；完整 raw stdout/stderr、按 attempt 的稳定检索、工具块与实时 token 流均不能由此保证。现有 logger 和 event ring 也没有稳定的统一 runId 映射。
12. **设置不能只保存假开关。** `run.decision.enabled` 是决策门阀开关，不是完备的人/AI 决策策略；`run.dynamicPlanning.mode` 不是 dynamicTasks.enabled；四层并行配额不同于自动选择 Agent 模式。host 初始化时加载并行配置，已有 host 不会因文件改动自动重装。

## 3. 现有 HTTP/WS 目录（已实现）

下列共有 34 个 method/path 组合，另有 1 个 WS 升级入口；不含 SPA/静态资源。除 `/shutdown` 外 POST 必须带 `?p=<urlencoded absolute projectRoot>`。GET 也建议显式带 p。通用错误通常是 `{ok:false,error:string}`，但 HTTP 状态和 ok 不完全一致，客户端需要同时检查。

| 方法与路径 | 输入 | 成功响应/语义 | UI 使用限制 |
| --- | --- | --- | --- |
| GET `/status` | `p? sid? snapshot?` | 主槽状态；无 p 附 projects；sid 分支仅槽状态 | 不是项目库；snapshot 是 tmux 文本，不是对话模型 |
| GET `/probe` | p | 会话存在、状态、capturedAt | 观测；不等于 Run 状态 |
| GET `/awf/state` | `p, sid?` | 原始 state，无 ok 包裹；不存在 404 | tasks/plan 适配基础，不直接耦合组件 |
| GET `/awf/metrics` | p | `{ok,metrics}` | 项目级，非任意历史 Run 指标 |
| GET `/awf/diagnostics` | p | `{ok,diagnosis}` | 高级诊断，当前八页未定义入口 |
| POST `/awf/diagnostics` | p | 202 受理或 409 | 可能发起模型诊断，不当普通刷新 |
| POST `/context-ready` | p | `{ok,contextReady}` | 内部接力协议 |
| GET `/context-ready` | p | `{ok,ready}`，读取即消费 | 不可被 UI 轮询消费 |
| POST `/run/state/mode` | `{mode:'run'\|'idle'\|'pause'}` | `{ok,mode}` | 可作为 pause/resume 适配底层；缺 activeRunId 前置校验 |
| POST `/run/state/task/active` | `{taskId}` | `{ok,taskId}` | 宿主占用原语，UI 禁止直接标 active |
| POST `/run/state/gate` | `{taskId}` | `{ok,applied,...}`；无任务也可能 200 | 内部门禁，不是重试按钮 |
| POST `/run/state/backup` | 空体 | `{ok}` | 内部归档，不是 UI 保存 Plan |
| POST `/run/state/apply` | `{state,expectedLastUpdated?,expectedStateFingerprint?}`, sid? | `{ok,...}`；CAS 冲突409 | 无 CAS 可覆盖整份 state；sid 分支无 CAS；不暴露给 UI |
| GET `/run/status` | `p,runId?` | `{ok,run}` 或 `{ok,runs}` | 不存在 run 为 HTTP200+ok:false；历史仅本进程内 |
| POST `/run/submit` | `{runId?,mode?:'single'\|'batch'}` | 202 `{ok,runId,mode}`；并发409 | 不接收 planId，不冻结基线；默认 default，不幂等 |
| GET `/run/events` | `p,runId?,afterSeq?,limit?` | `{ok,events,afterSeq,tailSeq,trimmed}` | 内存环；默认200条；seq 范围是项目 host |
| WS `/run/events` | p | 逐条 `{seq,runId,type,at,payload}` | 只推新事件；客户端须过滤runId；无重放/epoch |
| POST `/send` | `{text}` | `{ok,sent}`；忙等待超时409/无tmux503 | 主会话注入；不返回 messageId，也非异步排队 |
| POST `/cmd` | `{cmd}` | `{ok,sent}` | 内部 slash 指令，不是通用页面动作 |
| POST `/stop` | 空体 | `{ok,stopped}` | 仅主会话 Ctrl-C，不能表示 Run 已取消 |
| POST `/intervene` | `{text,reason?}` | `{ok,sent,intervention}` | 要求 mode=pause；主会话操作 |
| POST `/intervene/interrupt` | `{reason?}` | `{ok,interrupted,reason}` | 要求 pause，主会话打断 |
| POST `/choice` | `{question,options?,context?}` | `{ok,decisionPending}` | 当前校验仅要求question为string，未消费multiSelect/header；AI输入请求，不是前端决策存储 |
| POST `/ask` | `{question,context?}` | `{ok,decisionPending}` | AI 请求文本输入；当前未拒绝空question |
| POST `/respond` | `{value}` | `{ok,sent}` | 回应瞬时 pending；非法 body 也清 pending；不是正式决策resolve |
| GET `/awf/decisions` | p | `{ok,total,decisions:rawEvents[]}` | 无筛选/分页/单条详情；需聚合 |
| POST `/awf/decisions/:id/resolve` | `{outcome:'approve'\|'reject',reviewer,note?}` | `{ok,proposal,decision}` | 仅关联动态规划正式决策；业务失败409 |
| POST `/awf/decisions/:id/override` | `{instruction,original_answer?}` | `{ok,decision_id,runStamp,reviewTaskId}` | 已完成决策纠偏；可能部分成功500；非通用替代 |
| GET `/awf/dynamic-planning/proposals` | `p,proposalId?` | `{ok,proposals}` 或 `{ok,proposal}` | 项目全量；剥离 proposedState，无分页 |
| POST `/run/dynamic-planning/proposals` | `{reason,operations,trigger?,requestedBy?}` | 200/202 `{ok,applied,proposal}` | AI/内部提案入口；不能当初始 Plan 生成 |
| POST `/run/dynamic-planning/proposals/:id/approve` | `{reviewer,note?}` | `{ok,proposal}` | 只 awaiting_approval；HTTP200也可能conflicted |
| POST `/run/dynamic-planning/proposals/:id/reject` | `{reviewer,note?}` | `{ok,proposal}` | awaiting_approval 或 decision_link_failed；不是应用后复审 |
| POST `/oneshot` | `{prompt,cwd?}` | 执行结果；失败可能200+ok:false | 5分钟同步模型调用，不直接充当 Plan 工作流 |
| POST `/hook` | hook事件体，`sid?,event?` | `{ok,event,state,ccOutput?}` | CC 内部回调，不允许前端伪造 |
| POST `/shutdown` | 无 p | `{ok,shutting:true}` | 进程管理；不是停止 Run |

现有 HTTP 客户端 `web/src/api/client.js` 只附 p/sid，不会把 sid 转为 runId，也丢失 HTTP status/headers；新适配器须保留 status、错误码、游标和 ETag。旧静态托管显式页面别名只覆盖 dashboard/diagnostics/decisions；新八页的直达与刷新需一并验证，API 未命中不能落成 HTML 200。

## 4. 新 UI 契约共同规则（建议基线，尚未实现）

建议在**同一个 root server** 增加 `/api/v1` 产品接口，内部调用 runtime/领域服务，不另起服务，也不删除 `/awf`、`/run` 兼容面。前端通过一个适配层消费下面 DTO；可先接 mock。能够复用的领域能力不重写。

- `projectId`、`planId`、`runId`、`taskId`、`conversationId`、`agentId`、`attemptId`、`decisionId`、`proposalId` 各有稳定含义。所有项目资源路径含 projectId，并校验下级资源所属关系。绝对 projectRoot 只用于项目注册和旧接口映射。
- `planId` 不等于 state.version；`runId` 不等于任意 sid、日志目录名或显示编号。适配器保存显式映射，无法确认的历史关联返回 unknown，而非取“最新”拼接。
- 成功 `{ok:true,data,meta:{requestId,observedAt,revision?}}`；错误 `{ok:false,error:{code,message,retryable,fieldErrors?,operationId?},meta}`，状态码正确。400格式错误、404资源不存在、409状态/幂等冲突、412版本前提不符、422业务字段无效、503能力不可用。
- 数组查询统一 `cursor/limit`（1–200，默认50），`items/nextCursor/hasMore/total`；总数未知为 null。稳定排序包含 ID 兜底；任务列表可按 UI 排序，列表与计数使用同一 snapshot revision。
- 客户端创建/动作发 `Idempotency-Key`；相同 key+相同请求返回同一结果，不重建项目/Run/决策；相同 key+不同请求409。作用域为操作者+项目+操作，建议至少保留24小时，运行中的操作不能过期。
- 编辑/确认带 `If-Match`（服务端不透明 revision）；请求期间数据变更返回412并让用户重读。领域审批仍保留现有“影响闭包指纹+重放”，不能简化为全 state 哈希相等。
- 长动作202返回 `Operation`，`GET /operations/:id` 可恢复结果；已受理不等于已执行成功。跨文件步骤需有持久 operation journal 和重试补偿，禁止把部分成功当全部失败重新创建。
- 时间为 UTC ISO8601，持续时间毫秒，token数整数，比例百分数0–100并明确口径。null 表示不可用；metric 附 freshness/coverage。时钟、当前选择、面板开合、文本输入草稿、局部清屏属于前端状态。
- 响应附 `allowedActions`/能力状态，未实现动作 disabled 且说明原因；不能按钮可点但只写本地假状态。actor 来自会话/本机身份上下文，不把 Figma 的 `weii` 写进契约。
- Web 页面不能凭普通目录选择输入获得服务器绝对路径或打开任意终端；通过宿主 bridge 能力检测。无 bridge 时提供手填绝对路径，隐藏拖目录和“在终端打开”。

## 5. 新 UI 需要的接口全集

**本节每个 `/api/v1` 路由都是提议，当前均未实现。** “适配”表示已有底层能力，不表示已有同名端点。具体请求/响应字段见配套类型。表内 `P=/projects/:projectId`，`R=P/runs/:runId`，全部前缀 `/api/v1`。

| ID | 页面 | 方法/路径 | 请求或查询 | 响应 data | 现有来源 / 所需工作 |
| --- | --- | --- | --- | --- | --- |
| A01 | 公共 | GET `/bootstrap` | 无 | Bootstrap | 新增：能力、本机身份、持久项目摘要、上次选择；无项目也可用 |
| A02 | 公共 | GET `/operations/:operationId` | 无 | Operation | 新增：异步动作持久结果/部分失败 |
| P01 | 1/侧栏 | GET `/projects` | cursor,limit | Page<Project> | 新增持久目录；registry只作运行态合并 |
| P02 | 1/添加 | POST `/projects/inspect` | `{path}` | ProjectInspection | 新增只读检测；不得启动runtime/创建.awf |
| P03 | 1/添加 | POST `/projects` | `{path,name?,initializeIfNeeded}` | Operation<Project> | 新增注册/可选初始化；同规范路径幂等；保留现有.awf |
| P04 | 公共 | GET `P/workspace` | `planId?,runId?` | Workspace | 聚合选择上下文、侧栏摘要、阶段、状态栏；不存在资源不能回退boot |
| L01 | 侧栏/2 | GET `P/plans` | cursor,limit | Page<PlanSummary> | 新增Plan索引/历史；不是遍历version冒充多个Plan |
| L02 | 侧栏/2 | POST `P/plans` | `{title?,prompt}` | Operation<PlanDetail> | 新增草案生成/持久身份；服务内部可调现有模型通道 |
| L03 | 2 | GET `P/plans/:planId` | 无 | PlanDetail | 适配state+补Plan版本/基线/生成状态/规划决策关联 |
| L04 | 2 | POST `P/plans/:planId/confirm-and-run` | `{expectedDraftRevision}` | Operation<{planId,baselineRevision,runId}> | 新增原子确认/冻结基线/创建Run；重复点击只产生一个Run |
| R01 | 3/历史 | GET `P/runs` | planId?,cursor,limit | Page<RunSummary> | host.snapshot仅内存；补持久目录和启动/恢复映射 |
| R02 | 3 | GET `R` | 无 | RunSummary | 适配host+state+metrics，分开状态、缺失数据和completion |
| R03 | 3 | GET `R/conversations` | cursor,limit | Page<Conversation> | 新增主/编排/Agent关联，含任务与attempt，不拿UI序号作ID |
| R04 | 3 | GET `R/conversations/:conversationId/messages` | cursor,limit | Page<Message> | 新增结构化持久消息；工具/命令/文件/测试块可按需加载 |
| R05 | 3 | POST `R/conversations/:conversationId/messages` | `{clientMessageId,text}` | Operation<{messageId}> | /send只主会话且缺messageId；需精准目标、幂等、busy策略 |
| R06 | 3 | POST `R/actions` | RunAction | pause/resume/cancel/interruptResponse 的 Operation | pause可复用mode闩锁；其余按Run语义补齐，不能把/stop当cancel |
| R07 | 3 | GET `R/metrics` | 无 | RunMetrics | 当前metrics适配；补run归属、质量、TTFT等能力标记 |
| R08 | 3 | PATCH `R/decision-policy` | `{mode:'manual'\|'ai'}` | DecisionPolicy | 新增安全生效时点；enabled布尔不能直接映射，默认值待确认 |
| T01 | 3/4 | GET `R/tasks` | status?,origin?,q?,cursor,limit | TaskPage | 适配state.tasks+holds+deps，补来源/执行分配；返回同版计数 |
| T02 | 3/4 | GET `R/tasks/:taskId` | 无 | Task | 提供完整prompt、依赖、当前attempt/conversation关联；不引入编辑动作 |
| D01 | 2/5 | GET `P/decisions` | planId?,runId?,status?,phase?,q?,cursor,limit | Page<Decision> | 聚合原始生命周期事件；状态/total按决策实体计算 |
| D02 | 5 | GET `P/decisions/:decisionId` | 无 | Decision | 新增稳定外部ID映射及上下文、备选/影响/关联 |
| D03 | 5 | POST `P/decisions/:decisionId/actions` | DecisionAction | Operation<DecisionResolution> | 通用adopt/replace缺失；动态resolve可作特定source适配 |
| Q01 | 6 | GET `R/task-proposals` | status?,cursor,limit | Page<TaskProposal> | 项目proposal查询适配，补Run归属；禁止靠当前Run猜历史 |
| Q02 | 6 | GET `R/task-proposals/:proposalId` | 无 | TaskProposal | 现有get适配；增加审阅所需before/after投影，不能暴露整份proposedState |
| Q03 | 6 | POST `R/task-proposals/:proposalId/reviews` | ProposalReview | Operation<TaskProposal> | **新增应用后复审收口**；不是approve/reject的别名，处置待确认 |
| G01 | 7 | GET `R/log-sources` | 无 | LogSource[] | 新增：Run/Agent/attempt源、状态、可用性、记录数 |
| G02 | 7 | GET `R/logs` | LogQuery | Page<LogEntry> | 新增持久分页搜索；Run结构化事件与Agent输出分别取源 |
| G03 | 7 | POST `R/log-exports` | `{query,format}` | Operation<{exportId}> | 新增生成导出；query与当前筛选同义 |
| G04 | 7 | GET `R/log-exports/:exportId` | 无 | 二进制下载 | 新增Content-Disposition；只导出当前授权Run所选范围 |
| F01 | 3 | GET `R/artifacts/:artifactId` | cursor?,limit? | ArtifactDetail | 新增命令全输出、diff、测试报告等懒加载；可用时才显示入口 |
| S01 | 8 | GET `/settings` | 无 | SettingsDocument | 新增全局默认、有效值、可用字段/生效范围 |
| S02 | 8 | PATCH `/settings` | SettingsPatch | SettingsDocument | 新增字段白名单校验、自动保存、并发冲突；不任意覆盖配置 |
| S03 | 8 | POST `/settings/reset` | `{keys?}` | SettingsDocument | 重置用户覆盖，不删除项目运行资料 |
| S04 | 8 | GET `P/settings` | 无 | SettingsDocument | 项目配置加载器适配，返回 overrides/effective/inheritedFrom |
| S05 | 8 | PATCH `P/settings` | SettingsPatch | SettingsDocument | 新增项目覆盖写入；null=恢复继承，未知字段422 |
| S06 | 8 | POST `P/settings/reset` | `{keys?}` | SettingsDocument | 删除项目覆盖，保留全局值；明确affected keys |
| E01 | 公共/3–7 | GET/WS `P/events` | epoch?,afterSeq?,runId?,limit? | EventBatch / UiEvent | 增强持久/epoch、过滤、重放与断线恢复；可先HTTP轮询再加WS |

宿主 bridge 单列：`pickProjectDirectory()`、`openLogInTerminal({projectId,runId,sourceId})`，不是伪造的 HTTP 或 shell 命令字符串接口。导出触发可以是 HTTP，文件保存对话框由浏览器/宿主负责。

## 6. 字段与状态映射

### 项目与 Plan

- Project：稳定id、规范root、name、availability、initialized、selectedPlanId/lastOpenedAt；发现的配置只是检测结果，不等于注册成功。UI的“添加后打开”是成功后的导航选择。
- Plan：草案revision、title/summary、phase分组及taskIds、规划decisionIds、generation状态、baselineRevision、runIds。阶段数和任务数从数据计算；`state.currentState` 是工作流阶段，不是四条产品阶段标题的来源。
- `confirm-and-run` 前置条件：草案就绪、revision匹配、要求的规划决策已闭合、无其他active Run、执行依赖可用。冻结baseline与运行任务分离；动态任务不改写历史基线。启动失败须能查到“已确认但启动失败”的Operation并恢复，不默默重复确认。

### Run、任务、会话

- Run.lifecycle = queued/running/done/error/stopped/unknown（保留原值）；workflowMode = idle/run/pause/unknown；sessionState = ready/busy/unavailable/unknown。页面显示状态另由服务端给 displayState，并给原因。
- completion = all_tasks_done / work_remaining / failed / cancelled / unknown。仅所有应完成任务满足完成判据才能显示完成；无ready任务不等于成功。
- pause = 停止后续调度并在安全点暂停，允许在途执行完成；返回requested/effective，不能承诺瞬间停止所有Agent。interruptResponse = 中断指定会话当前输出；cancel = 停止Run后续调度并处理在途任务；resume = 恢复同一Run。当前控制行为与最终文案需要联调确认。
- Task 原状态 pending/active/done/blocked 保留 rawStatus；UI派生 ready/waiting_dependency/held/running/succeeded/blocked/failed/unknown。blocked 不自动等于 failed；只有明确执行错误证据才归失败。attempt、最大重试数无来源返回null。
- 任务origin只根据显式source/基线成员关系生成 baseline/dynamic/gate_fix/decision_review/unknown；不能凭 T-/D-前缀判定。动态来源的proposalId、createdBy、createdAt历史缺失时保持null。
- Matrix、全部任务列表、执行任务卡片使用同一 TaskPage/counts/revision；16格首尾聚合是前端展示规则，不让server返回固定16条假数据。计数分母为当前任务图；baseline数量另列。
- Agent 是参与者，Conversation 是可打开的会话，Attempt 是一次执行。三者必须显式关联；batch 的 currentTaskId 只有最近任务，不能还原所有活跃Agent分配。
- Message 有稳定id/sequence/role、conversationId、status与blocks；role=user/orchestrator/executor/system。命令输出、文件diff、测试摘要、活动组、Agent活动、决策请求、结果摘要都是可选typed block。没有内容时显示不可用，不从宿主生命周期事件硬凑完整对话。

### 决策与动态复审

- Decision.status = pending/adopted/replaced/needs_validation/unknown；另保留 source、原始结果type/finality和applicationStatus。历史reject记录可展示已结束/原始结论，但新UI不提供无替代内容的独立拒绝动作。
- 当前决策门阀生成的 `decision_completed` 记录仍是 `status=pending_review`：AI生成结论不等于人已采纳。投影到pending，不能因event名称completed自动算adopted；动态规划端口的reviewed/applied要按其明确结论另行映射。
- `adopt` 记录操作者和作用对象；`replace` 必须 trim 后非空 alternative，记录旧结论、新内容、关联任务与是否需要后续验证。若动作会改任务图，沿用提案分析/hold/CAS，不能把任意文本直接当任务图patch。
- 决策与proposal关联：一般决策、瞬时AskUserQuestion、动态规划正式决策为不同source；source不支持的action返回409/能力禁用，而非统一转发到resolve。
- Proposal 已有状态：proposed、awaiting_approval、decision_required、decision_link_failed、applied_review_pending、applied、rejected、conflicted。列表必须区分“待批准”和“已应用待复审”。approve接口不能接复审通过。
- 复审建议动作 `pass` / `request_changes`，后者必须说明；**不回滚已执行历史**。修正应产生新的受约束提案/任务，并保留关联。是否必须给替代方案、是否暂停受影响任务、由谁处理修正仍待产品确认，Q03 标为 provisional。

### 日志与事件

- Run日志：调度、阶段、任务生命周期、决策/提案变化、控制动作等结构化事件。Agent日志：具体conversation/attempt的stdout/stderr/transcript/tool输出。不能混同宿主run.events与模型输出。
- LogEntry必须有id、runId、sourceId、seq、timestamp（缺失可null）、kind、text、level（原始输出可能unknown），可选task/agent/attempt关联。搜索q的范围是当前Run+所选源+级别；导出沿用完全相同筛选。
- 清屏仅记录前端visibleAfter cursor，刷新/重新打开可恢复；不定义删除日志接口。取消跟随不取消订阅，仍计未读；复制事件/选中事件详情已被用户移除，不提供对应功能接口。
- 事件建议 `{eventId,epoch,seq,projectId,runId?,type,at,resourceRevision?,payload}`。先取得snapshot游标，再从该游标补事件；WS提供重放握手或用HTTP补齐，去重按(epoch,seq)。检测gap/epoch变化后重新取snapshot，不能无限等待旧seq。
- 可订阅的快照响应必须在meta携带与该快照一致的eventCursor；不是先读快照再另取tailSeq。message.delta使用UTF-16代码单元offset和append文本，offset不连续时重取完整message；不假定网络分片边界就是消息边界。
- 第一版可以轮询聚合视图；不能因为已有WS就声称所有task/decision/proposal/message变化已实时推送。新增持久事件至少包含project/plan/run/task/decision/proposal/settings变化和message增量；信息不足可发invalidation并重取资源。

### 设置与状态栏

| UI项 | 建议归属/契约 | 现状与限制 |
| --- | --- | --- |
| 界面语言、恢复上次项目/Plan、高级指标开关 | 全局UI偏好；可同步存server | 无现有HTTP；当前选择先本地持久化，跨设备恢复待定 |
| 阶段显示 | 只读自动派生 | 不提供手工phase覆盖写接口 |
| 执行前确认 | 产品流程策略 | confirm-and-run仍需显式动作；若允许关闭确认需另定交互，不能先绕过 |
| Agent模式/上限 | execution.agentSelection + maxAgents，声明nextRun生效 | 当前max默认1；maxModules/maxPerModule/maxPerFeature也需保留，自动1–4未实现 |
| 动态任务允许与策略 | dynamicTasks.enabled + mode | 仅mode加载已有；enabled关闭的领域守卫缺失 |
| AI/人工决策 | decisionPolicy，操作生效点返回给UI | 不将decision.enabled直接映射为AI策略 |
| 额度保护 | quotaProtection策略+provider availability | 无账号额度采集/保护实现；应禁用并解释，不能用context%代替额度 |
| 日志保留30天 | retentionDays+清理能力 | 无设置/清理服务；保留期不影响活跃Run，清理策略需确认 |
| Git分支/加减行 | Workspace.git快照 | 根server没有对应HTTP；需新增或隐藏，不读取Figma例值 |
| ctx/token/速度 | metrics适配并标coverage/freshness | 有部分实测；token coverage=none时不显示“0消耗” |
| cache命中率/TTFT | 独立Metric，basis说明 | 缺明确cache比率契约和首token采样；null而非伪造 |
| 模型、Git、外观、通知、高级子页 | 仅导航占位 | 尚无具体UI字段，不猜一整套设置schema；通过supportedKeys逐项开放 |

## 7. 开发顺序与验收

1. **公共契约/身份**：project目录、显式作用域、ID映射、错误/幂等/版本、capabilities。打通初始页→检测→添加→选中；无项目不能误显示boot。
2. **读模型先行**：Workspace、Run、Tasks、Decision聚合与mock。覆盖空/加载/失败/部分可用、长文本、窄屏；任务页可以按当前已确认的列表职责实现，不等详细视觉。
3. **Plan→Run事务**：草案身份/生成、确认冻结、启动、持久Operation与恢复，接入pause/resume/中断的准确范围。
4. **对话/日志**：稳定源与会话/attempt映射、消息存储、分页、搜索、导出；有稳定事件游标后再接WS。
5. **决策/复审**：通用adopt/replace、动态高风险路由、部分成功恢复；产品确认复审处置后实现Q03。
6. **设置**：只开放有真实执行效果的字段，声明立即/下次Run/重启生效，做自动保存和冲突恢复。

必须验证的跨层场景：双项目同名task/decision不串；不存在runId不返回当前Run；断线/重启/事件环裁剪能重建；重复确认Plan只建一个Run；审批过程中无关任务完成不冲突、相关任务变动要冲突；替代决策空串422且不丢pending；override部分失败可恢复；暂停不伪称所有在途任务已停；Agent日志按attempt保留；设置保存失败回显失败而非已保存。

## 8. 尚需业务确认（不阻塞其余盘点）

- 初始页添加项目后：直接进入Plan输入还是停在项目空态？当前建议进入该项目空态，由“新建Plan”发起生成。
- 多Plan的历史/并行规则：建议同项目多个持久Plan、一次仅一个active Run，沿用现有host约束；是否允许切换编辑未运行Plan需确认。
- 停止方块是中断回答还是取消Run？建议明确两个语义，首版可只开放已实现且标明作用域的动作。
- 应用后动态任务复审的修正方式、暂停范围和责任人；Q03不能提前冻结为产品最终动作。
- 日志最终字段、raw/transcript展示边界、保留期及缓存命中率口径；没有数据的一律unknown。
- 设置“执行前确认可关闭”“自动Agent”“额度保护”“全局与项目覆盖”是产品需求，当前server尚未保证其效果。

## 9. 验证记录

已静态逐一检查根server的全部HTTP路由及WS入口，并对照宿主、注册表、状态原语、动态规划、决策存储、日志、指标、配置加载和当前Figma八页字段。没有启动真实执行、没有调用生产写接口。

定向测试结果及源文件hash见 evidence 文件。测试通过只证明已覆盖的现有行为，不代表上述建议 `/api/v1` 已实现；本轮也不声称完成新前后端联调。

- `server-api-routes` 32项、`server-ws` 4项、`server-replanning` 3项、`server-scheduler` 3项、`web-api-client` 13项，共55项通过。
- 首次HTTP/WS测试因沙箱禁止监听127.0.0.1而未执行；获准后用临时目录与mock重跑，36项全部通过。没有连接生产server或真实模型执行。
- 配套TypeScript经本地Babel TypeScript parser做语法验证；本地未发现tsc，本轮不将语法验证称为完整类型检查。文档本地链接及路由清单另行校验。
