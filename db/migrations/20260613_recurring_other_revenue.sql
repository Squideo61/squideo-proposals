-- "Other" recurring revenue shown in Finance → Pending Payments (and auto-included
-- in Predicted, since it recurs every month). Small ongoing monthly income that
-- sits outside CRM deals and the Partner Programme — e.g. web hosting. Each row is
-- a flat monthly net + VAT, like a Partner subscription line. Self-healed and
-- seeded by ensureRecurringOther() in api/_lib/crm/stats.js — running this by hand
-- is optional.

CREATE TABLE IF NOT EXISTS recurring_other_revenue (
  id             TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  note           TEXT,
  amount_ex_vat  NUMERIC NOT NULL DEFAULT 0,
  vat            NUMERIC NOT NULL DEFAULT 0,
  sort_order     INT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
