PRAGMA foreign_keys = OFF;

CREATE TABLE accounts_v2 (
  account_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'default' CHECK (plan IN ('default', 'high')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_recurring_item_id TEXT,
  trial_state TEXT NOT NULL DEFAULT 'available' CHECK (trial_state IN ('available', 'reserved', 'used')),
  trial_job_id TEXT,
  trial_started_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO accounts_v2 (
  account_id, email, plan, stripe_customer_id, stripe_subscription_id,
  stripe_recurring_item_id, trial_state, trial_job_id, trial_started_at,
  created_at, updated_at
)
SELECT
  lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
  ),
  lower(trim(tenant_id)), plan, stripe_customer_id, stripe_subscription_id,
  stripe_recurring_item_id, trial_state, trial_job_id, trial_started_at,
  created_at, updated_at
FROM accounts;

CREATE TABLE jobs_v2 (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  model TEXT NOT NULL,
  quality TEXT NOT NULL,
  resolution TEXT NOT NULL,
  format TEXT NOT NULL,
  aspect TEXT NOT NULL,
  usage_cents INTEGER NOT NULL,
  artifact_key TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  billing_mode TEXT NOT NULL DEFAULT 'paid' CHECK (billing_mode IN ('paid', 'trial')),
  FOREIGN KEY (account_id) REFERENCES accounts_v2(account_id)
);

INSERT INTO jobs_v2
SELECT j.id, a.account_id, j.status, j.model, j.quality, j.resolution,
       j.format, j.aspect, j.usage_cents, j.artifact_key, j.error_code,
       j.created_at, j.updated_at, j.expires_at, j.billing_mode
FROM jobs j
JOIN accounts_v2 a ON a.email = lower(trim(j.tenant_id));

CREATE TABLE usage_ledger_v2 (
  identifier TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  usage_cents INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'sent')),
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  FOREIGN KEY (account_id) REFERENCES accounts_v2(account_id),
  FOREIGN KEY (job_id) REFERENCES jobs_v2(id)
);

INSERT INTO usage_ledger_v2
SELECT l.identifier, a.account_id, l.job_id, l.usage_cents, l.state,
       l.created_at, l.sent_at
FROM usage_ledger l
JOIN accounts_v2 a ON a.email = lower(trim(l.tenant_id));

DROP TABLE usage_ledger;
DROP TABLE jobs;
DROP TABLE accounts;
ALTER TABLE accounts_v2 RENAME TO accounts;
ALTER TABLE jobs_v2 RENAME TO jobs;
ALTER TABLE usage_ledger_v2 RENAME TO usage_ledger;

CREATE INDEX accounts_email ON accounts(email);
CREATE INDEX accounts_trial_state ON accounts(trial_state, trial_started_at);
CREATE INDEX jobs_account_created ON jobs(account_id, created_at DESC);
CREATE INDEX jobs_artifact_expiry ON jobs(expires_at) WHERE artifact_key IS NOT NULL;

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  pkce_challenge TEXT NOT NULL,
  platform TEXT NOT NULL,
  device_name TEXT NOT NULL,
  network_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  verified_at INTEGER,
  consumed_at INTEGER,
  session_id TEXT
);
CREATE INDEX auth_challenges_email_created ON auth_challenges(email, created_at DESC);
CREATE INDEX auth_challenges_network_created ON auth_challenges(network_hash, created_at DESC);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id)
);
CREATE INDEX auth_sessions_account ON auth_sessions(account_id, revoked_at, last_used_at DESC);

PRAGMA foreign_keys = ON;
