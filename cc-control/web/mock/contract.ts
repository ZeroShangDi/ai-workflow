/** Backend integration DTOs. Runtime behavior and error semantics: CONTRACT.md. */
export type TaskStatus = 'pending' | 'active' | 'done' | 'blocked' | 'failed';
export interface Task { id: string; title: string; status: TaskStatus; description?: string; kind?: string; deps?: string[]; acceptance?: string[]; wbsRef?: string; source?: string }
export interface Plan { status: 'empty' | 'generating' | 'ready' | 'approved' | 'failed'; version: number; summary: string; tasks: Task[]; error?: string | null }
export interface Requirement { id: string; text: string; status: 'submitted' | 'planned'; at: string }
export interface Environment { status: 'unread' | 'reading' | 'ready' | 'failed'; files: {path: string; status: string; summary: string}[]; branch: string; runtime: string; warnings: string[]; error?: string | null }
export interface Message { id: string; role: 'user' | 'assistant' | 'tool'; type: 'text' | 'tool' | 'task' | 'decision'; text: string; at: string; title?: string; status?: string }
export interface Run { runId: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; mode: string; startedAt: string; endedAt?: string; counts: Record<'total' | TaskStatus, number> }
export interface RunEvent { seq: number; runId?: string; type: string; at: string; payload: Record<string, unknown> }
export interface Proposal {
  proposalId: string; status: 'awaiting_approval' | 'decision_required' | 'applied_review_pending' | 'applied' | 'conflicted' | 'failed' | 'rejected';
  reason: string; createdAt: string; updatedAt?: string;
  operations: { type: 'insert_task'; task: Omit<Task, 'status'>; relation: {type: 'prerequisite_for'; targetTaskId: string} }[];
  analysis: { affectedTaskIds: string[]; decisionReasons?: string[] };
  decision?: {decisionId: string; runStamp: string}; approvedBy?: string; reviewedBy?: string; alternative?: string;
}
export interface DecisionEvent {
  event: 'decision_requested' | 'decision_completed' | 'decision_overridden'; decision_id: string; runStamp: string;
  status?: 'pending_review' | 'reviewed' | 'awaiting_human'; created_at?: string; at?: string; instruction?: string; real_question?: string;
  subject?: {capability: 'dynamic_planning'; proposal_id: string};
  result?: {answer: string; real_question?: string; decisive_factors?: string[]; risks?: string[]; type?: string; finality?: string};
}
export type Result<T = object> = ({ok: true} & T) | {ok: false; error: string};
export interface ReadResponses {
  '/projects/directories': Result<{directories: {path: string; name: string; existing: boolean}[]}>;
  '/workspace': Result<{projectRoot: string; environment: Environment; requirements: Requirement[]; plan: Plan}>;
  '/conversation': Result<{messages: Message[]; source: 'structured'}>;
  '/logs/source': Result<{source: string; kind: 'decision_log'; text: string}>;
  '/awf/state': {mode: 'idle' | 'run' | 'pause'; version: string; tasks: Task[]; wbs: {id: string; title: string}[]; currentState: string};
  '/run/status': Result<{runs: Run[]} | {run: Run}>;
  '/run/events': Result<{events: RunEvent[]; afterSeq: number; tailSeq: number; trimmed: number}>;
  '/awf/decisions': Result<{total: number; decisions: DecisionEvent[]}>;
  '/awf/dynamic-planning/proposals': Result<{proposals: Proposal[]} | {proposal: Proposal}>;
}
export interface WriteRequests {
  '/projects/open': {path: string};
  '/workspace/environment/read': object;
  '/requirements': {text: string};
  '/plan/generate': object;
  '/plan/save': Pick<Plan, 'version' | 'summary' | 'tasks'>;
  '/plan/approve': {version: number};
  '/run/submit': {runId?: string; mode?: string};
  '/run/state/mode': {mode: 'run' | 'pause' | 'idle'};
  '/send': {text: string};
  '/respond': {value: string};
  '/stop': object;
  '/awf/decisions/:id/override': {instruction: string; original_answer?: string};
  '/awf/decisions/:id/resolve': {reviewer: string; note?: string; outcome: 'approve'};
  '/awf/decisions/:id/adopt': object;
  '/run/dynamic-planning/proposals/:id/approve': {reviewer: string; note?: string};
  '/run/dynamic-planning/proposals/:id/alternative': {reviewer: string; instruction: string};
  '/run/dynamic-planning/proposals/:id/retry': {reviewer: string; note?: string};
  '/run/dynamic-planning/proposals/:id/review': {reviewer: string; note?: string};
  '/run/:id/cancel': object;
  '/run/:id/retry': object;
  '/tasks/:id/retry': object;
  '/tasks/:id/unblock': object;
}
