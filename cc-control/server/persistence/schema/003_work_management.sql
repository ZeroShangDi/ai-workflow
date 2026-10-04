ALTER TABLE requirements ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'draft'
  CHECK (lifecycle_status IN ('draft','todo','in_progress','pending_acceptance','done','failed','cancelled'));
ALTER TABLE requirements ADD COLUMN allow_ai_work INTEGER NOT NULL DEFAULT 0 CHECK (allow_ai_work IN (0,1));
ALTER TABLE requirements ADD COLUMN board_position REAL NOT NULL DEFAULT 0;
ALTER TABLE requirements ADD COLUMN work_kind TEXT NOT NULL DEFAULT 'requirement'
  CHECK (work_kind IN ('requirement','bugfix'));
ALTER TABLE requirements ADD COLUMN origin_bug_id TEXT;
ALTER TABLE requirements ADD COLUMN accepted_head_sha TEXT;
ALTER TABLE requirements ADD COLUMN merged_head_sha TEXT;
UPDATE requirements SET lifecycle_status = CASE status
  WHEN 'planned' THEN 'todo'
  WHEN 'in_progress' THEN 'in_progress'
  WHEN 'done' THEN 'pending_acceptance'
  WHEN 'archived' THEN 'cancelled'
  ELSE 'draft' END;

ALTER TABLE bugs ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'open'
  CHECK (lifecycle_status IN ('open','in_progress','pending_acceptance','closed','failed'));
ALTER TABLE bugs ADD COLUMN origin TEXT NOT NULL DEFAULT 'project_report'
  CHECK (origin IN ('project_report','run_gate','run_observation'));
ALTER TABLE bugs ADD COLUMN resolution_owner TEXT;
ALTER TABLE bugs ADD COLUMN allow_ai_work INTEGER NOT NULL DEFAULT 0 CHECK (allow_ai_work IN (0,1));
ALTER TABLE bugs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bugs ADD COLUMN updated_at TEXT;
ALTER TABLE bugs ADD COLUMN accepted_head_sha TEXT;
ALTER TABLE bugs ADD COLUMN merged_head_sha TEXT;
ALTER TABLE bugs ADD COLUMN origin_event_key TEXT;
UPDATE bugs SET lifecycle_status = CASE status
  WHEN 'fixed' THEN 'pending_acceptance'
  WHEN 'verified' THEN 'pending_acceptance'
  WHEN 'wont_fix' THEN 'closed'
  ELSE 'open' END, updated_at = created_at;
CREATE UNIQUE INDEX idx_bugs_origin_event ON bugs(project_id, origin_event_key)
  WHERE origin_event_key IS NOT NULL;

CREATE TABLE work_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('requirement','bug')),
  item_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  actor_type TEXT NOT NULL DEFAULT 'system',
  idempotency_key TEXT,
  occurred_at TEXT NOT NULL,
  UNIQUE(project_id,item_type,item_id,idempotency_key)
);
CREATE INDEX idx_work_events_item ON work_events(project_id,item_type,item_id,occurred_at);
INSERT INTO work_events(id,project_id,item_type,item_id,event_type,payload_json,actor_type,idempotency_key,occurred_at)
SELECT 'legacy-close:' || id, project_id, 'bug', id, 'close',
       '{"reason":"不修复（历史状态迁移）"}', 'system', 'legacy:wont_fix', created_at
FROM bugs WHERE status = 'wont_fix';

CREATE TABLE work_claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('requirement','bug')),
  item_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  branch_name TEXT,
  worktree_path TEXT,
  base_sha TEXT,
  head_sha TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_work_claims_active_item ON work_claims(project_id,item_type,item_id)
  WHERE status = 'active';
CREATE INDEX idx_work_claims_active_project ON work_claims(project_id,status,expires_at);

CREATE TABLE work_external_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('requirement','bug')),
  item_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_project_id TEXT NOT NULL,
  external_item_id TEXT NOT NULL,
  last_seen_revision TEXT,
  last_sync_at TEXT,
  UNIQUE(provider,external_project_id,external_item_id),
  UNIQUE(project_id,item_type,item_id,provider)
);
