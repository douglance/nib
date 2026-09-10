-- Apply only to the revision's isolated preview database after migrations.
-- The account has no seeded session or reusable token; use the normal email-code login flow.
insert into accounts (account_id, email, created_at, updated_at)
values ('acct_acceptance_onboarding', '__NIB_ACCEPTANCE_PILOT_ONBOARDING_EMAIL__', unixepoch(), unixepoch())
on conflict(account_id) do nothing;
