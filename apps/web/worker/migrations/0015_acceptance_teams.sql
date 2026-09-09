CREATE TABLE acceptance_teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  default_quorum INTEGER NOT NULL DEFAULT 1 CHECK (default_quorum >= 1),
  default_ttl_seconds INTEGER NOT NULL DEFAULT 604800 CHECK (default_ttl_seconds BETWEEN 60 AND 604800),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  archived_by TEXT
);

CREATE TABLE acceptance_team_members (
  team_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, account_id),
  FOREIGN KEY (team_id) REFERENCES acceptance_teams(id) ON DELETE CASCADE
);
CREATE INDEX acceptance_team_members_account ON acceptance_team_members(account_id, role);

CREATE TABLE acceptance_team_invitations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_sent_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_by TEXT,
  revoked_at INTEGER,
  revoked_by TEXT,
  FOREIGN KEY (team_id) REFERENCES acceptance_teams(id) ON DELETE CASCADE
);
CREATE INDEX acceptance_team_invitations_team_email ON acceptance_team_invitations(team_id, email, revoked_at, accepted_at);
CREATE INDEX acceptance_team_invitations_token ON acceptance_team_invitations(token_hash);

CREATE TABLE acceptance_projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT,
  quorum INTEGER NOT NULL DEFAULT 1 CHECK (quorum >= 1),
  ttl_seconds INTEGER NOT NULL DEFAULT 604800 CHECK (ttl_seconds BETWEEN 60 AND 604800),
  public_read INTEGER NOT NULL DEFAULT 0 CHECK (public_read IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  archived_by TEXT,
  FOREIGN KEY (team_id) REFERENCES acceptance_teams(id) ON DELETE CASCADE,
  UNIQUE (team_id, slug)
);
CREATE INDEX acceptance_projects_team ON acceptance_projects(team_id, created_at DESC);
CREATE INDEX acceptance_projects_archived ON acceptance_projects(archived_at, team_id);

CREATE TABLE acceptance_project_members (
  project_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'reviewer', 'viewer')),
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, account_id),
  FOREIGN KEY (project_id) REFERENCES acceptance_projects(id) ON DELETE CASCADE
);
CREATE INDEX acceptance_project_members_account ON acceptance_project_members(account_id, role);

CREATE TABLE acceptance_project_credentials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  FOREIGN KEY (project_id) REFERENCES acceptance_projects(id) ON DELETE CASCADE
);
CREATE INDEX acceptance_project_credentials_project ON acceptance_project_credentials(project_id, revoked_at, created_at DESC);

CREATE TABLE acceptance_idempotency (
  account_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, idempotency_key)
);
CREATE INDEX acceptance_idempotency_created ON acceptance_idempotency(created_at);

CREATE TABLE acceptance_invitation_email_outbox (
  id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL,
  email TEXT NOT NULL,
  raw_message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  FOREIGN KEY (invitation_id) REFERENCES acceptance_team_invitations(id) ON DELETE CASCADE
);
CREATE INDEX acceptance_invitation_email_outbox_unsent ON acceptance_invitation_email_outbox(sent_at, lease_expires_at, created_at);
