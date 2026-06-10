-- Predicted-this-month payments — the curated shortlist behind the Finance
-- "Predicted <month> Payments" tab. Each row is one pending payment (identified
-- by an opaque client-computed key, e.g. deal:<id> / manual:<id> / partner:<key>)
-- the user expects to land in a given calendar month. Applied automatically at
-- runtime via ensurePredictedPayments() in api/_lib/crm/stats.js — this file is
-- for record-keeping / manual application only.

CREATE TABLE IF NOT EXISTS predicted_payments (
  item_key      text NOT NULL,
  month         text NOT NULL,          -- 'YYYY-MM'
  label         text,                   -- snapshot of the row's name (record-keeping)
  amount_ex_vat numeric DEFAULT 0,      -- snapshot of the net amount when flagged
  created_by    text,
  created_at    timestamptz DEFAULT now(),
  PRIMARY KEY (item_key, month)
);
