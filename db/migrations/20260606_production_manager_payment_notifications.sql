-- Production Managers should be notified about money coming in: proposal/Stripe
-- payments, Partner Programme charges, and invoices marked paid (manual or via
-- the Xero sync). Admins already default these ON (see 20260515 seed); this
-- turns the same four keys ON for the custom "Production Manager" role.
--
-- Matched by name (case-insensitive) because custom roles have generated ids.
-- Idempotent: re-running just re-asserts the four keys. Per-user overrides in
-- user_notification_overrides still win. NOTE: role-default seeds do NOT
-- self-heal at runtime — this migration must be applied to Neon by hand.
UPDATE roles
   SET notification_defaults = notification_defaults
         || '{
              "payment.received":       true,
              "payment.partner_credit": true,
              "invoice.paid_manual":    true,
              "invoice.paid_xero":      true
            }'::jsonb,
       updated_at = NOW()
 WHERE name ILIKE 'Production Manager';
