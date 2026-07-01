-- Received payments for recurring "Other" revenue lines. Marking a recurring line
-- (e.g. Generis or another GoCardless subscription) as received for a month logs a
-- row here — which then counts as actual banked income for that month (the Income
-- ledger + NET REVENUE read it via fetchPaidRows / incomeReport), while the
-- recurring_other_revenue row stays the ongoing monthly template. net/vat are
-- snapshotted at mark-time so editing the template later doesn't rewrite history.
-- One payment per (line, month). Self-healed by ensureRecurringOtherPayments() in
-- api/_lib/crm/stats.js — running this by hand is optional.

CREATE TABLE IF NOT EXISTS recurring_other_payments (
  id            TEXT PRIMARY KEY,
  recurring_id  TEXT NOT NULL,
  month         TEXT NOT NULL,        -- 'YYYY-MM' the payment is for
  net           NUMERIC NOT NULL DEFAULT 0,
  vat           NUMERIC NOT NULL DEFAULT 0,
  paid_at       TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS recurring_other_payments_uniq
  ON recurring_other_payments (recurring_id, month);
