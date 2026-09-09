ALTER TABLE usage_ledger ADD COLUMN first_attempt_at INTEGER;
ALTER TABLE usage_ledger ADD COLUMN stripe_event_name TEXT;
ALTER TABLE usage_ledger ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE usage_ledger ADD COLUMN stripe_value INTEGER;
ALTER TABLE usage_ledger ADD COLUMN stripe_event_timestamp INTEGER;
ALTER TABLE usage_ledger ADD COLUMN reconciliation_required INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_required IN (0, 1));

CREATE INDEX usage_ledger_queued_retry
ON usage_ledger(created_at)
WHERE state = 'queued' AND reconciliation_required = 0;
