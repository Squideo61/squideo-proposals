-- "Marketing data starts from" cutoff. Leads (quote_requests) before this date —
-- captured during the early tracking rollout with incomplete first-touch
-- attribution — are excluded from the lead-based Marketing reports so they don't
-- skew channel / CPL / ROAS. Configurable in the Marketing UI ("Leads from").
-- Applied automatically at runtime via ensureMarketingCutoff() in
-- api/_lib/crm/analytics.js — this file is for record-keeping / manual apply.

ALTER TABLE settings ADD COLUMN IF NOT EXISTS marketing_leads_from DATE;

-- One-time default: 2026-06-13 is the first day with complete attribution.
UPDATE settings SET marketing_leads_from = '2026-06-13' WHERE id = 1 AND marketing_leads_from IS NULL;
