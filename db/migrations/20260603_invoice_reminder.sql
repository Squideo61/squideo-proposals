-- "Invoice needs generating" reminder: when a proposal has been signed for over
-- an hour with no invoice raised and no payment, nudge the deal owner once.
--
-- 1) Track that we've nudged, so the hourly cron doesn't repeat.
ALTER TABLE signatures ADD COLUMN IF NOT EXISTS invoice_reminder_sent_at TIMESTAMPTZ;

-- 2) Seed role defaults for the new owner-audience notification. The deal owner
-- can be any role, so default it ON everywhere (per-user overrides still win).
UPDATE roles
   SET notification_defaults = jsonb_set(notification_defaults, '{invoice.needs_generating}', 'true', true),
       updated_at = NOW()
 WHERE NOT (notification_defaults ? 'invoice.needs_generating');
