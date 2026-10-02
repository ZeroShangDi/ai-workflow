ALTER TABLE session_attempts ADD COLUMN run_id TEXT;
CREATE INDEX idx_session_attempts_run_id ON session_attempts(run_id) WHERE run_id IS NOT NULL;
