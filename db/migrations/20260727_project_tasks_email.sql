-- Editable body for the production manager's "here are your project tasks"
-- portal email. { subject, bodyHtml } JSON on the singleton settings row. The
-- live, per-client portal sign-up/login button is appended at send time (the
-- stored body is the wording only). NULL until an admin first saves one — the
-- send route (api/crm/portal-admin.js op=email-project-tasks) falls back to a
-- hardcoded default.
--
-- Apply in the Neon console. Self-healed by ensureFinanceTargetsColumn() in
-- api/settings.js. Idempotent and safe to run late.

ALTER TABLE settings ADD COLUMN IF NOT EXISTS project_tasks_email JSONB;
