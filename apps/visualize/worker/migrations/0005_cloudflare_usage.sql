CREATE TABLE cloudflare_usage_daily (
  charge_date TEXT NOT NULL,
  product_family TEXT NOT NULL,
  metric_id TEXT NOT NULL,
  consumed_unit TEXT NOT NULL,
  consumed_quantity REAL NOT NULL,
  billed_cost REAL,
  effective_cost REAL,
  currency TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (
    charge_date,
    product_family,
    metric_id,
    consumed_unit,
    currency
  )
);
