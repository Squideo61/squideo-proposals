-- Progress notes for predicted payments (the Finance "Predicted <month>
-- Payments" tab). Keyed by the item's stable key (deal:<id> / manual:<id> /
-- partner:<key> / other:<id>) and NOT by month, so a "how this deal/project is
-- progressing" note carries across months and covers auto-included partners /
-- other recurring items. Applied automatically at runtime via
-- ensurePredictedPaymentNotes() in api/_lib/crm/stats.js — this file is for
-- record-keeping / manual application only.

CREATE TABLE IF NOT EXISTS predicted_payment_notes (
  item_key   text PRIMARY KEY,
  note       text,
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
