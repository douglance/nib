CREATE TABLE acceptance_integration_idempotency (
  project_id TEXT NOT NULL REFERENCES acceptance_projects(id) ON DELETE CASCADE,
  route TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'failed')),
  response_json TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, route, idempotency_key)
);

CREATE TABLE acceptance_integration_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES acceptance_projects(id) ON DELETE CASCADE,
  review_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  gate TEXT NOT NULL,
  revision INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'revision_requested', 'expired', 'superseded', 'invalidated')),
  manifest_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX acceptance_integration_events_project_sequence
ON acceptance_integration_events(project_id, sequence);

CREATE TABLE acceptance_integration_event_sinks (
  event_id TEXT NOT NULL REFERENCES acceptance_integration_events(id) ON DELETE CASCADE,
  sink TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'done', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  claimed_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, sink)
);

CREATE INDEX acceptance_integration_event_sinks_retry
ON acceptance_integration_event_sinks(state, updated_at)
WHERE state IN ('pending', 'failed');

CREATE TABLE acceptance_github_installations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES acceptance_projects(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  allowed_workflows_json TEXT NOT NULL,
  gates_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by_account_id TEXT REFERENCES accounts(account_id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, repository_id)
);

CREATE INDEX acceptance_github_installations_repository
ON acceptance_github_installations(repository_id)
WHERE enabled = 1;

CREATE TABLE acceptance_github_workflow_tokens (
  token_hash TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES acceptance_projects(id) ON DELETE CASCADE,
  scopes_json TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  workflow_ref TEXT NOT NULL,
  job_workflow_ref TEXT,
  sha TEXT,
  ref TEXT,
  event_name TEXT,
  github_actor TEXT,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX acceptance_github_workflow_tokens_live
ON acceptance_github_workflow_tokens(project_id, expires_at)
WHERE revoked_at IS NULL;

CREATE TABLE acceptance_github_webhook_deliveries (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'received' CHECK (state IN ('received', 'processing', 'processed', 'failed', 'invalid_json')),
  received_at INTEGER NOT NULL,
  processing_started_at INTEGER,
  processed_at INTEGER
);

CREATE TABLE acceptance_github_pull_heads (
  repository_id TEXT NOT NULL,
  pull_number TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  subject TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, pull_number)
);

CREATE TABLE acceptance_github_check_runs (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL REFERENCES acceptance_github_installations(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES acceptance_integration_events(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES acceptance_projects(id) ON DELETE CASCADE,
  review_id TEXT NOT NULL,
  gate TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  check_run_id TEXT,
  check_url TEXT,
  conclusion TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (config_id, event_id)
);

CREATE INDEX acceptance_github_check_runs_review
ON acceptance_github_check_runs(project_id, review_id);

CREATE TABLE acceptance_github_check_heads (
  config_id TEXT NOT NULL REFERENCES acceptance_github_installations(id) ON DELETE CASCADE,
  gate TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  latest_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (config_id, gate, head_sha)
);

CREATE TABLE acceptance_github_reconcile_cursors (
  id TEXT PRIMARY KEY,
  cursor_updated_at INTEGER NOT NULL,
  cursor_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE acceptance_webhook_endpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES acceptance_projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  description TEXT,
  secret TEXT NOT NULL,
  events_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by_account_id TEXT REFERENCES accounts(account_id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX acceptance_webhook_endpoints_project
ON acceptance_webhook_endpoints(project_id)
WHERE enabled = 1;

CREATE TABLE acceptance_webhook_project_sequences (
  project_id TEXT PRIMARY KEY REFERENCES acceptance_projects(id) ON DELETE CASCADE,
  next_sequence INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE acceptance_webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES acceptance_webhook_endpoints(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES acceptance_projects(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES acceptance_integration_events(id) ON DELETE CASCADE,
  project_sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'retry', 'delivered', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  next_attempt_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (webhook_id, event_id)
);

CREATE INDEX acceptance_webhook_deliveries_retry
ON acceptance_webhook_deliveries(project_id, project_sequence)
WHERE state IN ('queued', 'retry');

CREATE TABLE acceptance_webhook_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES acceptance_webhook_deliveries(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status INTEGER NOT NULL,
  response_body TEXT,
  attempted_at INTEGER NOT NULL,
  UNIQUE (delivery_id, attempt_number)
);
