-- Ad-hoc "extra" charges added to a deal/project during production (e.g. an
-- extra video, human VO, additional revisions). They sit on top of the signed
-- proposal total and surface as their own line in Pending Payments, under the
-- same deal/project number. Amounts are stored ex-VAT (net).
--
-- status: 'pending'  — recorded, not yet invoiced (collect later)
--         'invoiced' — a Xero invoice has been raised (awaiting payment)
--         'paid'     — settled
CREATE TABLE IF NOT EXISTS deal_extras (
  id              TEXT        PRIMARY KEY,
  deal_id         TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  description     TEXT        NOT NULL,
  amount          NUMERIC     NOT NULL,          -- ex-VAT (net)
  vat_rate        NUMERIC,                       -- fraction (e.g. 0.2); null = inherit deal
  status          TEXT        NOT NULL DEFAULT 'pending',
  xero_invoice_id TEXT,                          -- set when raised via Xero (stage 2)
  invoice_number  TEXT,
  created_by      TEXT        REFERENCES users(email) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS deal_extras_deal_idx ON deal_extras(deal_id);
