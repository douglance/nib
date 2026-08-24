-- This production-only table referenced accounts(tenant_id), which was removed
-- when migration 0006 replaced tenant IDs with stable account IDs. The feature
-- no longer exists and the table is empty, but SQLite validates the stale
-- foreign key on account writes.
DROP TABLE IF EXISTS private_request_tenants;
