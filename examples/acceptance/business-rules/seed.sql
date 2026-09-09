insert into accounts (account_id, email, created_at)
values ('acct_acceptance_business_rules', 'business-rules@example.invalid', unixepoch())
on conflict(account_id) do nothing;

insert into account_entitlements (account_id, plan, status, created_at, updated_at)
values ('acct_acceptance_business_rules', 'trial', 'active', unixepoch(), unixepoch())
on conflict(account_id) do update set plan = excluded.plan, status = excluded.status, updated_at = excluded.updated_at;
