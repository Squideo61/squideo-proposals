-- Sales taken off the commission plan by hand (Directors + Admin).
--
-- Self-healed at runtime by ensureCommission() in api/_lib/crm/commission.js —
-- this file is the record of it.
--
-- Keyed on the SALE, not on a month:
--   '<dealId>:deposit'          — a normal deal's first payment
--   '<dealId>:po_paid'          — a PO deal's first payment
--   '<dealId>:extra:<extraId>'  — an extra recognised on its own
-- Recognition events are computed live, so a sale can re-date into another month
-- (a PO paid later than it was signed, say). Keying on the sale means the
-- decision follows it rather than being stranded in the month it was made in.
--
-- `reason` is NOT NULL on purpose: this is money someone was expecting, and the
-- question that gets asked later is always "why?".

CREATE TABLE IF NOT EXISTS commission_disqualifications (
  event_key       TEXT PRIMARY KEY,
  deal_id         TEXT,
  owner_email     TEXT,
  reason          TEXT NOT NULL,
  disqualified_by TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
