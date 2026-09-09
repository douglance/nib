-- Apply only to the revision's isolated preview database after migrations.
-- Replaying the seed must not reset a trial already exercised by a reviewer.
INSERT INTO accounts (account_id, email, plan, trial_state, unmetered_access, created_at, updated_at)
VALUES ('acct_acceptance_business_rules', 'business-rules@example.invalid', 'default', 'available', 0, unixepoch(), unixepoch())
ON CONFLICT(account_id) DO NOTHING;
