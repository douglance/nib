CREATE TABLE deleted_accounts (
  account_id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);

CREATE INDEX deleted_accounts_deleted_at ON deleted_accounts(deleted_at);
