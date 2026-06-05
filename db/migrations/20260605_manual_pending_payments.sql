-- Manual pending payments imported from the Live Sales Sheet "PP's" tab:
-- outstanding work that sits outside the CRM's own signed deals. Shown as its
-- own "Imported (Live Sales Sheet)" group in Finance → Pending Payments (kept
-- separate so it never double-counts the CRM-computed figures). Self-healed and
-- seeded by ensureManualPendingPayments() in api/_lib/crm/stats.js — running
-- this by hand is optional.

CREATE TABLE IF NOT EXISTS manual_pending_payments (
  id             TEXT PRIMARY KEY,
  company        TEXT,
  invoice_type   TEXT,
  description    TEXT,
  amount_ex_vat  NUMERIC NOT NULL DEFAULT 0,
  vat            NUMERIC NOT NULL DEFAULT 0,
  payment_method TEXT,
  note           TEXT,
  sort_order     INT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
