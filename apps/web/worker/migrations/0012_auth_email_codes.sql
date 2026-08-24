ALTER TABLE auth_challenges ADD COLUMN code_hash TEXT;
ALTER TABLE auth_challenges ADD COLUMN failed_code_attempts INTEGER NOT NULL DEFAULT 0;
