-- Durable paid-date for extras, so Staff Commission can bucket a paid extra into
-- the month its cash actually landed (deal_extras only had created_at/updated_at,
-- and updated_at is rewritten by any later edit).
--
-- Self-healed at runtime (ensureDealExtrasTable in api/_lib/crm/extras.js) and
-- back-filled from updated_at for extras already marked paid. Idempotent.

ALTER TABLE deal_extras ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

-- Best-effort back-fill: existing 'paid' extras get their last-touched time as the
-- paid date (the moment status flipped to 'paid' set updated_at = NOW()).
UPDATE deal_extras SET paid_at = updated_at WHERE status = 'paid' AND paid_at IS NULL;
