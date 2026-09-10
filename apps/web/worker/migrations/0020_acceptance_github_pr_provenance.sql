CREATE TABLE acceptance_github_pr_provenance (
  project_id TEXT NOT NULL REFERENCES acceptance_projects(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  gate TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  pull_number TEXT NOT NULL,
  build_commit_sha TEXT NOT NULL,
  verified_head_sha TEXT NOT NULL,
  verified_merge_commit_sha TEXT,
  workflow_ref TEXT NOT NULL,
  job_workflow_ref TEXT,
  actor_id TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, subject, gate, manifest_hash)
);

CREATE INDEX acceptance_github_pr_provenance_pull
ON acceptance_github_pr_provenance(repository_id, pull_number, verified_head_sha);

ALTER TABLE acceptance_github_check_heads ADD COLUMN build_commit_sha TEXT;
ALTER TABLE acceptance_github_check_runs ADD COLUMN build_commit_sha TEXT;
