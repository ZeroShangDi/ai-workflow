PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  active_requirement_id TEXT REFERENCES requirements(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE project_checkouts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(environment_id, project_id, canonical_path)
);

CREATE TABLE requirements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  request_text TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  scope_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'planned', 'in_progress', 'done', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id, project_id)
);

CREATE TABLE requirement_milestones (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE(id, requirement_id)
);

CREATE TABLE workflow_sessions (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('plan', 'run')),
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'active', 'interrupted', 'completed', 'failed', 'cancelled')),
  title TEXT NOT NULL DEFAULT '',
  log_dir TEXT,
  origin_environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  started_at TEXT,
  ended_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  UNIQUE(id, requirement_id)
);

CREATE TABLE session_attempts (
  id TEXT PRIMARY KEY,
  workflow_session_id TEXT NOT NULL REFERENCES workflow_sessions(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'interrupted', 'completed', 'failed')),
  provider TEXT,
  error_text TEXT,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE(workflow_session_id, attempt_no),
  UNIQUE(id, workflow_session_id)
);

CREATE TABLE session_conversations (
  id TEXT PRIMARY KEY,
  workflow_session_id TEXT NOT NULL REFERENCES workflow_sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_conversation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(provider, external_conversation_id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'dev',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'done', 'blocked')),
  source TEXT,
  prompt TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',
  blocked_reason TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(requirement_id, task_key),
  UNIQUE(id, requirement_id)
);

CREATE TABLE milestone_tasks (
  milestone_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(milestone_id, task_id),
  FOREIGN KEY(milestone_id, requirement_id)
    REFERENCES requirement_milestones(id, requirement_id) ON DELETE CASCADE,
  FOREIGN KEY(task_id, requirement_id)
    REFERENCES tasks(id, requirement_id) ON DELETE CASCADE
);

CREATE TABLE task_dependencies (
  requirement_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(task_id, depends_on_task_id),
  CHECK(task_id <> depends_on_task_id),
  FOREIGN KEY(task_id, requirement_id) REFERENCES tasks(id, requirement_id) ON DELETE CASCADE,
  FOREIGN KEY(depends_on_task_id, requirement_id) REFERENCES tasks(id, requirement_id) ON DELETE RESTRICT
);

CREATE TABLE task_commits (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE task_executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workflow_session_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  attempt_id TEXT,
  status TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  ended_at TEXT,
  FOREIGN KEY(task_id, requirement_id) REFERENCES tasks(id, requirement_id) ON DELETE CASCADE,
  FOREIGN KEY(workflow_session_id, requirement_id) REFERENCES workflow_sessions(id, requirement_id) ON DELETE CASCADE,
  FOREIGN KEY(attempt_id, workflow_session_id) REFERENCES session_attempts(id, workflow_session_id) ON DELETE RESTRICT
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL,
  workflow_session_id TEXT,
  decision_type TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved', 'deferred', 'overridden')),
  question TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id, requirement_id),
  FOREIGN KEY(requirement_id, project_id) REFERENCES requirements(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY(workflow_session_id, requirement_id) REFERENCES workflow_sessions(id, requirement_id) ON DELETE RESTRICT
);

CREATE TABLE decision_tasks (
  decision_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('informs', 'blocks', 'supersedes', 'caused_by')),
  PRIMARY KEY(decision_id, task_id, relation),
  FOREIGN KEY(decision_id, requirement_id) REFERENCES decisions(id, requirement_id) ON DELETE CASCADE,
  FOREIGN KEY(task_id, requirement_id) REFERENCES tasks(id, requirement_id) ON DELETE CASCADE
);

CREATE TABLE decision_events (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_id TEXT,
  occurred_at TEXT NOT NULL,
  origin_environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  idempotency_key TEXT,
  UNIQUE(decision_id, sequence),
  UNIQUE(decision_id, event_type, idempotency_key)
);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id TEXT REFERENCES requirements(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE proposal_events (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);

CREATE TABLE bugs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id TEXT REFERENCES requirements(id) ON DELETE SET NULL,
  workflow_session_id TEXT REFERENCES workflow_sessions(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'fixed', 'verified', 'wont_fix')),
  created_at TEXT NOT NULL
);

CREATE TABLE bug_tasks (
  bug_id TEXT NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('discovered_by', 'fixed_by', 'verified_by')),
  PRIMARY KEY(bug_id, task_id, relation)
);

CREATE TABLE product_issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'planned', 'closed', 'deferred')),
  priority INTEGER NOT NULL DEFAULT 0,
  requirement_id TEXT REFERENCES requirements(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE issue_events (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES product_issues(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);

CREATE TABLE project_architecture_nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES project_architecture_nodes(id) ON DELETE RESTRICT,
  node_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  UNIQUE(project_id, node_key),
  UNIQUE(id, project_id)
);

CREATE TABLE domain_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  origin_environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE(aggregate_type, aggregate_id, sequence)
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  checkout_id TEXT REFERENCES project_checkouts(id) ON DELETE SET NULL,
  relative_path TEXT NOT NULL,
  media_type TEXT,
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  digest TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE legacy_ids (
  entity_type TEXT NOT NULL,
  legacy_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(entity_type, legacy_id),
  UNIQUE(entity_type, entity_id, legacy_id)
);

CREATE INDEX idx_checkouts_project ON project_checkouts(project_id);
CREATE INDEX idx_requirements_project_status ON requirements(project_id, status, updated_at DESC);
CREATE INDEX idx_sessions_requirement_kind ON workflow_sessions(requirement_id, kind, created_at DESC);
CREATE INDEX idx_attempts_session ON session_attempts(workflow_session_id, attempt_no);
CREATE INDEX idx_tasks_requirement_status_position ON tasks(requirement_id, status, position);
CREATE INDEX idx_task_executions_task ON task_executions(task_id, started_at DESC);
CREATE INDEX idx_decisions_requirement ON decisions(requirement_id, created_at DESC);
CREATE INDEX idx_decision_events_decision_sequence ON decision_events(decision_id, sequence);
CREATE INDEX idx_issues_project_status_priority ON product_issues(project_id, status, priority DESC);
CREATE INDEX idx_architecture_project_parent ON project_architecture_nodes(project_id, parent_id, position);
CREATE INDEX idx_domain_events_aggregate ON domain_events(aggregate_type, aggregate_id, sequence);
CREATE INDEX idx_artifacts_owner ON artifacts(owner_type, owner_id);
