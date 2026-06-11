-- Directors expenses tab (Finance → Performance → Directors).
-- Per-director ad-hoc expense log with a £250/month allowance, an ongoing
-- balancing adjustment, and one attachable invoice/receipt file per expense.
-- Visible only to the two directors (gated by email in api/_lib/crm/stats.js).
-- Tables are also self-healed by ensureDirectorExpenses() so a missing migration
-- never 500s, matching the cashflow_costs convention.

CREATE TABLE IF NOT EXISTS director_expenses (
  id             TEXT PRIMARY KEY,
  director_email TEXT NOT NULL,                       -- which director's column it belongs to
  description    TEXT NOT NULL,
  amount         NUMERIC(12,2) NOT NULL DEFAULT 0,    -- £ inc VAT, as logged on the sheet
  vattable       BOOLEAN NOT NULL DEFAULT false,
  spent_on       DATE,
  month          TEXT NOT NULL,                       -- 'YYYY-MM', derived from spent_on (or current)
  -- One invoice/receipt file per expense, nullable until attached:
  blob_url       TEXT,
  blob_pathname  TEXT,
  filename       TEXT,
  mime_type      TEXT,
  size_bytes     INTEGER,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_director_expenses_month ON director_expenses (month);
CREATE INDEX IF NOT EXISTS idx_director_expenses_email ON director_expenses (director_email);

-- One row per director: the persistent balancing adjustment (± £) that carries
-- across months until changed (standing headroom; does not compound).
CREATE TABLE IF NOT EXISTS director_settings (
  director_email TEXT PRIMARY KEY,
  balance_adjust NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
