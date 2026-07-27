-- Kick-off call: a client "project task" that reuses the intro-call booking
-- engine (team free/busy + working hours → Google Meet). Two additions to the
-- existing intro-call tables:
--
--   intro_call_links.kind ('intro' | 'kickoff') distinguishes the sales intro
--   call from a project kick-off. proposed_starts_at (optional) is a specific
--   time the production manager has already agreed with the client — the portal
--   then offers "confirm this time" instead of the full availability picker.
--   NULL proposed_starts_at = the client picks a slot from live team availability.
--
--   intro_call_bookings.kind mirrors it so a booked kick-off is distinguishable.
--
-- Apply in the Neon console. Self-healed by ensureIntroCallTables() in
-- api/_lib/crm/introCallSlots.js, so this is idempotent and safe to run late.

ALTER TABLE intro_call_links    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'intro';
ALTER TABLE intro_call_links    ADD COLUMN IF NOT EXISTS proposed_starts_at TIMESTAMPTZ;
ALTER TABLE intro_call_bookings ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'intro';
