CREATE TABLE acceptance_provider_verifications (
  project_id TEXT NOT NULL REFERENCES acceptance_projects(id) ON DELETE CASCADE,
  review_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, actor_id, idempotency_key)
);
CREATE INDEX acceptance_provider_verifications_current
ON acceptance_provider_verifications(project_id, review_id, manifest_hash, expires_at);
