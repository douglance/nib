CREATE TABLE acceptance_evidence (
  project_id TEXT NOT NULL REFERENCES acceptance_projects(id) ON DELETE CASCADE,
  digest TEXT NOT NULL,
  content_type TEXT NOT NULL,
  name TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (project_id, digest)
);

CREATE TABLE acceptance_upload_operations (
  project_id TEXT NOT NULL REFERENCES acceptance_projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (project_id, actor_id, idempotency_key)
);

CREATE TABLE acceptance_notification_deliveries (
  event_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES acceptance_projects(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'devices')),
  delivered_at INTEGER,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (event_id, account_id, channel)
);
