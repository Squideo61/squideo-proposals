-- "Director" role: full visibility into business finance + every-day CRM
-- operations, but barred from workspace admin (users / roles / settings).
--
-- The matching server-side gate change: every endpoint that previously sat on
-- 'settings.manage' for finance reasons (api/_lib/crm/stats.js,
-- api/blob-usage.js, api/neon-usage.js) now requires the new 'finance.manage'
-- permission. Admin's '*' wildcard covers it automatically. 'member' (PM/Sales)
-- and 'producer' remain unaffected.
--
-- Idempotent via ON CONFLICT.

INSERT INTO roles (id, name, permissions, notification_defaults, is_system) VALUES
  (
    'director',
    'Director',
    '[
      "finance.manage",
      "proposals.manage_all",
      "signatures.manage_all",
      "templates.manage",
      "payments.manage",
      "deals.manage_all",
      "contacts.manage_all",
      "companies.manage_all",
      "tasks.manage_all",
      "comments.manage_all",
      "invoices.manage",
      "quote_requests.manage",
      "partner_credits.manage",
      "revisions.access",
      "production.access"
    ]'::jsonb,
    '{
      "proposal.signed":               true,
      "proposal.first_view":           true,
      "payment.received":              true,
      "payment.partner_credit":        true,
      "invoice.paid_manual":           true,
      "invoice.paid_xero":             true,
      "task.reminder":                 true,
      "quote_request.new":             true,
      "quote_request.partial":         true,
      "revision.feedback_submitted":   true,
      "storyboard.feedback_submitted": true,
      "revision.draft_completed":      true,
      "storyboard.draft_completed":    true
    }'::jsonb,
    true
  )
ON CONFLICT (id) DO NOTHING;
