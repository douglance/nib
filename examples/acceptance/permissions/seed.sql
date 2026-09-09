-- Apply only to the revision's isolated preview database after migrations.
-- Sessions and automation credentials are created by the example runner, not shared in source.
insert into accounts (account_id, email, created_at, updated_at)
values
  ('acct_acceptance_owner', 'acceptance-owner@example.invalid', unixepoch(), unixepoch()),
  ('acct_acceptance_admin', 'acceptance-admin@example.invalid', unixepoch(), unixepoch()),
  ('acct_acceptance_reviewer', 'acceptance-reviewer@example.invalid', unixepoch(), unixepoch()),
  ('acct_acceptance_viewer', 'acceptance-viewer@example.invalid', unixepoch(), unixepoch())
on conflict(account_id) do nothing;

insert into acceptance_teams (id, name, created_by, created_at, updated_at)
values ('00000000-0000-4000-8000-000000003303', 'Acceptance permissions pilot', 'acct_acceptance_owner', unixepoch(), unixepoch())
on conflict(id) do nothing;

insert into acceptance_team_members (team_id, account_id, role, added_by, added_at)
values
  ('00000000-0000-4000-8000-000000003303', 'acct_acceptance_owner', 'owner', 'acct_acceptance_owner', unixepoch()),
  ('00000000-0000-4000-8000-000000003303', 'acct_acceptance_admin', 'member', 'acct_acceptance_owner', unixepoch()),
  ('00000000-0000-4000-8000-000000003303', 'acct_acceptance_reviewer', 'member', 'acct_acceptance_owner', unixepoch()),
  ('00000000-0000-4000-8000-000000003303', 'acct_acceptance_viewer', 'member', 'acct_acceptance_owner', unixepoch())
on conflict(team_id, account_id) do nothing;

insert into acceptance_projects (id, team_id, name, enabled, public_read, quorum, ttl_seconds, created_by, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000003303', 'Permissions pilot', 1, 0, 1, 604800, 'acct_acceptance_owner', unixepoch(), unixepoch())
on conflict(id) do nothing;

insert into acceptance_project_members (project_id, account_id, role, added_by, added_at)
values
  ('00000000-0000-4000-8000-000000000303', 'acct_acceptance_admin', 'admin', 'acct_acceptance_owner', unixepoch()),
  ('00000000-0000-4000-8000-000000000303', 'acct_acceptance_reviewer', 'reviewer', 'acct_acceptance_owner', unixepoch()),
  ('00000000-0000-4000-8000-000000000303', 'acct_acceptance_viewer', 'viewer', 'acct_acceptance_owner', unixepoch())
on conflict(project_id, account_id) do nothing;
