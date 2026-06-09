-- Notify the team when a client takes the "email me an invoice" route on a
-- signed proposal, at two moments:
--   1. invoice.client_requested — they CLICK "Send me an invoice instead"
--      (intent; may not finish). Deduped per proposal via invoice_route_intents.
--   2. invoice.issued — the invoice is actually issued from Xero (completion).
--
-- Previously the click was never recorded server-side at all, and the issue
-- step emailed all users directly without an in-app bell entry.

-- One row per proposal whose client chose the invoice route. notified_at lets
-- the intent endpoint fire the "client_requested" alert exactly once.
CREATE TABLE IF NOT EXISTS invoice_route_intents (
  proposal_id  TEXT        PRIMARY KEY,
  chosen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at  TIMESTAMPTZ
);

-- Seed the two new notification keys into existing role defaults. The prefs
-- resolver treats a missing key as OFF, so without this nobody would receive
-- the new alerts. jsonb merge (||) adds the keys without disturbing the rest.
-- Sales/finance roles get them on by default; producers do not.
UPDATE roles
   SET notification_defaults = notification_defaults
       || '{"invoice.client_requested": true, "invoice.issued": true}'::jsonb
 WHERE id IN ('admin', 'director', 'member');

UPDATE roles
   SET notification_defaults = notification_defaults
       || '{"invoice.client_requested": false, "invoice.issued": false}'::jsonb
 WHERE id NOT IN ('admin', 'director', 'member');
