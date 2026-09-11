-- Squideo Academy billing in the CRM (api/_lib/crm/academies.js).
--
-- Self-healed by ensureAcademyTables(), so this file is the record rather than
-- a step that must be run by hand.
--
-- academy_invoices: what has been billed for which academy period, one row per
-- invoice line. The unique index is what stops a period being invoiced twice,
-- including by two people pressing the button at once (the row is claimed
-- before Xero is asked). tenant_id is the academy's id on the academy platform
-- (squideo-lms); manual_invoice_id is the CRM invoice the line went on, or NULL
-- for a period marked as billed some other way (source 'elsewhere').
CREATE TABLE IF NOT EXISTS academy_invoices (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  company_id        TEXT,
  kind              TEXT NOT NULL,          -- plan | extras | custom
  period_key        TEXT NOT NULL,          -- plan:2026-10-20 | extras:2026-07-01 | custom:<id>
  label             TEXT,
  amount_ex_vat     NUMERIC NOT NULL DEFAULT 0,
  manual_invoice_id TEXT,
  source            TEXT NOT NULL DEFAULT 'invoice',
  note              TEXT,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_invoices_period_uniq ON academy_invoices (tenant_id, kind, period_key);
CREATE INDEX IF NOT EXISTS academy_invoices_manual_idx ON academy_invoices (manual_invoice_id);

-- academy_alerts: which academy alert has gone out, so the daily job sends each
-- one once (a trial ending per trial, a renewal per renewal date, and so on).
CREATE TABLE IF NOT EXISTS academy_alerts (
  tenant_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  period_key TEXT NOT NULL,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, kind, period_key)
);
