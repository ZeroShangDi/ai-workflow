/**
 * cc-work UI contract proposal v0.1 — 2026-09-13.
 * DESIGN ONLY: /api/v1 endpoints are NOT implemented by the current server.
 * See cc-work-api-audit.md for legacy mappings, unresolved semantics and evidence.
 * No runtime imports; usable as a type source for a future mock/adapter.
 */
export type Id = string;
export type ISODate = string;
export type Revision = string;
export type Cursor = string;
export interface Meta {
  requestId: Id; observedAt: ISODate; revision?: Revision;
  /** Required on subscribable snapshots; cursor and snapshot must be captured consistently. */
  eventCursor?: { epoch: string; seq: number };
}
export type ErrorCode =
  | 'INVALID_REQUEST' | 'VALIDATION_FAILED' | 'NOT_FOUND' | 'SCOPE_MISMATCH'
  | 'STATE_CONFLICT' | 'REVISION_MISMATCH' | 'IDEMPOTENCY_CONFLICT'
  | 'CAPABILITY_UNAVAILABLE' | 'DEPENDENCY_UNAVAILABLE' | 'PARTIAL_FAILURE'
  | 'CURSOR_EXPIRED' | 'INTERNAL_ERROR';
export type Result<T> =
  | { ok: true; data: T; meta: Meta }
  | { ok: false; error: { code: ErrorCode; message: string; retryable: boolean;
      fieldErrors?: Record<string, string>; operationId?: Id }; meta: Meta };
export interface PageQuery { cursor?: Cursor; limit?: number }
export interface Page<T> { items: T[]; nextCursor: Cursor | null; hasMore: boolean; total: number | null }
export interface ActionAvailability { action: string; enabled: boolean; reason: string | null }
export interface Capability { available: boolean; reason: string | null }
export interface Actor { id: Id; kind: 'human' | 'orchestrator' | 'agent' | 'system'; name: string }
export interface Operation<T = unknown> {
  id: Id; kind: string; projectId: Id | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'partial_failure';
  createdAt: ISODate; updatedAt: ISODate; result: T | null;
  error: { code: ErrorCode; message: string; retryable: boolean } | null;
}
/** Required for writes; revisions are opaque values obtained from the relevant resource. */
export interface WriteHeaders { 'Idempotency-Key': string; 'If-Match'?: Revision }
export interface VersionedWriteHeaders extends WriteHeaders { 'If-Match': Revision }

export interface Selection { projectId: Id | null; planId: Id | null; runId: Id | null }
export interface Bootstrap {
  apiVersion: '1'; actor: Actor; projects: Project[]; lastSelection: Selection;
  capabilities: Record<string, Capability>; settings: SettingsDocument;
}
export interface Project {
  id: Id; root: string; name: string; initialized: boolean;
  availability: 'available' | 'missing' | 'inaccessible';
  lastOpenedAt: ISODate | null; selectedPlanId: Id | null; revision: Revision;
  allowedActions: ActionAvailability[];
}
export interface ProjectInspection {
  normalizedPath: string; exists: boolean; isDirectory: boolean; writable: boolean;
  alreadyRegisteredProjectId: Id | null; suggestedName: string;
  detected: { awf: boolean; git: boolean; planCount: number | null; runCount: number | null };
  warnings: string[];
}
export interface AddProject { path: string; name?: string; initializeIfNeeded: boolean }
export interface Workspace {
  project: Project; selection: Selection; plans: PlanSummary[];
  plansNextCursor: Cursor | null; activeRun: RunSummary | null;
  phase: 'initial' | 'planning' | 'execution' | 'finished' | 'unknown';
  git: { branch: string | null; addedLines: number | null; removedLines: number | null };
  metrics: RunMetrics | null; allowedActions: ActionAvailability[];
}
export interface PlanSummary {
  id: Id; projectId: Id; title: string; revision: Revision;
  status: 'generating' | 'draft' | 'confirmed' | 'archived' | 'generation_failed' | 'unknown';
  updatedAt: ISODate; latestRunId: Id | null;
}
export interface PlanDetail extends PlanSummary {
  summary: string; acceptanceCriteria: string[];
  phases: { id: Id; title: string; description: string; taskIds: Id[] }[];
  tasks: Task[]; planningDecisionIds: Id[]; unresolvedRequiredDecisionIds: Id[];
  baselineRevision: Revision | null; runIds: Id[];
  generationOperationId: Id | null; allowedActions: ActionAvailability[];
}
export interface CreatePlan { title?: string; prompt: string }
export interface ConfirmPlan { expectedDraftRevision: Revision }
export interface ConfirmedRun { planId: Id; baselineRevision: Revision; runId: Id }

export type WorkflowMode = 'idle' | 'run' | 'pause' | 'unknown';
export type RunLifecycle = 'queued' | 'running' | 'done' | 'error' | 'stopped' | 'unknown';
export interface TaskCounts {
  total: number; baseline: number | null; dynamic: number | null;
  pending: number; active: number; done: number; blocked: number; unknown: number;
  /** Subsets may overlap (e.g. held pending tasks); do NOT sum these into total again. */
  held: number; waitingDependency: number; failed: number | null;
}
export interface RunSummary {
  id: Id; displayId: string; projectId: Id; planId: Id | null; baselineRevision: Revision | null;
  revision: Revision; lifecycle: RunLifecycle; workflowMode: WorkflowMode;
  sessionState: 'ready' | 'busy' | 'unavailable' | 'unknown';
  displayState: 'queued' | 'running' | 'pausing' | 'paused' | 'awaiting_input'
    | 'completed' | 'attention_required' | 'failed' | 'cancelled' | 'unknown';
  completion: 'all_tasks_done' | 'work_remaining' | 'failed' | 'cancelled' | 'unknown';
  mode: 'single' | 'batch' | 'unknown'; phase: string | null;
  queuedAt: ISODate | null; startedAt: ISODate | null; finishedAt: ISODate | null;
  counts: TaskCounts; currentTaskIds: Id[]; activeConversationIds: Id[];
  decisionPolicy: DecisionPolicy; allowedActions: ActionAvailability[];
}
export interface DecisionPolicy {
  mode: 'manual' | 'ai' | 'unknown'; effectiveAt: 'immediate' | 'next_safe_point' | 'next_run';
  revision: Revision; pendingMode: 'manual' | 'ai' | null;
}
export type RunAction =
  | { action: 'pause'; reason?: string }
  | { action: 'resume' }
  | { action: 'cancel'; reason: string }
  | { action: 'interrupt_response'; conversationId: Id };
export interface RunActionResult {
  runId: Id; requestedAction: RunAction['action'];
  effect: 'requested' | 'effective'; runRevision: Revision;
}
export interface Conversation {
  id: Id; runId: Id; role: 'orchestrator' | 'main_executor' | 'agent';
  agentId: Id | null; taskId: Id | null; attemptId: Id | null;
  title: string; status: 'idle' | 'running' | 'awaiting_input' | 'completed' | 'failed' | 'unknown';
  allowedActions: ActionAvailability[];
}
export interface Message {
  id: Id; clientMessageId: Id | null; conversationId: Id; runId: Id;
  sequence: number; createdAt: ISODate | null; updatedAt: ISODate | null;
  role: 'user' | 'orchestrator' | 'executor' | 'system'; author: Actor | null;
  status: 'queued' | 'streaming' | 'completed' | 'interrupted' | 'failed';
  blocks: MessageBlock[];
}
export type MessageBlock =
  | { id: Id; type: 'text'; text: string }
  | { id: Id; type: 'activity_group'; summary: string; count: number; artifactId: Id | null }
  | { id: Id; type: 'command'; command: string; status: 'running' | 'succeeded' | 'failed' | 'unknown';
      exitCode: number | null; durationMs: number | null; outputArtifactId: Id | null }
  | { id: Id; type: 'file_changes'; filesChanged: number | null; addedLines: number | null;
      removedLines: number | null; diffArtifactId: Id | null }
  | { id: Id; type: 'test_summary'; passed: number | null; failed: number | null;
      pending: number | null; artifactId: Id | null }
  | { id: Id; type: 'agent_activity'; conversationIds: Id[]; summary: string }
  | { id: Id; type: 'decision_request'; decisionId: Id; summary: string }
  | { id: Id; type: 'result_summary'; text: string; artifactIds: Id[] }
  | { id: Id; type: 'unsupported'; sourceType: string; text: string };
export interface SendMessage { clientMessageId: Id; text: string }
export interface Metric<T> {
  value: T | null; observedAt: ISODate | null;
  quality: 'exact' | 'estimated' | 'partial' | 'unavailable'; basis: string | null;
}
export interface RunMetrics {
  runId: Id; elapsedMs: Metric<number>; activeAgents: Metric<number>; maxAgents: Metric<number>;
  inputTokens: Metric<number>; outputTokens: Metric<number>; totalTokens: Metric<number>;
  contextUsedPercent: Metric<number>; cacheHitPercent: Metric<number>;
  outputTokensPerSecond: Metric<number>; ttftMs: Metric<number>;
  quota: { available: boolean; reason: string | null;
    windows: { id: string; usedPercent: number | null; resetsAt: ISODate | null }[] };
}
export type TaskOrigin = 'baseline' | 'dynamic' | 'gate_fix' | 'decision_review' | 'unknown';
export type TaskDisplayStatus = 'ready' | 'waiting_dependency' | 'held' | 'running'
  | 'succeeded' | 'blocked' | 'failed' | 'unknown';
export interface Task {
  id: Id; runId: Id | null; planId: Id | null; revision: Revision;
  title: string; prompt: string | null; kind: string; acceptance: string | null;
  rawStatus: string; displayStatus: TaskDisplayStatus; statusReason: string | null;
  deps: Id[]; heldByProposalIds: Id[]; origin: TaskOrigin;
  originProposalId: Id | null; originDecisionId: Id | null;
  createdAt: ISODate | null; createdBy: Actor | null;
  currentAttempt: { id: Id | null; number: number | null; maxAttempts: number | null;
    agentId: Id | null; conversationId: Id | null;
    startedAt: ISODate | null; completedAt: ISODate | null; verdict: string | null } | null;
  plannedFiles: string[]; artifactIds: Id[];
}
export interface TaskQuery extends PageQuery { status?: TaskDisplayStatus; origin?: TaskOrigin; q?: string }
export interface TaskPage extends Page<Task> { counts: TaskCounts; snapshotRevision: Revision }

export type DecisionStatus = 'pending' | 'adopted' | 'replaced' | 'needs_validation' | 'unknown';
export interface Decision {
  id: Id; legacyId: string | null; projectId: Id; planId: Id | null; runId: Id | null;
  revision: Revision; phase: 'planning' | 'execution' | 'unknown';
  source: 'planning' | 'execution' | 'dynamic_planning' | 'legacy' | 'unknown';
  status: DecisionStatus; title: string; context: string | null; recommendation: string | null;
  alternatives: { id: string; text: string }[]; impacts: string[];
  relatedTaskIds: Id[]; relatedProposalId: Id | null;
  author: Actor | null; createdAt: ISODate | null; resolvedAt: ISODate | null;
  resolution: { action: 'adopt' | 'replace' | 'legacy_reject'; text: string | null;
    actor: Actor | null; applicationStatus: 'applied' | 'pending' | 'conflicted' | 'not_applicable' } | null;
  history: { eventId: Id; type: string; at: ISODate | null; text: string | null }[];
  allowedActions: ActionAvailability[];
}
export interface DecisionQuery extends PageQuery {
  planId?: Id; runId?: Id; status?: DecisionStatus; phase?: 'planning' | 'execution'; q?: string;
}
export type DecisionAction =
  | { action: 'adopt' }
  | { action: 'replace'; alternative: string; reason?: string };
export interface DecisionResolution {
  decision: Decision; followUpTaskIds: Id[]; followUpProposalIds: Id[];
  executionEffect: 'none' | 'resume_requested' | 'review_required' | 'conflicted';
}
export type ProposalStatus = 'proposed' | 'awaiting_approval' | 'decision_required'
  | 'decision_link_failed' | 'applied_review_pending' | 'applied' | 'rejected' | 'conflicted';
export interface TaskProposal {
  id: Id; projectId: Id; runId: Id | null; revision: Revision; status: ProposalStatus;
  executionMode: 'approve_then_apply' | 'auto_then_review'; reason: string;
  requestedBy: Actor | null; createdAt: ISODate; updatedAt: ISODate; appliedAt: ISODate | null;
  changes: { operation: 'insert_task' | 'edit_task' | 'delete_task'; taskId: Id;
    before: Partial<Task> | null; after: Partial<Task> | null }[];
  affectedTaskIds: Id[]; heldTaskIds: Id[]; requiresDecision: boolean; decisionReasons: string[];
  linkedDecisionId: Id | null;
  review: { status: 'not_required' | 'pending' | 'passed' | 'changes_requested';
    reviewer: Actor | null; note: string | null; reviewedAt: ISODate | null };
  followUpProposalIds: Id[]; allowedActions: ActionAvailability[];
}
/** PROVISIONAL: product must confirm post-application remediation and pause behavior. */
export type ProposalReview = { outcome: 'pass'; note?: string }
  | { outcome: 'request_changes'; note: string; alternative?: string };

export interface LogSource {
  id: Id; runId: Id; kind: 'run' | 'agent'; name: string;
  agentId: Id | null; conversationId: Id | null; attemptId: Id | null;
  format: 'structured_events' | 'raw_output' | 'transcript';
  status: 'active' | 'idle' | 'closed' | 'unavailable'; recordCount: number | null;
  available: boolean; unavailableReason: string | null;
}
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'unknown';
export interface LogEntry {
  id: Id; runId: Id; sourceId: Id; sequence: number; timestamp: ISODate | null;
  kind: 'run_event' | 'stdout' | 'stderr' | 'transcript' | 'tool'; level: LogLevel;
  text: string; taskId: Id | null; agentId: Id | null; attemptId: Id | null;
  eventType: string | null;
}
export interface LogQuery extends PageQuery {
  sourceId?: Id; level?: LogLevel; q?: string; taskId?: Id; attemptId?: Id;
  from?: ISODate; to?: ISODate; direction?: 'older' | 'newer';
}
export interface LogExportRequest { query: Omit<LogQuery, 'cursor' | 'limit'>; format: 'text' | 'jsonl' }
export interface ArtifactDetail {
  id: Id; runId: Id; taskId: Id | null; attemptId: Id | null;
  type: 'command_output' | 'diff' | 'test_report' | 'activity_details' | 'file';
  title: string; text: string; mimeType: string; truncated: boolean; nextCursor: Cursor | null;
}

/** Only render supported keys. Values here are proposals, not current server defaults. */
export interface SettingsValues {
  'ui.locale': string;
  'ui.restoreLastSelection': boolean;
  'ui.showAdvancedMetrics': boolean;
  'execution.confirmBeforeRun': boolean;
  'execution.agentSelection': 'single' | 'auto';
  'execution.maxAgents': number;
  'execution.maxModules': number;
  'execution.maxPerModule': number;
  'execution.maxPerFeature': number;
  'execution.decisionMode': 'manual' | 'ai';
  'dynamicTasks.enabled': boolean;
  'dynamicTasks.mode': 'approve_then_apply' | 'auto_then_review';
  'quotaProtection.enabled': boolean;
  'logs.retentionDays': number;
}
export type SettingsKey = keyof SettingsValues;
export interface SettingsDocument {
  scope: 'global' | 'project'; projectId: Id | null; revision: Revision;
  defaults: Partial<SettingsValues>; overrides: Partial<SettingsValues>;
  effective: Partial<SettingsValues>;
  fields: { key: SettingsKey; available: boolean; reason: string | null;
    inheritedFrom: 'default' | 'global' | 'project';
    appliesAt: 'immediate' | 'next_safe_point' | 'next_run' | 'restart' }[];
}
export type SettingsPatch = { values: { [K in SettingsKey]?: SettingsValues[K] | null } };
export interface ResetSettings { keys?: SettingsKey[] }

export interface UiEvent {
  eventId: Id; epoch: string; seq: number; projectId: Id; runId: Id | null;
  type: 'project.changed' | 'plan.changed' | 'run.changed' | 'task.changed'
    | 'message.upserted' | 'message.delta' | 'decision.changed' | 'proposal.changed'
    | 'metrics.changed' | 'settings.changed' | 'log.appended' | 'snapshot.required';
  at: ISODate; resourceRevision: Revision | null;
  payload: Record<string, unknown>;
}
export interface EventQuery { epoch?: string; afterSeq?: number; runId?: Id; limit?: number }
export interface EventBatch {
  events: UiEvent[]; epoch: string; nextSeq: number; tailSeq: number;
  hasMore: boolean; requiresSnapshot: boolean;
}

/** Suggested boundary API; implementation may call legacy endpoints or runtime services. */
export interface CcWorkApi {
  bootstrap(): Promise<Result<Bootstrap>>;
  operation(id: Id): Promise<Result<Operation>>;
  projects(q?: PageQuery): Promise<Result<Page<Project>>>;
  inspectProject(body: { path: string }): Promise<Result<ProjectInspection>>;
  addProject(body: AddProject, headers: WriteHeaders): Promise<Result<Operation<Project>>>;
  workspace(projectId: Id, selection?: Pick<Selection, 'planId' | 'runId'>): Promise<Result<Workspace>>;
  plans(projectId: Id, q?: PageQuery): Promise<Result<Page<PlanSummary>>>;
  createPlan(projectId: Id, body: CreatePlan, headers: WriteHeaders): Promise<Result<Operation<PlanDetail>>>;
  plan(projectId: Id, planId: Id): Promise<Result<PlanDetail>>;
  confirmAndRun(projectId: Id, planId: Id, body: ConfirmPlan, headers: VersionedWriteHeaders): Promise<Result<Operation<ConfirmedRun>>>;
  runs(projectId: Id, q?: PageQuery & { planId?: Id }): Promise<Result<Page<RunSummary>>>;
  run(projectId: Id, runId: Id): Promise<Result<RunSummary>>;
  conversations(projectId: Id, runId: Id, q?: PageQuery): Promise<Result<Page<Conversation>>>;
  messages(projectId: Id, runId: Id, conversationId: Id, q?: PageQuery): Promise<Result<Page<Message>>>;
  sendMessage(projectId: Id, runId: Id, conversationId: Id, body: SendMessage, headers: WriteHeaders): Promise<Result<Operation<{ messageId: Id }>>>;
  runAction(projectId: Id, runId: Id, body: RunAction, headers: VersionedWriteHeaders): Promise<Result<Operation<RunActionResult>>>;
  metrics(projectId: Id, runId: Id): Promise<Result<RunMetrics>>;
  setDecisionPolicy(projectId: Id, runId: Id, body: { mode: 'manual' | 'ai' }, headers: VersionedWriteHeaders): Promise<Result<DecisionPolicy>>;
  tasks(projectId: Id, runId: Id, q?: TaskQuery): Promise<Result<TaskPage>>;
  task(projectId: Id, runId: Id, taskId: Id): Promise<Result<Task>>;
  decisions(projectId: Id, q?: DecisionQuery): Promise<Result<Page<Decision>>>;
  decision(projectId: Id, decisionId: Id): Promise<Result<Decision>>;
  decisionAction(projectId: Id, decisionId: Id, body: DecisionAction, headers: VersionedWriteHeaders): Promise<Result<Operation<DecisionResolution>>>;
  proposals(projectId: Id, runId: Id, q?: PageQuery & { status?: ProposalStatus }): Promise<Result<Page<TaskProposal>>>;
  proposal(projectId: Id, runId: Id, proposalId: Id): Promise<Result<TaskProposal>>;
  reviewProposal(projectId: Id, runId: Id, proposalId: Id, body: ProposalReview, headers: VersionedWriteHeaders): Promise<Result<Operation<TaskProposal>>>;
  logSources(projectId: Id, runId: Id): Promise<Result<LogSource[]>>;
  logs(projectId: Id, runId: Id, q?: LogQuery): Promise<Result<Page<LogEntry>>>;
  exportLogs(projectId: Id, runId: Id, body: LogExportRequest, headers: WriteHeaders): Promise<Result<Operation<{ exportId: Id }>>>;
  downloadLogExport(projectId: Id, runId: Id, exportId: Id): Promise<Blob>;
  artifact(projectId: Id, runId: Id, artifactId: Id, q?: PageQuery): Promise<Result<ArtifactDetail>>;
  settings(projectId?: Id): Promise<Result<SettingsDocument>>;
  patchSettings(body: SettingsPatch, headers: VersionedWriteHeaders, projectId?: Id): Promise<Result<SettingsDocument>>;
  resetSettings(body: ResetSettings, headers: VersionedWriteHeaders, projectId?: Id): Promise<Result<SettingsDocument>>;
  events(projectId: Id, q?: EventQuery): Promise<Result<EventBatch>>;
}
/** Host integration, not a server capability unless a bridge is actually present. */
export interface CcWorkHostBridge {
  pickProjectDirectory(): Promise<{ path: string } | null>;
  openLogInTerminal(target: { projectId: Id; runId: Id; sourceId: Id }): Promise<void>;
}
