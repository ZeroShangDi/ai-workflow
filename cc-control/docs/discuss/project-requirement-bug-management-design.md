# 项目需求与 Bug 管理设计

> 2026-10-03 · 设计稿，供另一模型实现。范围：Web 项目管理入口、需求与 Bug 生命周期、自动领取、Git 分支隔离、MCP 边界。本文不改变现有实现。

## 1. 设计结论

1. 项目管理是项目级导航空间，首版只有「需求」「Bug」两页；Run 中的 Bug 入口是同一份 Bug 数据的当前需求筛选视图。
2. 需求是长期工作对象，Plan/Run 是它的执行会话。需求只保留稳定业务状态 `draft → todo → in_progress → pending_acceptance → done`，另有 `failed / cancelled`。领取租约、Plan 运行、自动测试等是过程事实，不是需求状态。
3. Run 门禁发现的问题登记为 Bug，但修复权仍归当前 Run 的门禁派生任务。项目级日常 Bug 才进入空闲领取队列。两类 Bug 使用同一表，按 `origin` 和 `resolution_owner` 区分。
4. 新增与 `awf-state` 同级的 `awf-work` MCP，提供需求和 Bug 的受约束读写入口；Web、MCP、Run 事件适配器调用同一应用服务。同步适配层预留通过禅道、云效等外部 MCP 连接器导入/回写工作项的能力。
5. 决策保留 Hook 捕获为主入口。暂不把通用决策创建搬进 `awf-work`；若将来需要 Plan 或后台 Agent 显式登记决策，另加窄口令式写入接口，仍由同一个决策服务落账。
6. 自动执行的最小安全单元是独立 worktree 中的需求/修复分支。只有用户显式允许的单项才可闲时领取；AI 可以提交候选结果，最终验收与合并必须由人确认。目标分支从项目配置读取，不假定为 `develop`。

## 2. 现状与 GitHub 借鉴

当前 Web 左侧 `Sidebar` 展示项目，`ProjectSessions` 直接以输入文本创建需求并启动 Plan；`ViewRail` 展示会话/任务/决策等会话视图。数据库已有 `requirements`、`bugs`、`bug_tasks`、`workflow_sessions`，其中 Bug 可关联项目、需求、会话和任务。Run 的 review/test 门禁失败会自动派生 `source=gate_fix` 的 dev 任务，回退门禁再测，最多三轮。`awf-state` 直接负责 `.awf/state.json`，决策由 Hook 捕获并写入决策存储。

数据库另有 `product_issues` 及 `issues.promote()`（Issue 转需求），但目前 Web 工作区没有使用这套产品待办入口。新需求草稿直接落 `requirements`，避免“同一想法先有 Issue、后有 Requirement”带来的双身份；已有未转化的 `product_issues` 可在迁移时一次性导入草稿并保存 legacy ID 映射，已转化项只展示其 Requirement。不要同时从两个表拼出需求列表。

GitHub 可借鉴四点：Issue 作为可长期追踪的工作对象；类型、标签、负责人等属性和状态分开；父子关系与依赖显式展示；Project 的草稿项可先记录想法，成熟后再转为可执行项。AWF 只取这些关系模型，不照搬 GitHub 的多人协作字段和看板规模。这里的 Plan 是草稿进入待办的必经门禁，Run 才是执行活动。

参考：[GitHub Issues 概览](https://docs.github.com/en/issues/tracking-your-work-with-issues/learning-about-issues/planning-and-tracking-work-for-your-team-or-project)、[子 Issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues)、[Project 草稿项](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project)、[Project 自动化](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations)。

进阶能力可按需吸收：Issue [阻塞/被阻塞关系](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies)，Projects 的[自定义字段及表格、看板、路线图视图](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project)，[自动状态更新](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations)，[受保护分支所需审查与检查](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches)，以及高并发合并时的[合并队列](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)。首版优先做显式依赖、追踪字段和人工合并；路线图、自动化规则编辑器及合并队列留作后续扩展。

## 3. 页面与导航

### 3.1 入口和布局

- 在左侧文件/项目列表标题行右侧放 `···` 按钮，菜单首版只含「项目管理」。按钮须有 `aria-label`、键盘焦点、Escape/点外关闭。
- 点击后主内容切到项目管理空间，右侧窄导航只显示「需求」「Bug」；默认打开上次访问的项目管理页，否则需求页。会话空间原有 `ViewRail` 保持原样；二者通过 URL 中的空间和页面字段区分，刷新、浏览器前进/后退可恢复。
- 项目切换时保留当前空间与页面，但清空原项目的 `requirementId`、`sessionId`、`runId`、任务筛选等上下文。尚无项目时给添加项目入口；无需求时仍可进项目管理并创建草稿。
- `ProjectSessions` 中每个需求标题可进入需求详情；Run 页显示当前需求的 Bug 计数和查看入口。项目管理 Bug 页默认列出全项目 Bug，可按需求、来源、状态筛选。
- “创建需求 · Plan”改为「记下需求」和「开始规划」两步：前者只保存文本草稿，不启动会话；后者在草稿详情里启动 Plan。保留现有一键创建并规划作为快捷操作，但不得绕过需求对象创建。

### 3.2 需求页

需求页主视图是**看板**，列为「草稿、待办、执行中、待人工验收、已完成」，「失败/已取消」放可展开的异常/归档区，不挤占日常主流程。每列显示数量和卡片；卡片展示标题、优先级、AI 处理许可、任务进度、关联 Bug 数、最近活动，点击进入详情。看板顶部提供搜索与过滤；窄屏横向滚动，列内独立滚动。详情显示原始文本、Plan 产物（范围/验收标准/任务）、状态时间线、Plan/Run 历史、分支及关联 Bug。编辑已规划需求的实质内容会使旧 Plan 失效，回到 `draft` 并重新确认。

前端现状：React 18 + Vite，已有按钮、输入框、弹窗、状态标记与任务列表，但**没有看板组件，也没有拖拽依赖**。实现者应在 `web/src/pages/Requirements/components/` 下建 `Board`、`Column`、`Card`，共用现有基础 UI，不把任务列表硬改成看板。拖拽可采用 dnd kit 的 React 多列排序能力，支持键盘操作。列内拖拽只修改排序字段；跨列拖拽只开放以下**由人主动决定**的入口：

| 从 → 到 | 拖放语义 | 生效条件 |
| --- | --- | --- |
| 草稿 → 待办 | 打开并确认已生成的 Plan | Plan 完整且确认成功；未有 Plan 时提示先规划，卡片留原列 |
| 待办 → 执行中 | 立即手动启动 Run，不等闲时调度 | 使用同一 Git/worktree 安全流程；本次拖放就是启动指令，不再要求另点“允许 AI 闲时处理” |
| 待人工验收 → 已完成 | 打开验收与合并界面 | 人查看固定 HEAD 的结果并确认，合并成功后才移列；取消/冲突则留原列 |

执行中 → 待人工验收由 Run 结果驱动，不能人工拖；不能把草稿直接拖到执行中，也不能跳过验收。拖动不先乐观修改业务状态；服务端操作成功后再移列，失败时保留原列并显示原因。`requirements` 需增加可持久化的列内 `position/rank`，以及并发版本校验。

### 3.3 Bug 页

列表默认未验证优先，显示严重度、来源、归属（当前需求/项目级）、处理者、关联门禁任务、验证结果和分支。详情包含复现步骤、预期/实际、证据链接、发现环境、任务/提交/会话关系、状态时间线。创建时只要求一段描述，AI 可补全标题、复现信息和严重度，但补全失败不影响登记。相似问题提示合并；以来源事件幂等键强制防重复。

Run 页嵌入的是当前需求 Bug 列表的轻量视图：待处理、修复中、待人工验收、已关闭数；点击 Bug 打开同一个详情对象，保留 Run 上下文。项目管理 Bug 页可以看它和其他需求的 Bug，但 Run 来源 Bug 不出现在项目级自动领取队列。

## 4. 需求状态与流转

`draft → todo → in_progress → pending_acceptance → done`；另有 `failed / cancelled`。

| 状态 | 持久含义 | 转换条件 |
| --- | --- | --- |
| `draft` 草稿 | 已记录需求，Plan 尚未获确认；Plan 会话可启动、失败和重试 | Plan 内容与任务经确认后到 `todo` |
| `todo` 待办 | 已有可执行 Plan，尚未执行 | 用户手动开始或获准的闲时调度器启动 Run 后到 `in_progress` |
| `in_progress` 执行中 | Run 正在执行或等待恢复 | AI 提交代码、测试/审查证据后到 `pending_acceptance`；无法继续到 `failed` |
| `pending_acceptance` 待人工验收 | 有固定分支 HEAD、差异、测试和风险摘要；尚未获人确认 | 人拒绝并给反馈则回 `in_progress`；人批准并完成合并才到 `done` |
| `done` 已完成 | 人验收过指定提交，且已合入配置的目标分支 | 终态；新发现问题另建 Bug |
| `failed` 失败 | 自动执行或计划因明确错误无法继续，或门禁重试用尽 | 保存失败原因、日志和分支；人可恢复到 `draft/todo/in_progress` |
| `cancelled` 已取消 | 人决定不继续 | 保留历史和分支清理选择 |

`claimed` 是有 TTL 的调度租约；`planning` 是 Plan 会话活动；`verifying` 是测试/审查任务活动。这些不写入需求状态。若需要显示“阻塞”，用独立的 `blocked_reason` 与依赖关系，保留业务状态，并阻止自动调度；明确失败时再转 `failed`。`todo` 的硬条件是已确认 Plan revision、非空任务、验收条件和无未解决的阻断决策。

AI 的测试通过只意味着“已提交待验收”，不代表用户目标达成。人工验收页必须显示原需求、实现 diff、任务与测试结果、关联 Bug、已知风险、分支 HEAD 和目标分支。人的确认绑定精确 HEAD SHA；之后任何新提交都使确认失效。合并冲突、目标分支变化需要重新检查，合并失败继续留在 `pending_acceptance` 并展示原因。需求 `done` 只由人工确认后的合并结果驱动。当前 `startPlanSession` 会把需求改成 `in_progress`，实现时必须移除这条混淆规划与执行的路径；旧 `planned` 迁至 `todo`，旧 `in_progress` 要结合会话/任务事实迁移。

## 5. Bug 来源、所有权与闭环

| 来源 | 建立关联 | 谁修改代码 | 谁推进状态 |
| --- | --- | --- | --- |
| Run 测试/审查门禁 | `origin=run_gate`，关联 requirement、session、gate task、verdict | 现有 `gate_fix` 派生任务，在同一需求分支 | 门禁事件适配器：发现 `open` → 派生执行 `in_progress` → AI 复测通过 `pending_acceptance`；三轮失败 `failed`；人验收并在所属需求合并后 `closed` |
| Run 中人工/Agent 发现且影响当前验收 | `origin=run_observation`，绑定当前需求 | 纳入当前 Run 的修复任务/门禁链 | 同上；必须先登记再派生，不能另启空闲 Bug worker |
| 日常项目问题 | `origin=project_report`，`requirementId` 可空 | 空闲调度器创建独立修复工作项并在 `bug/<id>-<slug>` 分支处理 | AI 修复后 `pending_acceptance`，人审查并合并后 `closed` |

核心约束：一个 Bug 同时只能有一个 `resolution_owner`（`run_gate` 或 `independent_run`）和一个有效 claim。`run_gate` 来源绝不进入空闲领取；项目 Bug 若后来被当前需求碰到，要经原子“转交”操作，绑定需求并撤销独立领取（已有独立执行时先停在冲突待审，不做双修复）。一个 verdict 可含多个问题，按证据锚点形成多个 Bug；无法可靠拆分时先登记一个聚合 Bug，后续可拆分并留关系。门禁 `pass` 只验证它覆盖的 Bug；未列入覆盖范围的 Bug 不自动关闭。

Bug 的稳定状态首版为 `open → in_progress → pending_acceptance → closed`，另有 `failed`。`open` 表示待处理；`in_progress` 表示修复 Run 在执行；`pending_acceptance` 表示 AI 已提交修复和复测证据，待人检查；`closed` 仅表示人已给出关闭裁定。通常的修复关闭还要求指定提交已合入目标分支。对 Run 内 Bug，允许人在需求验收时批量逐项确认，但每条 Bug 都要有明确确认记录；需求分支尚未合并时仍留 `pending_acceptance`。人驳回修复回 `in_progress`；三轮修复失败或独立 Run 无法继续则 `failed`，可由人重试。`不予修复`、`重复`、`设计如此`、`无法复现`等是**关闭事件的解释**，不是状态枚举，也不必新增状态字段；重复问题以关联关系指向主 Bug。Bug 的每次转换记录事件和证据，关闭原因写在关闭记录里；删除只允许软归档。

[禅道 Bug 手册](https://www.zentao.net/book/zentaopms/167.html?fullScreen=zentao)区分 Bug 的解决、验证、关闭，并将“重复 Bug”“不予解决”等列为解决方案；[云效缺陷管理](https://help.aliyun.com/zh/yunxiao/use-cases/7-how-does-technology-manage-defects)给出“待确认→处理中→已修复→已关闭”的正常流转。AWF 用 `pending_acceptance` 表达“AI 认为已修复，待人裁定”，不能自动关闭。旧 `fixed`/`verified` 的迁移必须审查历史证据；没有人工确认记录的旧 `verified` 也不应直接视为新语义的 `closed`。严重度只衡量影响，自动领取优先级还需考虑可复现性与预估工作量。

项目级 Bug 的独立修复需要任务归属。当前 `tasks.requirement_id` 非空且 Run 必须绑定需求，因此首版用**内部维护工作项**承载该 Bug 的 Plan/Run（`requirement.kind=bugfix`、`origin_bug_id`），不把它显示在普通需求列表；Bug 详情展示对应执行记录。这样复用现有 Run、任务和门禁，不去放宽任务外键。该内部工作项只为执行建模，Bug 仍是项目问题的唯一用户可见身份。

## 6. 空闲自动领取与 Git 流程

### 6.1 资格与并发

自动领取权限是**每项显式 `allow_ai_work=true`，默认 false**。只领取 `todo` 需求，或来源为 `project_report` 且状态 `open` 的项目 Bug。还须满足：项目 Git 已配置且目标分支存在、计划/复现信息足够、没有阻断决策或依赖、该项没有活跃租约、项目 Run 槽位和全局资源配额可用。Run 来源 Bug 归当前 Run 派生任务，永不参加候选。主工作区有未提交改动不阻止隔离分支执行，因为 worktree 基于已提交的目标分支；但这些改动会阻止之后在主工作区合并。

领取在数据库事务中做条件更新并创建持久租约（owner、token、TTL、heartbeat、attempt），先占槽再建 worktree；建工作区或启动 Run 失败须释放租约并记录失败事件，避免反复无间隔重试。重启后先核对租约、会话、分支 HEAD 和 worktree，再恢复或回队。首版 `maxConcurrentPerProject=1`、`maxConcurrentTotal=1`；全局值可配置，同项目值保持 1，直到 Run state/会话按工作项隔离。当前宿主对同项目第二个 Run 返回 409，共用 `.awf/state.json`；不同 worktree 也不能绕过逻辑项目身份和持久化路由问题。Run 内的多 Agent 并行额度与“同时领取多少工作项”是两个独立配置。

### 6.2 Git 前置检查与工作区

在配置中显式保存 `git.repositoryRoot`、`git.projectRelativePath`、`git.targetBranch`、`automation.maxConcurrentTotal`；不要假设目标是 `develop`，也不要把 AWF 项目目录误当成 Git 根。本仓库的 `cc-control` 就是更大 Git 仓库的子目录。领取前校验项目确实位于该 Git 仓库、仓库有有效初始提交、目标分支/提交存在、工作分支名不冲突。没有 Git、仓库无初始提交、目标分支未配置或不存在时，标记“仓库配置待处理”，不自动 `git init`、不自动创建初始提交或猜测分支；草稿、Plan 和 Bug 登记仍可用。界面提供用户主动设置/初始化仓库的入口。

从目标分支记录 base SHA，使用 `git worktree add -b feature/<id>-<slug> <managed-path> <target>` 或 `bug/<id>-<slug>` 创建位于仓库外的托管工作区；项目工作目录是该 worktree 下的 `projectRelativePath`。工作项记录 repository root、worktree path、branch、base/head SHA、Run ID。Run、MCP、Hook 全部指向该项目目录，工作区内有独立 `.awf/state.json` 与会话；数据库中的逻辑项目 ID 仍映射回原项目，不能因为 worktree 路径不同创建“第二个项目”。这要求运行时分清逻辑项目身份与物理 checkout 身份。若现有代码还未完成此隔离，只能保持每项目单槽，并在启动前完成映射，不允许假装 worktree 已解决状态冲突。分支存在但工作区失联时先恢复/认领，不能创建同名新分支。

### 6.3 复用现有流程与人工合并

需求复用已批准的 Plan，不重复生成；把对应任务投影到该 worktree 的 Run state 后调用现有 Run 宿主。项目 Bug 建一个不出现在普通需求列表的内部 `bugfix` 工作项，在单项“允许 AI 闲时处理”的授权内，以 Bug 描述生成小型修复计划，再复用同一 Run 与门禁；最终结果仍由人验收。Run 内 Bug 继续使用所属需求的现有 `gate_fix` 链，绝不启动第二个 Run。

AI 完成后只生成固定 HEAD 的验收包：原目标、差异、任务、测试/审查证据、Bug、未解决风险、base/head SHA。人的操作是“驳回并给反馈”或“确认此结果可合并”。确认后才尝试合并到配置目标分支；目标变化、冲突、测试失效、主工作区不干净或分支 HEAD 变化时停止合并并保留 `pending_acceptance`。本地仓库在目标分支所处工作区干净时执行合并；远端仓库可提供 PR 供人审查/合并并同步结果。AI 不自动推送、强推或合并，不能直接更改目标分支。成功合并并记录 merge SHA 后，需求 `done` 或项目 Bug `closed`；人审过的 Run 内 Bug 随所属需求合并而 `closed`。

## 7. `awf-work` MCP 与决策边界

`awf-work` 与 `awf-state` 同级注册在 core 插件，但工具应通过本地应用服务访问项目数据库，Web API 也调用该服务；不能直接写 `.awf/state.json` 或另建 JSON 副本。服务端用 checkout/projectRoot 解析原逻辑项目 ID，并校验所有引用同属该项目；每项写操作需预期 revision、幂等键、actor、来源事件 ID，返回新 revision 与活动事件。推荐最小工具面：

| 工具 | 作用 |
| --- | --- |
| `awf_work_list` / `awf_work_get` | 按 `requirement/bug`、项目/当前需求和状态读取，分页、摘要默认 |
| `awf_requirement_create_draft` / `awf_requirement_update_draft` | 只创建/改草稿，不启动 Plan |
| `awf_requirement_request_plan` | 经现有 Plan 服务启动/重试，服务端推进状态 |
| `awf_bug_report` | 日常或 Run 中登记 Bug，绑定证据并去重 |
| `awf_work_claim` / `awf_work_release` | 仅调度器或授权 Agent 使用，租约原子化 |
| `awf_bug_link_task` | 绑定发现/修复/验证任务；状态由结果事件推进 |

不要提供任意 `set_status` 工具。复杂转换（Plan 批准、Run 开始、门禁修复、测试通过、合并）由已有服务或新工作流服务执行，然后统一追加工作项事件。MCP 工具是 AI 的操作面，Hook/Run 事件仍可调用同一服务，因此没有两套规则。`awf-state` 继续只管当前 Run 任务图；需求/Bug 数据库是长期事实源，Run state 和 SQLite 的同步由事件处理器负责，需可重放/补偿失败同步。

### 7.1 外部 MCP 同步适配层

`awf-work` 同时是 AWF 对 AI 暴露的 MCP 入口，以及未来外部同步的领域边界；**暴露 MCP Server 本身不会自动同步外部平台**。服务端另设同步协调器，通过禅道/云效提供的 MCP 工具作为外部客户端，或经同等受控 API 适配器交换记录。结构建议为 `work domain service ← sync coordinator → provider adapter (zentao/yunxiao)`，Web、Run、MCP 都只写 work domain service。首版可只定义 provider 接口与映射表，不必连接任何外部账号。

同步记录保存 `{provider, externalProjectId, externalItemId, localType, localId, lastSeenRevision, lastSyncAt}`；同一外部记录重复导入只能命中同一内部对象。同步采用增量游标、幂等事件和来源标记，防止 AWF 写出后被回读成第二次变更。外部标题、描述、优先级、评论可按配置同步；Run 归属、AI 领取租约、测试结果、人工验收与合并结果由 AWF 掌握，外部状态变化须映射成合法业务命令，不能直接覆盖本地状态。双方同时修改时留冲突待人处理，并展示来源和差异。外部系统不可用时本地工作仍可进行，待恢复后重试同步；不允许同步故障替人确认验收。

决策方案比较：

| 方式 | 优点 | 代价与风险 | 结论 |
| --- | --- | --- | --- |
| Hook 捕获 | 能拦截提问和 Stop，保留真实会话上下文；现有门禁、人工/AI 路由已在此 | 依赖平台 Hook；后台非交互 Agent 可能漏事件；截取文本不一定完整 | 继续作为运行中决策的主入口 |
| MCP 显式创建 | 可结构化输入、幂等、平台可移植，适合后台规划/跨会话决策 | 模型可能不调用或事后补记；无法替代提问拦截；与 Hook 双写会重复 | 仅在明确需要时补充窄工具，不迁移拦截职责 |

如增加显式决策写入，建议放独立 `awf-decision` 或现有 `awf-session` 的决策域，而非塞进 `awf-work`：二者可关联 requirement/bug，但生命周期不同。统一 `decisionId` 和来源事件幂等键，Hook 与显式入口共享一个决策服务，避免双份记录。决策若阻断某需求/修复，建立显式 `blocks` 关联，调度器据此暂停领取或继续。

## 8. 实施顺序与验收

1. 数据迁移与领域服务：需求状态迁移、旧 `product_issues` 转草稿策略；Bug 来源、所有者、事件、revision、claim、证据和工作项关联；补项目/需求/会话引用校验与幂等。
2. Web 入口与两个页面：URL 空间切换、草稿保存、Plan 请求、需求看板与卡片详情、Bug 列表/详情/筛选；Run Bug 只读投影和详情跳转。
3. Run 事件接线：门禁 verdict 创建/复用 Bug，派生任务和复测结果驱动 Bug 状态；修复上限可见。
4. `awf-work` MCP：共享服务、项目隔离、受约束工具、并发 revision 和幂等；Web 与 MCP 同数据。
5. 空闲调度与独立项目 Bug 修复：先手动领取和分支/worktree 跑通，再加自动领取；合并门禁单独上线。

验收场景：草稿不会启动会话；Plan 批准后卡片才进待办列；待办拖入执行中立即手动启动 Run，且无需开启闲时许可；领取不成为业务状态；看板列内排序可持久化，非法跨列拖放不会改状态，键盘也能完成排序；同一门禁重复事件只生成一个 Bug 和一条修复链；AI 复测通过后 Bug 仍待人工验收；重复/不修复只记录关闭解释，不产生额外状态；项目级 Bug 仅被一个 worker 领取；无 Git/无目标分支不自动初始化或执行；子目录项目的 worktree 仍关联原逻辑项目；切换项目不串数据；服务重启后租约、状态和事件可恢复；人未确认或分支未合并时需求不显示完成；未来外部同步重复投递不会生成第二条需求/Bug，外部状态不能绕过人工验收。

## 9. 实现时需对照的现有位置

- 导航：`web/src/layouts/WorkspaceLayout/components/Sidebar.jsx`、`ProjectSessions.jsx`、`ViewRail.jsx`、`web/src/app/routes.js`、`web/src/app/hooks/useAppShell.js`。
- 数据：`server/persistence/schema/001_initial.sql`、`server/persistence/repositories/requirements.cjs`、`bugs.cjs`、`server/application/persistence.cjs`。
- Web/Run：`server/web/api/persistence.cjs`、`server/features/gate/closure.js`、`server/features/gate/fix.js`、`server/run/host.cjs`。
- MCP/决策：`plugin/core/mcp/awf-state/server.cjs`、`server/adapters/cc/plugin/config.json`、`server/web/api/hook.cjs`、`server/features/decision/store.cjs`。

`server/adapters/cc/plugin/core` 是构造产物；插件源应改 `plugin/core` 和配置源。现有工作区有未提交改动，实施者先核对这些文件的最新状态，避免覆盖正在进行的 Web/决策修改。
