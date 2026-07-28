-- Video Credit orders: the finance lifecycle of a portal credit purchase so it
-- shows up in finance (Pending Payments + "cash generated" sales), not just as a
-- balance bump. Self-healed by ensureVideoCreditOrders() in api/_lib/videoCredit.js.
--
--   requested  — client asked to buy credit by invoice (awaiting staff)
--   invoiced   — staff raised the standalone company Xero invoice (manual_invoice_id);
--                it now sits on Pending Payments and counts as a sale
--   paid       — the invoice settled → the minutes were auto-credited to the ledger
--   cancelled  — a requested order dismissed before invoicing
-- Card purchases are recorded straight as status='paid', payment_route='card'.

CREATE TABLE IF NOT EXISTS video_credit_orders (
  id                TEXT        PRIMARY KEY,
  company_id        TEXT        NOT NULL,
  minutes           INTEGER     NOT NULL,
  rate_per_min      NUMERIC     NOT NULL,
  subtotal_ex_vat   NUMERIC     NOT NULL,
  vat               NUMERIC     NOT NULL,
  total_inc_vat     NUMERIC     NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'requested',
  payment_route     TEXT        NOT NULL DEFAULT 'invoice',
  manual_invoice_id TEXT,
  requested_by      TEXT,
  credited_at       TIMESTAMPTZ,
  source_ref        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS video_credit_orders_company_idx ON video_credit_orders(company_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS video_credit_orders_source_ref_idx ON video_credit_orders(source_ref) WHERE source_ref IS NOT NULL;
