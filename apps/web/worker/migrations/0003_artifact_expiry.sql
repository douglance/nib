ALTER TABLE jobs ADD COLUMN expires_at INTEGER;
CREATE INDEX jobs_artifact_expiry ON jobs(expires_at) WHERE artifact_key IS NOT NULL;
