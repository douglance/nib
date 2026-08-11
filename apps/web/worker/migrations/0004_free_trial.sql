ALTER TABLE accounts ADD COLUMN trial_state TEXT NOT NULL DEFAULT 'available'
  CHECK (trial_state IN ('available', 'reserved', 'used'));
ALTER TABLE accounts ADD COLUMN trial_job_id TEXT;
ALTER TABLE accounts ADD COLUMN trial_started_at INTEGER;

CREATE INDEX accounts_trial_state ON accounts(trial_state, trial_started_at);

ALTER TABLE jobs ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'paid'
  CHECK (billing_mode IN ('paid', 'trial'));
