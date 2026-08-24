-- Nib launched without legacy customers. Remove every pre-launch identity and
-- generation row, then drop the superseded auth and workspace schemas. The
-- only account system after this migration is accounts + auth_challenges +
-- auth_sessions.
PRAGMA foreign_keys = OFF;

DELETE FROM usage_ledger;
DELETE FROM jobs;
DELETE FROM auth_sessions;
DELETE FROM auth_challenges;
DELETE FROM deleted_accounts;
DELETE FROM stripe_events;
DELETE FROM cloudflare_usage_daily;
DELETE FROM accounts;

DROP TABLE IF EXISTS passkey;
DROP TABLE IF EXISTS deviceCode;
DROP TABLE IF EXISTS expert_tokens;
DROP TABLE IF EXISTS workspace_members;
DROP TABLE IF EXISTS workspaces;
DROP TABLE IF EXISTS user_profiles;
DROP TABLE IF EXISTS auth_account;
DROP TABLE IF EXISTS auth_session;
DROP TABLE IF EXISTS auth_verification;
DROP TABLE IF EXISTS auth_rate_limit;
DROP TABLE IF EXISTS auth_user;
DROP TABLE IF EXISTS private_request_usage;

PRAGMA foreign_keys = ON;
