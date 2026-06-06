-- Production/Project Managers should be notified about money coming in:
-- proposal/Stripe payments, Partner Programme charges, and invoices marked paid
-- (manual or via the Xero sync). Admins already default these ON (see 20260515
-- seed); this turns the same four keys ON for the "Project Manager/Sales" role
-- (id 'member' — the management role the team calls production managers).
--
-- Targeted by stable id rather than name (the display name is "Project
-- Manager/Sales"). Idempotent: re-running just re-asserts the four keys.
-- Per-user overrides in user_notification_overrides still win. NOTE: role-
-- default seeds do NOT self-heal at runtime — apply this to Neon by hand.
UPDATE roles
   SET notification_defaults = notification_defaults
         || '{
              "payment.received":       true,
              "payment.partner_credit": true,
              "invoice.paid_manual":    true,
              "invoice.paid_xero":      true
            }'::jsonb,
       updated_at = NOW()
 WHERE id = 'member';
