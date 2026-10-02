# SQLite Persistence Design (Proposal)

> Status: the standalone persistence module and the primary Server/Web/CLI workflow integrations are implemented. MCP continues to call Server and does not access SQLite directly. Existing project-local files are still used for state compatibility and large logs/reports; historical file-to-database import and cross-device synchronization are not implemented. The device-local database file is `~/.awf/awf.sqlite`, shared by multiple projects on that device; SQL schema and migration source files live under `server/persistence/schema/`.

> **Architecture revision:** The user-story model in §2 is authoritative. A *workflow session* is the durable plan/run conversation; a process restart is an attempt within that same session, not a new session. The table set in §2A supersedes earlier plan-centric assumptions.

## 1. Goals and constraints

- Use one device-local database for business data: `~/.awf/awf.sqlite`. It stores records for multiple projects and local checkouts on that device. The implementation uses Node's built-in `node:sqlite` and adds no npm dependency. Node 24.14 still emits an experimental API warning; Node 24.15 makes the API a Release Candidate. This database is not shared or synchronized between devices.
- Keep existing HTTP, MCP, and CLI behavior initially. Repositories map SQL rows to the current JSON objects so consumers do not need a simultaneous rewrite.
- Run every write in a transaction. A task/plan/decision state change and its corresponding event must commit atomically. List APIs support filtering and pagination.
- Use foreign keys, unique constraints, and `CHECK` constraints where they can reliably express invariants. Domain code validates JSON extension fields. On every connection configure `foreign_keys`, WAL, `busy_timeout`, and check `user_version`.
- Keep the database inside the trusted local process boundary. Do not expose arbitrary SQL. Bind all parameters and continue validating paths, IDs, and filenames.

## 2. Persistence boundaries

| Current data | First-phase treatment | Notes |
|---|---|---|
| `.awf/state.json`: workflow state, plan, WBS, milestones, tasks | Migrate to `requirements`, `tasks`, `task_dependencies`, `requirement_milestones`, and `milestone_tasks`; project metadata to `projects` | State JSON becomes a compatibility projection; WBS moves to project architecture; no plan-history snapshots |
| `.awf/decisions/runs/*.jsonl` | Migrate to `decisions`, `decision_events` | Preserve append-only lifecycle events and original result JSON |
| `.awf/dynamic-planning/proposals/*.json` and `events.jsonl` | Migrate to `proposals`, `proposal_events` | Proposal is a mutable snapshot; events are immutable history |
| `.awf/logs/*/run-meta.json` | Migrate session/attempt metadata to `workflow_sessions`, `session_attempts`, and optional agent records | Process restart does not create a new workflow session |
| `main.log`, agent transcripts, subagent JSONL | Keep as files | Large text and external tool output remain files; the DB stores run paths and metadata |
| `.awf/config.json`, `run-settings.json` | Keep as files | Configuration sources and rendering have separate lifecycles |
| `.awf/versions/*.json` | Keep as file backups initially or retire later | No requirement revision table or plan-history snapshots in v1 |
| `.awf/context/*`, reports, user deliverables | Keep as files | These are large content or deliverables, not database records |

## 2A. Domain model, keys, and user story

### User story and ownership

The hierarchy is:

```text
Logical Project
├── Project Environments / Checkouts (one per machine and actual directory)
└── Requirement (a durable product request)
    ├── Plan Session (one planning conversation)
    ├── Run Session (one execution conversation; may have multiple restart attempts)
    ├── Tasks (planned work; executed by one or more run sessions)
    ├── Decisions (may concern a requirement, task, session, or bug)
    ├── Bugs (observed defects, linked to the work that found or fixes them)
    └── Requirement / Task events and file-backed logs/reports

Logical Project
├── Project Architecture Tree (WBS; independent of any one requirement)
└── Product Issues / Backlog Items
    └── may be promoted into a Requirement when work is planned
```

A **requirement** is the durable unit that groups the user's intent and its evolution. It owns the shared requirement state and a set of plan/run sessions. The initial `plan` session creates or revises the plan and tasks. A `run` session executes those tasks. If execution stops and resumes, it remains the same run session, retaining its identity and log association; append a new `session_attempt` for each process/adapter restart. A later deliberate execution of the same requirement may create another run session.

Do not equate the AWF workflow session with a provider conversation. A Claude Code or DSH conversation can be replaced, resumed, or unavailable. Store its provider and external conversation ID as an optional mapping on the workflow session (or in a `session_conversations` child table if one workflow session can use multiple provider conversations). Internal AWF IDs remain authoritative.

### Key audit of the current code

| Concept | Current representation and behavior | Design consequence |
|---|---|---|
| Project root | A filesystem path passed as `projectRoot`, commonly from `CC_PROJECT` or `cwd`; used for runtime routing and to locate `.awf/` | It is a **local checkout locator**, not a durable project ID. Paths differ between machines and may move. |
| Logical project ID | No durable first-class ID found in the current persistence model | Add a generated `project_id`; keep per-machine environment and checkout records separately. |
| Run ID / `sid` | `submitRun` accepts an optional caller ID and otherwise currently falls back to `'default'`; CLI has optional `--run-id`. Other code has `generateRunId`/`resolveRunStamp`, but they are not consistently the host's persisted run identity. | There is no reliable, durable run ID contract yet. Generate one internal UUID/ULID at run-session creation and use it everywhere. |
| Run stamp | Timestamp-like string derived from version and time (seconds precision); names log/decision files. `resolveRunStamp` returns explicit sid or derives this stamp. | It is a legacy display/path label, not an identity. It can collide and must not be a primary or foreign key. |
| Provider conversation/session ID | `session_id` from Claude hooks is stored as `mainSessionId`; DSH returns `sessionId`. It identifies a provider-side conversation, not a requirement or AWF workflow session. | Preserve as nullable `external_conversation_id` with `provider`; never use it as the workflow primary key. |
| Message ID | No consistent AWF-persisted message identifier was found in the inspected server/CLI/web paths. | Do not invent a provider message key requirement. Internal events get their own IDs. Add optional `external_message_id` only when an adapter actually supplies it and there is a concrete deduplication need. |
| Decision ID | Decision store has `decision_id` (`D-...`) and JSONL lifecycle events; records are grouped by runStamp and overrides locate the original run file. | Keep a stable internal `decision_id`; relate the decision to its requirement/session, and optionally to multiple tasks via a join table. Remove runStamp from ownership semantics. |
| Task ID | Task IDs are strings such as `T1`; uniqueness is effectively within the current state document, not globally guaranteed. | Scope task identity by requirement (`UNIQUE(requirement_id, task_key)`) or assign an internal ID plus a human-facing task key. |
| Event sequence | Run host events use an in-memory sequence counter/ring; it resets with the process and is not durable. | Persist durable `event_id` and per-session monotonic sequence; keep ephemeral stream cursor separate. |

Code reviewed for this audit includes `server/shared/run-id.cjs`, `server/shared/run-context.cjs`, `server/shared/project-paths.cjs`, `server/run/host.cjs`, `server/features/decision/store.cjs`, `server/web/api/hook.cjs`, and CLI run/session setup. These findings describe current implementation, not desired long-term semantics.

### Proposed canonical identifiers

- `project_id`: stable UUID for a logical repository/project, stored in `.awf/project.json` (small identity manifest suitable for copying with the project). Do not derive it from `projectRoot`, Git remote, or directory name.
- `environment_id`: generated per installation/device, stored outside the repository in the user's AWF home/config area. `environment` records machine label and optional metadata; avoid collecting sensitive hardware identifiers.
- `checkout_id`: generated per actual project directory on a machine; unique `(environment_id, project_id, canonical_root_path)`. The path is mutable and local. A moved directory updates the checkout record rather than changing `project_id`.
- `requirement_id`, `workflow_session_id`, `task_id`, `decision_id`, `bug_id`, `issue_id`, `event_id`: opaque generated IDs (UUID/ULID); human labels such as `T1` are separate scoped keys.
- `run_stamp`: legacy/import/display field only. A run is a workflow session with `session_kind='run'`; there is no second competing `run_id` concept. During compatibility, old run IDs/sids are aliases recorded in `legacy_ids` or `session_aliases`.
- `provider_conversation_id` and optional `provider_message_id`: adapter-provided external identifiers, nullable, namespaced by provider. They never substitute for internal IDs.

### Same project on two computers: recommendation

Model this now, but do **not** claim automatic cross-device handoff in the first implementation. Store the small `.awf/project.json` identity manifest with the project so Git clones share the same logical `project_id`. Each device has its own `environment_id`; its global `~/.awf/awf.sqlite` tracks multiple projects and their local checkout paths. The DB remains outside project repositories, so cloning a project does not copy that machine's database or synchronize business records. SQLite is not a multi-computer replication protocol, and putting a live WAL database in a Git repository or network share is not a safe sync design.

For the future handoff story, choose a synchronization transport separately (for example, a hosted service or an explicit export/import bundle). The schema should use stable IDs, immutable events, `origin_environment_id`, and `created_at` so a later sync can merge records. Concurrent edits still need explicit conflict policy; a timestamp alone is not a conflict-resolution strategy. Until that transport exists, clearly scope each DB to the local machine and provide backup/export/import rather than silently suggesting records follow the user.

**Should the SQLite file itself be committed to Git?** It can move with sequential commits in a single-writer workflow, but it is a binary database: Git cannot merge rows from two concurrent copies. A live WAL database also has sidecar files and checkpoint/backup rules. Therefore the recommended default is to ignore `~/.awf/awf.sqlite` and keep only a small `.awf/project.json` manifest (stable UUID and manifest version) in Git. If simple sequential handoff by `pull → work → close/checkpoint → commit → push` is later chosen, a tracked SQLite file can be evaluated as a constrained transport, with explicit backup/merge-conflict recovery; it is not a safe multi-writer sync design.

A normalized Git remote URL may be stored as an alias or used to suggest that two checkouts are the same project, but it should not be the canonical ID source. A project can have no remote, several remotes, renamed/mirrored remotes, forks, or private aliases. Generate `project_id` once and carry it in the manifest; use remote URL comparison as a hint for linking, with user confirmation when IDs differ.

#### Can two SQLite files be merged?

Rows can be imported from one database into another, but bytewise concatenating two `.sqlite` files does not produce a valid merged database, and SQLite cannot decide which conflicting edit should win. `ATTACH DATABASE` lets one connection access another DB file; the application still has to read rows, insert/update them, and handle foreign keys and duplicate primary keys. SQLite's `sqldiff` tool compares DB differences; it does not make business conflict decisions.

The SQLite Session Extension can create a changeset for databases with the **same schema and compatible starting data**, then apply those changes to another database. Conflicts can still occur for primary keys, unique/foreign-key constraints, and concurrent edits to the same fields. The application must choose to abort, omit, or replace conflicting changes. This is not automatic conflict-free merging; before adopting it, verify that the selected Node driver exposes the required APIs.

For this model, append-only `decision_events` and `domain_events` could be candidates for merging with stable event IDs, origin environment IDs, and deduplication rules. Concurrent edits to the same `requirement`, `task`, or `issue` still need domain conflict rules. If seamless multi-device collaboration becomes a requirement, a central sync service is usually easier to make consistent than exchanging whole SQLite files.

### Database file versus SQL source location

- **Runtime database:** use the device-level `~/.awf/awf.sqlite`. One local DB stores several projects; `project_id` separates them and `project_checkouts` maps each to its local directory. This centralizes permissions and backups and survives a project's directory moving.
- **Schema/migration source:** keep versioned SQL files in `server/persistence/schema/` and track them with application code. They define how to create/upgrade DB instances; they are not the database itself.
- Do not put the DB in a project root or project `sql/` directory. The DB is machine-local binary runtime data; `sql/` is a natural place for SQL source, and Git cannot merge concurrent SQLite file edits.
- Keep `~/.awf/awf.sqlite` outside Git. Do not copy a live database as a backup; use SQLite's backup API.

### Required relationships and cardinality

| Relationship | Cardinality / rule |
|---|---|
| Project → environment/checkouts | One logical project has many checkouts; each checkout belongs to one environment and one project. |
| Project → architecture WBS | One current project architecture tree per project, with parent-child nodes. WBS is not embedded in requirement state. If architecture history is needed later, version the tree explicitly. |
| Project → requirements | One project has many requirements. |
| Requirement → workflow sessions | One requirement has many sessions; session kind is `plan` or `run`. At most one active plan session may edit a given requirement at a time. |
| Run session → attempts | One run session has many attempts. Interrupt/restart adds an attempt but keeps the same session and aggregate log directory. |
| Requirement → tasks | One requirement owns its task list. Keep task keys unique within a requirement; task execution records link tasks to the run session/attempt that executed them. |
| Task → dependencies | Many-to-many self relationship, ordered, acyclic; all endpoints must belong to the same requirement. |
| Decision ↔ task | Many-to-many via `decision_tasks`, with a relation role (`blocks`, `informs`, `supersedes`, etc.). A decision can concern multiple tasks, and a task can have multiple decisions. Keep a primary `requirement_id`; session/run and bug links are optional. |
| Bug ↔ task/session/decision | A bug belongs to a project and normally a requirement; use `bug_tasks` to link discovery/fix tasks and optional decision links. Preserve found-in and fixed-in run session references. |
| Product issue → requirement | An issue is a backlog item independent of execution. Promotion creates/links a requirement; retain `source_issue_id` and a conversion event rather than changing the issue's identity. |
| Logs/reports → session/attempt | File metadata can reference session/attempt/task; actual log and review report contents remain under `.awf/` in the session's stable directory. |

Decisions and bugs should have append-only event histories, in addition to mutable current status fields. This supports process improvement analytics without rewriting old conclusions. Tasks, requirements, issues, and sessions should also emit domain events for meaningful transitions; do not persist every UI poll as an event.

### Canonical table set (replaces the earlier draft)

The v1 schema should be centered on these tables and keys; finalize column details only after the requirements/state JSON inventory is complete:

| Table | Key fields and purpose |
|---|---|
| `projects` | `id` = `project_id`; logical project identity, current name/status, and optional `active_requirement_id` used only by legacy single-requirement views |
| `environments` | `id`; one installation/device identity; no absolute project path here |
| `project_checkouts` | `id`; `project_id`, `environment_id`, local `root_path`, `canonical_path`, `last_seen_at`; unique per environment/project/path |
| `project_architecture_nodes` | `id`; `project_id`, nullable `parent_id`, stable node key, title/description, position, attributes JSON; one project-owned tree |
| `requirements` | `id`; `project_id`, title, request, status, `state_json` or normalized requirement fields, `revision`, timestamps; shared source for plan and run |
| `workflow_sessions` | `id`; `requirement_id`, kind (`plan`/`run`), status, `origin_environment_id`, started/ended timestamps, `log_dir`, current attempt, revision |
| `session_attempts` | `id`; `workflow_session_id`, attempt number, environment, process/adapter details, start/end/status/error; unique `(workflow_session_id, attempt_no)` |
| `session_conversations` | `id`; `workflow_session_id`, provider, external conversation ID, optional metadata; unique provider/external ID within its appropriate scope |
| `tasks` | `id`; `requirement_id`, scoped `task_key`, status/kind/title/prompt/acceptance, payload JSON, position and timestamps; unique `(requirement_id, task_key)` |
| `task_dependencies` | `(task_id, depends_on_task_id)` plus position; same-requirement FK enforced by repository/trigger or composite scoped keys |
| `task_commits` | `id`; `task_id`, hash, message, position; preserves current task commit list |
| `requirement_milestones` | `id`; requirement, description, status, position; migrates current state milestones |
| `milestone_tasks` | `(milestone_id, task_id)` and position; links milestone to tasks without storing task ID arrays as JSON |
| `task_executions` | `id`; task, workflow session, attempt, status/result/verdict, started/ended timestamps; one task can be retried or resumed across attempts |
| `decisions` | `id`; `project_id`, required `requirement_id`, optional session/attempt, decision type/status/result JSON, timestamps |
| `decision_tasks` | `(decision_id, task_id, relation)`; records which tasks a decision informs, blocks, or supersedes |
| `decision_events` | `id`, `decision_id`, sequence, event type, payload JSON, actor, timestamp, origin environment; immutable lifecycle/audit history |
| `proposals` / `proposal_events` | Mutable dynamic-planning proposal snapshot plus append-only proposal history |
| `bugs` / `bug_tasks` | Bug identity and current state; join roles for discovered-by/fixed-by/verified-by tasks; optional session and decision references |
| `product_issues` | `id`, `project_id`, title/body/status/priority, optional `source_requirement_id`, timestamps; backlog identity remains stable through promotion |
| `issue_events` | Immutable issue lifecycle events, including promotion into a requirement |
| `domain_events` | `id`, `project_id`, optional requirement/session/attempt, aggregate type/id, sequence, event type, payload, occurred/recorded timestamps, origin environment; durable business events, not transient UI ticks |
| `artifacts` | Optional metadata only: owner/session/attempt/task, local `checkout_id`, relative path under `.awf`, type, size, digest, timestamps; bytes stay in files |
| `legacy_ids` | `(entity_type, legacy_id)` → internal entity ID; preserves old sid/runStamp/task aliases during import |
| `schema_migrations` | Schema migration version/name/time |

All cross-record ownership paths should be queryable through explicit foreign keys or join tables. Avoid stuffing task IDs, decisions, bugs, or WBS IDs into opaque JSON arrays. JSON columns are appropriate for provider payloads and evolving details, not primary relationships.

### Field catalog (v1 proposal)

Conventions: `TEXT` / `INTEGER` are SQLite types; `?` means nullable; `PK` primary key; `FK` foreign key. IDs and timestamps without an explicit SQL default are generated by the persistence API (UUID/ULID and UTC ISO-8601). JSON is validated JSON text. Fields are grouped only where their type/default are identical; each name in a grouped row is a separate column. Defaults shown are proposed defaults.

| Table | Field (English) | 中文名 | Type | Default / rule | Description |
|---|---|---|---|---|---|
| `projects` | `id` | 项目 ID | TEXT | generated, PK | Stable logical project identity. |
|  | `name` | 项目名 | TEXT | `''` | Display name. |
|  | `status` | 状态 | TEXT | `'active'` | `active` / `archived`. |
|  | `active_requirement_id` | 当前需求 ID | TEXT | NULL, FK | Legacy API selector only. |
|  | `created_at`, `updated_at` | 创建/更新时间 | TEXT | API timestamp | UTC timestamps. |
| `environments` | `id` | 环境 ID | TEXT | generated, PK | Per-installation ID; no hardware fingerprint. |
|  | `name` | 环境名 | TEXT | `''` | User label such as home/work. |
|  | `created_at`, `last_seen_at` | 创建/最近使用时间 | TEXT | API timestamp | Device record lifecycle. |
| `project_checkouts` | `id` | 目录记录 ID | TEXT | generated, PK | Local checkout record. |
|  | `project_id`, `environment_id` | 项目/环境 ID | TEXT | required, FK | Logical project and machine. |
|  | `root_path`, `canonical_path` | 本地根目录/规范路径 | TEXT | required | Local locator; not a project identity. |
|  | `created_at`, `last_seen_at` | 创建/最近使用时间 | TEXT | API timestamp | Checkout lifecycle. |
| `requirements` | `id` | 需求 ID | TEXT | generated, PK | Durable user-intent identity. |
|  | `project_id` | 项目 ID | TEXT | required, FK | Owning project. |
|  | `title`, `request_text` | 标题/原始需求 | TEXT | required | User request and display title. |
|  | `summary` | 需求摘要 | TEXT | `''` | Refined summary. |
|  | `scope_json` | 范围与验收 | TEXT | `'{}'` | In/out of scope and acceptance criteria. |
|  | `status` | 状态 | TEXT | `'draft'` | `draft/planned/in_progress/done/archived`. |
|  | `revision` | 修订号 | INTEGER | `1` | Optimistic concurrency version. |
|  | `created_at`, `updated_at` | 创建/更新时间 | TEXT | API timestamp | UTC timestamps. |
| `requirement_milestones` | `id`, `requirement_id` | 里程碑/需求 ID | TEXT | generated PK / required FK | Requirement-owned milestone. |
|  | `description`, `status`, `position` | 描述/状态/顺序 | TEXT / TEXT / INTEGER | `''` / `'active'` / `0` | Status `active/done`; display order. |
| `milestone_tasks` | `milestone_id`, `task_id` | 里程碑/任务 ID | TEXT | required, FK, composite PK | Many-to-many task membership; `position` INTEGER DEFAULT `0`. |
| `workflow_sessions` | `id` | 会话 ID | TEXT | generated, PK | Stable AWF plan/run session ID. |
|  | `requirement_id` | 需求 ID | TEXT | required, FK | Shared requirement context. |
|  | `kind` | 类型 | TEXT | required | `plan` or `run`. |
|  | `status` | 状态 | TEXT | `'created'` | `created/active/interrupted/completed/failed/cancelled`. |
|  | `title`, `log_dir` | 标题/日志目录 | TEXT | `''` / NULL | `log_dir` stays stable across attempts. |
|  | `origin_environment_id` | 创建环境 ID | TEXT | NULL, FK | Origin machine. |
|  | `started_at`, `ended_at`, `created_at` | 开始/结束/创建时间 | TEXT | NULL / API timestamp | Session lifecycle; `ended_at` only final end. |
|  | `revision` | 修订号 | INTEGER | `1` | Optimistic concurrency version. |
| `session_attempts` | `id` | 尝试 ID | TEXT | generated, PK | One process/adapter execution. |
|  | `workflow_session_id` | 会话 ID | TEXT | required, FK | Parent stable session. |
|  | `attempt_no` | 尝试序号 | INTEGER | required | Starts at 1; unique per session. |
|  | `environment_id` | 执行环境 ID | TEXT | NULL, FK | Machine executing attempt. |
|  | `status` | 状态 | TEXT | `'queued'` | `queued/running/interrupted/completed/failed`. |
|  | `provider`, `error_text` | 平台/错误 | TEXT | NULL | Adapter and interruption summary. |
|  | `started_at`, `ended_at` | 开始/结束时间 | TEXT | NULL | Attempt times. |
| `session_conversations` | `id` | 映射 ID | TEXT | generated, PK | External conversation mapping. |
|  | `workflow_session_id` | 会话 ID | TEXT | required, FK | AWF workflow session. |
|  | `provider` | 平台 | TEXT | required | `claude`, `dsh`, etc. |
|  | `external_conversation_id` | 外部对话 ID | TEXT | required | Provider ID; not AWF identity. |
|  | `created_at` | 创建时间 | TEXT | API timestamp | Mapping creation time. |
| `tasks` | `id` | 任务 ID | TEXT | generated, PK | Stable internal task identity. |
|  | `requirement_id` | 需求 ID | TEXT | required, FK | Owning requirement. |
|  | `task_key` | 任务编号 | TEXT | required | Human key like T1; unique per requirement. |
|  | `title` | 标题 | TEXT | required | Task title. |
|  | `kind`, `status` | 类型/状态 | TEXT | `'dev'` / `'pending'` | Status `pending/active/done/blocked`. |
|  | `source` | 来源 | TEXT | NULL | Initial plan/gate fix/decision review, etc. |
|  | `prompt`, `acceptance`, `blocked_reason` | 指令/验收/阻塞原因 | TEXT | `''` / `''` / NULL | Task content and status detail. |
|  | `details_json` | 扩展数据 | TEXT | `'{}'` | Planned files, constraints, evolving fields. |
|  | `position`, `revision` | 顺序/修订号 | INTEGER | `0` / `1` | Display ordering and concurrency token. |
|  | `created_at`, `updated_at` | 创建/更新时间 | TEXT | API timestamp | UTC timestamps. |
| `task_commits` | `id`, `task_id` | 记录/任务 ID | TEXT | generated PK / required FK | Commit associated with a task. |
|  | `hash`, `message`, `position` | 提交哈希/说明/顺序 | TEXT / TEXT / INTEGER | required / `''` / `0` | Preserve `task.commits[]` order. |
| `task_dependencies` | `task_id`, `depends_on_task_id` | 任务/前置任务 ID | TEXT | required, FK | Composite PK; same requirement; no self-edge. |
|  | `position` | 顺序 | INTEGER | `0` | Dependency display order. |
| `task_executions` | `id` | 执行记录 ID | TEXT | generated, PK | One execution result, including retries. |
|  | `task_id`, `workflow_session_id` | 任务/会话 ID | TEXT | required, FK | Task and responsible run session. |
|  | `attempt_id` | 尝试 ID | TEXT | NULL, FK | Attempt that produced this result. |
|  | `status` | 执行状态 | TEXT | required | Execution outcome. |
|  | `result_json` | 执行结果 | TEXT | `'{}'` | Result/files/verdict details. |
|  | `started_at`, `ended_at` | 开始/结束时间 | TEXT | NULL | Execution interval. |
| `decisions` | `id` | 决策 ID | TEXT | generated, PK | Stable decision identity. |
|  | `requirement_id` | 需求 ID | TEXT | required, FK | Owning requirement. |
|  | `workflow_session_id` | 会话 ID | TEXT | NULL, FK | Session that raised/resolved it. |
|  | `decision_type`, `status` | 类型/状态 | TEXT | NULL / `'open'` | Decision category and `open/resolved/deferred/overridden`. |
|  | `question` | 问题 | TEXT | `''` | Decision question. |
|  | `result_json` | 决策结果 | TEXT | `'{}'` | Answer, factors, confidence, reconsideration. |
|  | `created_at`, `updated_at` | 创建/更新时间 | TEXT | API timestamp | UTC timestamps. |
| `decision_tasks` | `decision_id`, `task_id` | 决策/任务 ID | TEXT | required, FK | Composite PK for many-to-many. |
|  | `relation` | 关联类型 | TEXT | required | `informs/blocks/supersedes/caused_by`. |
| `decision_events` | `id` | 事件 ID | TEXT | generated, PK | Durable event identity. |
|  | `decision_id` | 决策 ID | TEXT | required, FK | Parent decision. |
|  | `sequence` | 顺序号 | INTEGER | required | Monotonic per decision. |
|  | `event_type`, `payload_json` | 事件类型/内容 | TEXT | required / `'{}'` | Immutable lifecycle event. |
|  | `occurred_at` | 发生时间 | TEXT | API timestamp | Event time. |
|  | `actor_type`, `actor_id` | 操作者类型/ID | TEXT | `'system'` / NULL | Human/agent/system provenance. |
|  | `origin_environment_id` | 来源环境 ID | TEXT | NULL, FK | Future sync provenance. |
|  | `idempotency_key` | 幂等键 | TEXT | NULL | Prevent duplicate retried writes. |
| `proposals` | `id`, `project_id`, `requirement_id` | 提案/项目/需求 ID | TEXT | generated PK / required FK / NULL FK | Dynamic planning proposal and scope. |
|  | `status`, `payload_json` | 状态/提案内容 | TEXT | required / `'{}'` | Current mutable proposal snapshot. |
|  | `created_at`, `updated_at` | 创建/更新时间 | TEXT | API timestamp | Proposal lifecycle. |
| `proposal_events` | `id`, `proposal_id` | 事件/提案 ID | TEXT | generated PK / required FK | Proposal event and parent. |
|  | `event_type`, `payload_json`, `occurred_at` | 事件类型/内容/时间 | TEXT | required / `'{}'` / API timestamp | Immutable event history. |
| `bugs` | `id` | Bug ID | TEXT | generated, PK | Stable defect identity. |
|  | `project_id` | 项目 ID | TEXT | required, FK | Owning project. |
|  | `requirement_id`, `workflow_session_id` | 需求/会话 ID | TEXT | NULL, FK | Context where discovered/fixed. |
|  | `title`, `description` | 标题/描述 | TEXT | required / `''` | Summary and reproduction details. |
|  | `severity`, `status` | 严重度/状态 | TEXT | `'medium'` / `'open'` | Severity `low/medium/high/critical`; status `open/fixed/verified/wont_fix`. |
|  | `created_at` | 创建时间 | TEXT | API timestamp | Creation time. |
| `bug_tasks` | `bug_id`, `task_id` | Bug/任务 ID | TEXT | required, FK | Composite PK linking bug and task. |
|  | `relation` | 关联类型 | TEXT | required | `discovered_by/fixed_by/verified_by`. |
| `product_issues` | `id` | Issue ID | TEXT | generated, PK | Stable backlog identity. |
|  | `project_id` | 项目 ID | TEXT | required, FK | Owning project. |
|  | `title`, `body` | 标题/描述 | TEXT | required / `''` | Backlog content. |
|  | `status` | 状态 | TEXT | `'open'` | `open/planned/closed/deferred`. |
|  | `priority` | 优先级 | INTEGER | `0` | Higher number means higher priority (proposed). |
|  | `requirement_id` | 转换需求 ID | TEXT | NULL, FK | Requirement created from issue. |
|  | `created_at` | 创建时间 | TEXT | API timestamp | Creation time. |
| `issue_events` | `id`, `issue_id` | 事件/Issue ID | TEXT | generated PK / required FK | Event identity and parent. |
|  | `event_type`, `payload_json` | 事件类型/内容 | TEXT | required / `'{}'` | Immutable issue history. |
|  | `occurred_at` | 发生时间 | TEXT | API timestamp | Event time. |
| `project_architecture_nodes` | `id`, `project_id` | 节点/项目 ID | TEXT | generated PK / required FK | Project-level WBS node. |
|  | `parent_id` | 父节点 ID | TEXT | NULL, self FK | NULL for root node. |
|  | `node_key`, `title` | 节点编号/名称 | TEXT | required | WBS key unique per project and display title. |
|  | `description` | 描述 | TEXT | `''` | Architecture scope/acceptance. |
|  | `position`, `revision` | 顺序/修订号 | INTEGER | `0` / `1` | Sibling order and concurrency token. |
|  | `details_json` | 扩展数据 | TEXT | `'{}'` | Non-relational metadata. |
| `domain_events` | `id`, `project_id` | 事件/项目 ID | TEXT | generated PK / required FK | Event identity and scope. |
|  | `aggregate_type`, `aggregate_id` | 聚合类型/ID | TEXT | required | Entity whose state changed. |
|  | `sequence` | 顺序号 | INTEGER | required | Monotonic per aggregate. |
|  | `event_type`, `payload_json` | 事件类型/内容 | TEXT | required / `'{}'` | Durable business transition, not UI polling. |
|  | `origin_environment_id` | 来源环境 ID | TEXT | NULL, FK | Future sync provenance. |
|  | `occurred_at`, `recorded_at` | 发生/记录时间 | TEXT | API timestamp | Event time and local write time. |
| `artifacts` | `id` | 文件记录 ID | TEXT | generated, PK | Metadata only; contents stay in `.awf/`. |
|  | `owner_type`, `owner_id` | 所属类型/ID | TEXT | required | Session/task/requirement, etc. |
|  | `checkout_id` | 本机目录记录 ID | TEXT | NULL, FK | Identifies the local checkout used to resolve the artifact path. |
|  | `relative_path` | 相对路径 | TEXT | required | Path under `.awf/`; never machine-absolute. |
|  | `media_type`, `size_bytes`, `digest` | 类型/大小/摘要 | TEXT / INTEGER / TEXT | NULL | Optional indexing and integrity metadata. |
| `legacy_ids` | `entity_type`, `legacy_id` | 实体类型/旧 ID | TEXT | required, composite PK | Legacy identifier such as old sid/runStamp. |
|  | `entity_id` | 新实体 ID | TEXT | required | Stable internal ID. |
| `schema_migrations` | `version` | 版本号 | INTEGER | required, PK | Applied schema version. |
|  | `name`, `applied_at` | 迁移名/应用时间 | TEXT | required / API timestamp | Migration identity and time. |

## 2B. Revised persistence inventory

**Must be in the database:** logical projects, environment/checkout identities, requirements and their shared state, tasks and dependencies, decisions and task links, bugs and their task/session links, product issues/backlog, plan/run workflow sessions and restart attempts, project architecture WBS, and durable domain events. Persist only structured facts and paths/metadata for large artifacts.

**Remain file-backed under `.awf/`:** verbose run logs, conversation transcripts, subagent logs, review/audit reports, generated design outputs and user deliverables. Store their ownership, relative path, media type, timestamps, size, and optional digest in DB only if listing/searching them becomes useful. Config, prompts, plugin assets, context handoff files, and transient usage telemetry remain file/config data for now.

**State split:** move WBS out of requirement state into the project architecture tree. Requirement state contains the request summary/scope/acceptance criteria, task list reference, workflow status, and revision metadata. Keep provider-specific or evolving task/decision payloads in versioned JSON columns only when they are not stable query dimensions; promote frequently filtered fields to columns.

## 3. Schema rules and relationship sketch

The canonical v1 table set is listed in §2A. Implement that model rather than the superseded plan-centric SQL draft. A compact view of ownership is:

```text
projects ──< project_checkouts >── environments
   ├──< project_architecture_nodes (self-parent tree)
   ├──< requirements
   │       ├──< workflow_sessions ──< session_attempts
   │       │           └──< session_conversations
   │       ├──< tasks ──< task_executions >── session_attempts
   │       │     └──< task_dependencies >── tasks
   │       ├──< decisions ──< decision_events
   │       │       └──< decision_tasks >── tasks
   │       └──< bugs ──< bug_tasks >── tasks
   ├──< product_issues ──< issue_events
   └──< domain_events / artifacts / legacy_ids
```

Schema constraints to carry into the eventual DDL:

- All primary IDs are opaque text IDs generated once. Human-readable keys (`T1`, old sid, runStamp) are aliases with explicit scope and unique constraints, never silently repurposed as primary IDs.
- Use composite constraints for scoped keys, such as `UNIQUE(requirement_id, task_key)`, `UNIQUE(workflow_session_id, attempt_no)`, and ordered relationship keys. Foreign keys prevent cross-project/requirement links where possible.
- The device-level DB is shared by local processes and projects; keep write transactions short and configure `busy_timeout` because SQLite serializes writers.
- `workflow_sessions.kind` is checked to `plan` or `run`; attempts do not create new workflow sessions. A requirement can have repeated planning sessions and execution sessions over time.
- Dependency acyclicity and state-machine transitions are domain-service checks inside the same transaction. Immutable histories use append-only event rows; current status is a query-friendly projection.
- Use `TEXT` ISO-8601 UTC timestamps; JSON text only for variable payloads. Do not use JSON arrays as a substitute for relationship tables.
- Revisit cascade behavior before DDL: deleting a project/requirement with durable learning history should generally be a tombstone/archive operation, not cascading data loss.

## 4. Compatibility projection for state JSON

Keep `loadState(projectRoot)` returning the familiar shape:

```js
{
  mode, currentState, version, lastUpdated,
  plan: { ...metadata_json },
  milestones: [...], wbs: [...], tasks: [...]
}
```

`loadState(projectRoot)` assembles this from the project's explicitly selected active requirement and related tables. Add `active_requirement_id` to the project record for legacy callers that have no requirement selector; new interfaces always pass `requirementId`. `saveState` remains temporarily as a compatibility operation that validates and replaces the selected requirement/task projection in one transaction while incrementing its revision. Plan/requirement history snapshots are intentionally out of scope; the revision counter is only an optimistic-concurrency token. High-frequency operations gradually move to fine-grained domain commands to avoid rewriting the entire state and creating unnecessary conflicts. Map `lastUpdated` to the requirement's `updated_at`; use a persistent revision as the optimistic concurrency token instead of relying on millisecond timestamps.

**Important:** the project currently has both a single `.awf/state.json` layout and per-run `.awf/runs/<sid>/state.json` paths. The target model deliberately keeps requirement/task state shared across plan and run sessions; do not create a duplicate task graph per resumed run. Import any legacy shard as a source snapshot, compare it with its requirement, and preserve differences for explicit reconciliation; do not create plan history snapshots. A session's log directory remains stable across its attempts.

## 5. Persistence module boundary and interfaces

The persistence implementation is a standalone module under `server/persistence/`. It is designed and completed before existing server/CLI/MCP/Web paths are migrated to it.

```text
server/persistence/
  index.cjs                # the only public import surface (CommonJS for current server/CLI callers)
  api/                     # public methods, cross-table orchestration, transaction boundaries
  database.cjs             # open/close, connection configuration, transaction wrapper
  schema/                  # versioned SQL migrations
  repositories/            # private table access grouped by data module; not exported to callers
  errors.cjs                # stable persistence error codes
```

**Dependency boundary:** this module may import Node built-ins and its own files only. It must not import `server/shared`, `server/runtime`, CLI, plugin code, HTTP handlers, or application/domain modules. Its public API accepts primitive values and plain objects and returns plain objects. No consumer imports internal files; consumers import only `server/persistence/index.cjs`. All SQL, schema migration, connection setup, transaction handling, and row mapping live inside this folder.

Consumers call the data methods directly and never manage a connection per request. The module lazily opens and reuses one connection per Node process; a long-running server calls `shutdownPersistence()` once during graceful shutdown. `initializePersistence({ filePath })` is optional for startup-time configuration; otherwise the default `~/.awf/awf.sqlite` path is used. The facade returns a common `{ ok, data }` / `{ ok, error }` shape and maps persistence errors to stable codes. Cross-table use cases such as creating a requirement with a plan session run in one API-layer transaction. Repository failures propagate inside the unit of work to force rollback; the API boundary converts them to public errors. The facade does not export a connection or SQL surface.

### Public API contract (implemented)

Common result shape:

```ts
 type Result<T> =
   | { ok: true; data: T }
   | { ok: false; error: { code: 'NOT_FOUND'|'CONFLICT'|'VALIDATION'|'STORAGE'|'CLOSED'; message: string; details?: object } };
```

| Module | Method | Input | Output | Description |
|---|---|---|---|---|
| Database | `initializePersistence` | `{ filePath?, timeout? }` (optional) | `Result<{ filePath, schemaVersion }>` | Configure once at startup; if omitted, first use lazily opens the default DB. |
| Database | `shutdownPersistence` | none | `Result<void>` | Close the shared connection once during graceful process shutdown. |
| Database | `getDatabaseInfo` | none | `Result<{ filePath, schemaVersion }>` | Return current database path and schema version. |
| Database | `integrityCheck` | none | `Result<{ ok, integrity, foreignKeys }>` | Run SQLite integrity and foreign-key diagnostics. |
| Database | `backupDatabase` | `destinationPath` | `Promise<Result<{ filePath }>>` | Create a consistent backup using SQLite's backup API. |
| Project | `get` | `{ projectId }` | `Result<Project>` | Read logical project identity and metadata. |
| Project | `upsert` | `{ project }` | `Result<Project>` | Create/update project metadata. |
| Environment | `getOrCreate` | `{ environmentId?, name }` | `Result<Environment>` | Resolve this installation's environment record. |
| Checkout | `upsert` | `{ checkout }` | `Result<Checkout>` | Register or update local path association. |
| Requirement | `create` | `{ projectId, title, requestText, ... }` | `Result<Requirement>` | Create a durable requirement. |
| Requirement | `createWithPlan` | `{ requirement: {...}, plan?: {...} }` | `Result<{ requirement, planSession }>` | Create the requirement and its initial plan session atomically. |
| Requirement | `get` | `{ requirementId }` | `Result<Requirement>` | Read requirement and current revision. |
| Requirement | `list` | `{ projectId, status?, limit?, cursor? }` | `Result<Page<Requirement>>` | Paginated project requirements. |
| Requirement | `update` | `{ requirementId, patch, expectedRevision }` | `Result<Requirement>` | Optimistic-concurrency update. |
| Milestone | `list` | `{ requirementId }` | `Result<Milestone[]>` | List requirement milestones in position order. |
| Milestone | `replaceAll` | `{ requirementId, milestones, expectedRevision }` | `Result<Milestone[]>` | Replace milestone projection atomically. |
| Session | `create` | `{ requirementId, kind, title? }` | `Result<WorkflowSession>` | Create one plan or run session with a stable ID and log directory. |
| Session | `get` | `{ sessionId }` | `Result<WorkflowSession>` | Read session and current attempt. |
| Session | `list` | `{ requirementId, kind?, limit?, cursor? }` | `Result<Page<WorkflowSession>>` | List a requirement's sessions. |
| Session | `startAttempt` | `{ sessionId, environmentId, provider? }` | `Result<SessionAttempt>` | Create a restart/continuation attempt without changing session identity or log directory. |
| Session | `finishAttempt` | `{ sessionId, attemptId, status, error? }` | `Result<SessionAttempt>` | Finish one process attempt; session can remain resumable. |
| Session | `attachConversation` | `{ sessionId, provider, externalConversationId }` | `Result<SessionConversation>` | Link an external provider conversation. |
| Task | `create` | `{ requirementId, taskKey, title, ... }` | `Result<Task>` | Create a task with a requirement-scoped human key. |
| Task | `get` | `{ taskId }` | `Result<Task>` | Read task details. |
| Task | `list` | `{ requirementId, status?, limit?, cursor? }` | `Result<Page<Task>>` | Paginated task list. |
| Task | `update` | `{ taskId, patch, expectedRevision }` | `Result<Task>` | Update task state/details with conflict detection. |
| Task | `setDependencies` | `{ taskId, dependencyTaskIds }` | `Result<TaskDependency[]>` | Replace ordered dependencies; reject missing/cross-requirement IDs and cycles. |
| Task commit | `addCommit` | `{ taskId, hash, message }` | `Result<TaskCommit>` | Append commit reference to task history. |
| Task commit | `list` | `{ taskId }` | `Result<TaskCommit[]>` | Read commits in original order. |
| Task execution | `record` | `{ taskId, sessionId, attemptId, status, result?, verdict? }` | `Result<TaskExecution>` | Record execution/retry facts separately from the task's current projection. |
| Decision | `create` | `{ requirementId, sessionId?, decision }` | `Result<Decision>` | Store a decision and its structured payload. |
| Decision | `linkTasks` | `{ decisionId, links: [{ taskId, relation }] }` | `Result<DecisionTask[]>` | Associate decision with one or more tasks. |
| Decision | `appendEvent` | `{ decisionId, eventType, payload, idempotencyKey? }` | `Result<DecisionEvent>` | Append immutable lifecycle/audit event. |
| Proposal | `upsert` | `{ requirementId?, proposal }` | `Result<Proposal>` | Create/update dynamic-planning proposal snapshot. |
| Proposal | `appendEvent` | `{ proposalId, eventType, payload }` | `Result<ProposalEvent>` | Append immutable proposal lifecycle event. |
| Bug | `create` | `{ projectId, requirementId?, sessionId?, title, description, severity? }` | `Result<Bug>` | Record a discovered defect. |
| Bug | `linkTasks` | `{ bugId, links: [{ taskId, relation }] }` | `Result<BugTask[]>` | Link discovery/fix/verification tasks. |
| Issue | `create` | `{ projectId, title, body?, priority? }` | `Result<ProductIssue>` | Add product backlog item. |
| Issue | `promote` | `{ issueId, requirement }` | `Result<{ issue, requirement }>` | Create/link a requirement while preserving issue identity/history. |
| Architecture | `getTree` | `{ projectId }` | `Result<ArchitectureNode[]>` | Return project WBS tree in stable order. |
| Architecture | `upsertNode` | `{ projectId, node }` | `Result<ArchitectureNode>` | Add/update one project-level architecture node. |
| Event | `list` | `{ projectId, aggregateType?, aggregateId?, afterSequence?, limit? }` | `Result<Page<DomainEvent>>` | Read persisted domain events, not transient UI polling. |
| Artifact | `register` | `{ ownerType, ownerId, relativePath, mediaType?, size?, digest? }` | `Result<Artifact>` | Store metadata for a file that remains under `.awf/`. |
| Legacy ID | `register` | `{ entityType, legacyId, entityId }` | `Result<void>` | Preserve an old identifier alias during import. |
| Legacy ID | `resolve` | `{ entityType, legacyId }` | `Result<{ entityId }>` | Map imported IDs such as old sid/runStamp to stable IDs. |

Every public method returns the common Result shape. Issue promotion and related writes use transactions. The exact exported method inventory is maintained in the Chinese design document. HTTP routes, MCP tools, and CLI commands are not connected yet and will act as adapters; none should contain SQL.

### Transaction and concurrency rules

- Each write operation owns a transaction; nested operations reuse the active transaction.
- `node:sqlite` uses synchronous calls; transaction callbacks must not `await`.
- Use persistent revision numbers for optimistic concurrency. A conflict returns `CONFLICT` with the current revision.
- Use an idempotency key for retryable event writes. Return `NOT_FOUND` for missing entities, `VALIDATION` for invalid relationships/cycles, and `STORAGE` for unexpected DB errors. Never expose raw SQL errors to callers.
- All writes that update a current projection and append its history event do both atomically.

## 6. HTTP and MCP mapping

Do not change paths, response shapes, or MCP tool names in the first phase. API handlers call domain services, which call repositories; handlers must not construct SQL. `/awf/state` returns the compatibility projection. Adapt `/run/state/apply` to a transactional replacement and use the persistent revision as the preferred conflict token instead of the current timestamp plus JSON fingerprint. Implement `GET /awf/decisions` with indexed pagination; it may temporarily aggregate all records internally if old data volumes are small.

```text
CLI / MCP / HTTP
       ↓
Domain services (state machines, dependency graph, validation, event semantics)
       ↓
SQLite repositories (SQL, transactions, mapping)
       ↓
~/.awf/awf.sqlite
```

The MCP plugin can run in a separate process and cannot rely on relative imports from the main project's runtime. In the first phase, make the Session Server's existing HTTP apply path the single online writer and extend it to cover persistence writes. Offline CLI can open the database directly. If MCP must write while the server is offline, choose between direct database access and server-writer mode; share the SQLite driver and schema migration code, and ensure all processes follow SQLite locking and busy-timeout settings.

### HTTP adapter contract (later integration)

These are application-facing routes, not methods exported by `server/persistence`. The persistence folder stays transport-agnostic. Request and response bodies use JSON; success returns `{ ok: true, data }`, while failure returns `{ ok: false, error: { code, message, details? } }`.

| Method and path | Input | Output | Description |
|---|---|---|---|
| `POST /api/projects/:projectId/requirements` | `{ title, requestText }` | `201 { requirement }` | Create requirement. |
| `GET /api/projects/:projectId/requirements?status&limit&cursor` | Query filters | `{ items, nextCursor }` | Paginated requirements. |
| `GET /api/requirements/:requirementId` | Path ID | `{ requirement, tasks, milestones, revision }` | Read full requirement projection. |
| `PATCH /api/requirements/:requirementId` | `{ patch, expectedRevision }` | `{ requirement, revision }` | Update with optimistic concurrency. |
| `POST /api/requirements/:requirementId/sessions` | `{ kind: 'plan'|'run', title? }` | `201 { session, attempt? }` | Create workflow session; start attempt may be separate. |
| `POST /api/sessions/:sessionId/attempts` | `{ environmentId, provider? }` | `201 { attempt }` | Resume the existing workflow session with a new attempt. |
| `GET /api/sessions/:sessionId` | Path ID | `{ session, attempts, conversations }` | Read session lifecycle. |
| `GET /api/sessions/:sessionId/events?after&limit` | Cursor query | `{ items, nextCursor }` | Read durable events for the session. |
| `GET /api/requirements/:requirementId/tasks?status&limit&cursor` | Query filters | `{ items, nextCursor }` | Paginated task list. |
| `POST /api/requirements/:requirementId/tasks` | `{ taskKey, title, prompt?, acceptance? }` | `201 { task }` | Create task. |
| `PATCH /api/tasks/:taskId` | `{ patch, expectedRevision }` | `{ task, revision }` | Update task state/details. |
| `PUT /api/tasks/:taskId/dependencies` | `{ dependencyTaskIds }` | `{ dependencies }` | Replace dependencies; validates scope and cycles. |
| `POST /api/tasks/:taskId/executions` | `{ sessionId, attemptId?, status, result? }` | `201 { execution }` | Record task execution. |
| `POST /api/requirements/:requirementId/decisions` | `{ sessionId?, decisionType?, question, result }` | `201 { decision }` | Record decision. |
| `PUT /api/decisions/:decisionId/tasks` | `{ links: [{ taskId, relation }] }` | `{ links }` | Set decision/task relationships. |
| `POST /api/projects/:projectId/bugs` | `{ requirementId?, sessionId?, title, description?, severity? }` | `201 { bug }` | Create bug record. |
| `PUT /api/bugs/:bugId/tasks` | `{ links: [{ taskId, relation }] }` | `{ links }` | Link discovered/fixed/verified tasks. |
| `POST /api/projects/:projectId/issues` | `{ title, body?, priority? }` | `201 { issue }` | Create backlog issue. |
| `POST /api/issues/:issueId/promote` | `{ requirement: { title, requestText } }` | `201 { issue, requirement }` | Promote issue atomically while preserving source. |
| `GET /api/projects/:projectId/architecture` | — | `{ nodes }` | Read WBS tree. |
| `PUT /api/projects/:projectId/architecture` | `{ nodes, expectedRevision }` | `{ nodes, revision }` | Replace tree transactionally in explicit ordering. |

These routes are not required to implement the persistence layer first. Later, the existing HTTP endpoints and MCP tools become thin adapters that call the matching exported persistence/application service; they must not issue SQL.

## 7. SQLite driver decision

“No dependency” means SQLite needs no separately deployed database service. This implementation also avoids an npm SQLite driver by using built-in `node:sqlite`. Its availability/stability depends on the supported Node version; plugin copies and CI environments should use the declared Node floor consistently.

1. **Chosen for the standalone module: use built-in `node:sqlite`.** The detected Node 24.14 runtime still emits an experimental API warning; Node 24.15 marks the API as a Release Candidate. It provides synchronous transactions without an npm runtime dependency. The project should still declare its supported Node floor consistently. See [Node.js SQLite API](https://nodejs.org/api/sqlite.html) and [Node.js release status](https://nodejs.org/en/about/previous-releases).
2. **Synchronous native driver:** straightforward transaction semantics and good throughput; requires prebuilt binaries for supported platforms and adds install/packaging cost.
3. **Pure JS/WASM driver:** avoids native builds, but verify persistent VFS, locking, WAL, and filesystem compatibility. Do not assume an in-memory build can safely write a shared file.

This is an implementation choice and does not change the table design or repository contract. Keep driver APIs out of domain code.

## 8. Scope and staged delivery estimate

The requested first delivery is the persistence subsystem **completed on its own**. Do not wire existing server, CLI, MCP, or Web flows to it during that stage.

| Stage | Work included | Size / main output |
|---|---|---|
| A. Persistence contract | Confirm schema/key conventions, status enums, indexes, constraints, JSON payload boundaries, error codes | Medium; versioned schema/API specification |
| B. Standalone module | Build `server/persistence/`, built-in SQLite driver wrapper, migrations, repositories, transaction handling, mappings, stable exported API | **Initial implementation complete**; self-contained and importable without application modules |
| C. Module verification and operations | Verify CRUD, constraints, rollback, concurrency, migration, backup/restore; DB status/export/import utility API and docs | Remaining work; no database verification or status/import/export commands were run/implemented in this phase |
| D. Existing application integration (later, explicitly separate) | Import existing JSON/JSONL, add compatibility projection, connect Server/CLI/MCP/Web adapters, cut over writes, retire old persistence | Large; not part of the first standalone-module scope |

The main remaining effort and uncertainty are the old state/JSONL mapping, identity reconciliation (`default`/sid/runStamp), requirement boundaries, and proving that records survive import without losing relationships. The minimum Node runtime also needs to be declared consistently for CLI, plugin copies, and CI.

When integration is later approved, avoid dual-write operation: import and validate once under a maintenance/write lock, compare record counts, relations, and event order, then make SQLite the sole write source. Keep original files untouched until verified. Rollback requires DB-aware downgrade support or explicit versioned export/import; old JSON files alone are not a rollback replica.

## 9. Backup, recovery, and operations

- Use SQLite's backup API for online backups. In WAL mode, do not copy only the main `.sqlite` file. Without a backup API, take the maintenance lock, checkpoint and close connections, then copy the DB and its `-wal`/`-shm` files as a set.
- Future CLI commands: `awf db status|migrate|backup|restore|export`. `status` reports schema version, integrity check, journal mode, and path, without exposing business content.
- Run `PRAGMA integrity_check` on explicit diagnostics rather than scanning the whole DB at every startup. Run schema migrations under `BEGIN IMMEDIATE` to prevent concurrent migrations.
- Moving or deleting a project directory while it is open invalidates connections. Close connections when a server project context shuts down. A multi-project server should cache one connection per canonical root path and close it when finished.
- Do not store generated content, transcripts, or large files as SQLite BLOBs. Store relative paths, sizes, hashes, and metadata instead.

## 10. Open questions

1. What is the minimum supported Node version and target platform list? This confirms the built-in driver choice.
2. Should checkout registration handle symlinks, moved directories, and multiple clones automatically in the first phase? The proposed match uses the manifest `project_id` plus the canonical local path; Git remote URL is only a hint.
3. How long should decision events and file-backed logs be retained?

## 11. Acceptance criteria for a future implementation

- A new project starts from an empty schema; rerunning migrations does not change existing data.
- Every required table and field is documented, migrated, and exercised through the exported API; no consumer must import an internal persistence file.
- The module loads without application imports or third-party runtime dependencies; migrations and repositories work against a temporary SQLite database.
- Concurrent duplicate IDs, state conflicts, dependency cycles, duplicate events, and malformed inputs have deterministic outcomes; failed transactions leave no partial writes.
- The database can be backed up and restored; integrity checks pass. Existing application JSON/JSONL remains untouched because app integration and import are a later phase.
