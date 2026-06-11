-- Self-view suppression for email open tracking.
--
-- When a team member opens one of their own tracked sent threads in Gmail,
-- Gmail's image proxy fetches the open pixel server-side — indistinguishable
-- from the recipient opening it (no session cookie, generic US proxy IP). The
-- browser extension, which runs inside Gmail and knows it's them, pings
-- /api/crm/tracking/self-view on thread open; the track/open endpoint then
-- ignores an open that lands within a short window of that view.
--
-- One row per tracked thread (latest view wins). The app self-heals this table
-- at runtime via ensureSelfViewTable(); this migration records it for the schema.
CREATE TABLE IF NOT EXISTS email_self_views (
  gmail_thread_id TEXT PRIMARY KEY,
  viewed_at       TIMESTAMPTZ NOT NULL,
  viewed_by       TEXT
);
