-- The Monthly Plan proposal type.
--
-- A client commits to a monthly spend from the start, with no project purchase
-- up front. Almost all of it needs no schema at all: the plan is a recurring
-- content-credit commitment, which partner_subscriptions already models, and
-- the credit ledger is issued minus used — so producing content in ADVANCE of
-- the payments that cover it is simply a balance that starts negative and is
-- brought back to zero month by month. No new table, no new concept.
--
-- What the ledger cannot express is the AGREEMENT behind that negative balance,
-- and those are exactly the two numbers somebody needs when they are deciding
-- whether to start work:
--
--   front_load_minutes — how far ahead we said we would produce. Without it a
--     producer looking at a negative balance cannot tell an agreed advance from
--     an overspend, and the honest reading of a negative number is the alarming
--     one.
--   min_term_months — how long the client is committed for. Producing in
--     advance is only safe while they cannot leave before it is paid off, so a
--     term is required whenever there is an advance.
--
-- Both are recorded from the proposal AS SIGNED rather than re-read later: the
-- proposal can be edited afterwards, and what was agreed cannot.

ALTER TABLE partner_subscriptions
  ADD COLUMN IF NOT EXISTS front_load_minutes NUMERIC;

ALTER TABLE partner_subscriptions
  ADD COLUMN IF NOT EXISTS min_term_months INTEGER;

-- Which subscriptions are carrying an advance that is not yet paid off. Small
-- table, so this is for the query's clarity as much as its speed.
CREATE INDEX IF NOT EXISTS partner_subscriptions_front_load_idx
  ON partner_subscriptions (status)
  WHERE front_load_minutes IS NOT NULL AND front_load_minutes > 0;
