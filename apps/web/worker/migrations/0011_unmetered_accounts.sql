ALTER TABLE accounts ADD COLUMN unmetered_access INTEGER NOT NULL DEFAULT 0
  CHECK (unmetered_access IN (0, 1));
