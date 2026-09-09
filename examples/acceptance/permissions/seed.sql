insert into accounts (account_id, email, created_at)
values
  ('acct_acceptance_admin', 'acceptance-admin@example.invalid', unixepoch()),
  ('acct_acceptance_reviewer', 'acceptance-reviewer@example.invalid', unixepoch()),
  ('acct_acceptance_viewer', 'acceptance-viewer@example.invalid', unixepoch())
on conflict(account_id) do nothing;

insert into acceptance_teams (id, name, created_at, updated_at)
values ('team_acceptance_permissions', 'Acceptance permissions pilot', unixepoch(), unixepoch())
on conflict(id) do update set name = excluded.name, updated_at = excluded.updated_at;

insert into acceptance_projects (id, team_id, name, enabled, public_read, quorum, ttl_seconds, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000303', 'team_acceptance_permissions', 'Permissions pilot', 1, 0, 1, 604800, unixepoch(), unixepoch())
on conflict(id) do update set enabled = excluded.enabled, public_read = excluded.public_read, updated_at = excluded.updated_at;

insert into acceptance_project_members (project_id, account_id, role, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000303', 'acct_acceptance_admin', 'admin', unixepoch(), unixepoch()),
  ('00000000-0000-4000-8000-000000000303', 'acct_acceptance_reviewer', 'reviewer', unixepoch(), unixepoch()),
  ('00000000-0000-4000-8000-000000000303', 'acct_acceptance_viewer', 'viewer', unixepoch(), unixepoch())
on conflict(project_id, account_id) do update set role = excluded.role, updated_at = excluded.updated_at;

insert into acceptance_project_credentials (id, project_id, name, token_hash, scopes, created_at, updated_at)
values ('cred_acceptance_publish_verify', '00000000-0000-4000-8000-000000000303', 'CI publish and verify', 'replace-with-ci-token-hash', 'publish,verify', unixepoch(), unixepoch())
on conflict(id) do update set scopes = excluded.scopes, updated_at = excluded.updated_at;
