-- Which credit pool a reservation draws on.
--
-- A company can hold several separate credit balances at once: Newcastle
-- University has one for the NHS Establish Study and another for NHS Rivival,
-- each its own partner_subscriptions client_key with its own issued/used. Adding
-- them together and showing one "credit remaining" is misleading — a producer on
-- the Rivival job would see Establish's unspent minutes as if they were theirs.
--
-- So a reservation names its pool. NULL means "made before this column existed"
-- and is still counted against the company total, just not against any one pool.
ALTER TABLE video_credit_allocations ADD COLUMN IF NOT EXISTS client_key TEXT;
CREATE INDEX IF NOT EXISTS video_credit_allocations_client_key_idx
  ON video_credit_allocations(client_key, status);
