CREATE TABLE acceptance_usage_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES acceptance_projects(id) ON DELETE CASCADE,
  review_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'review_published',
    'review_page_viewed',
    'preview_opened',
    'review_decision_recorded'
  )),
  idempotency_key TEXT NOT NULL,
  revision INTEGER CHECK (revision IS NULL OR revision >= 1),
  decision TEXT CHECK (decision IS NULL OR decision IN ('approve', 'reject', 'request_revision')),
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (project_id, event_type, actor_id, idempotency_key)
);

CREATE INDEX acceptance_usage_events_project_type_time
ON acceptance_usage_events(project_id, event_type, occurred_at);

CREATE INDEX acceptance_usage_events_project_review
ON acceptance_usage_events(project_id, review_id);

CREATE INDEX acceptance_usage_events_project_actor
ON acceptance_usage_events(project_id, actor_id, review_id);
