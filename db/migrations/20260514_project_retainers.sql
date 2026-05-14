CREATE TABLE IF NOT EXISTS project_retainers (
  id                TEXT          PRIMARY KEY,
  deal_id           TEXT          NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id        TEXT          REFERENCES contacts(id) ON DELETE SET NULL,
  title             TEXT          NOT NULL,
  allocation_type   TEXT          NOT NULL CHECK (allocation_type IN ('money', 'credits')),
  allocation_amount NUMERIC(12,2) NOT NULL,
  currency          TEXT          NOT NULL DEFAULT 'GBP',
  notes             TEXT,
  created_by        TEXT          NOT NULL REFERENCES users(email),
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS project_retainers_deal_idx ON project_retainers(deal_id);

CREATE TABLE IF NOT EXISTS project_retainer_entries (
  id          TEXT          PRIMARY KEY,
  retainer_id TEXT          NOT NULL REFERENCES project_retainers(id) ON DELETE CASCADE,
  description TEXT          NOT NULL,
  value       NUMERIC(12,2) NOT NULL,
  worked_at   DATE          NOT NULL DEFAULT CURRENT_DATE,
  created_by  TEXT          NOT NULL REFERENCES users(email),
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS project_retainer_entries_retainer_idx ON project_retainer_entries(retainer_id);
