-- Account sessions replaced the old customer credential tokens. This
-- production-only table is empty and still references accounts(tenant_id), a
-- column removed by migration 0006, so it prevents otherwise valid writes.
DROP TABLE IF EXISTS customer_credentials;
