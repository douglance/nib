CREATE TABLE accounts (
  tenant_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'default' CHECK (plan IN ('default', 'high')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_recurring_item_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
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
  FOREIGN KEY (tenant_id) REFERENCES accounts(tenant_id)
);
CREATE INDEX jobs_tenant_created ON jobs(tenant_id, created_at DESC);

CREATE TABLE usage_ledger (
  identifier TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  usage_cents INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'sent')),
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
