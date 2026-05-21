-- Reusable email templates for the CRM composer. The templatesRoute handler
-- (api/_lib/crm/templates.js) already reads/writes this table; it just never
-- had a migration. body_html holds the rich-text body, body_text the plain
-- fallback, stage an optional pipeline-stage pin (NULL = always shown).
CREATE TABLE IF NOT EXISTS crm_email_templates (
  id         TEXT        PRIMARY KEY,
  name       TEXT        NOT NULL,
  subject    TEXT,
  body_html  TEXT,
  body_text  TEXT,
  stage      TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS crm_email_templates_name_idx ON crm_email_templates (name);
