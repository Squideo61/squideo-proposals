-- A client organisation's own logo, held once on the company rather than being
-- re-uploaded per proposal.
--
-- Until now the only place a customer's brand mark existed was
-- proposals.data->>'clientLogo' (a base64 data URL set by the builder's
-- LogoUploader), and the portal dug the newest one out of their proposals. A
-- company logo now takes precedence everywhere and pre-fills new proposals, so
-- it's uploaded once and follows the client.
--
-- Stored as a data URL, the same representation proposals already use, so
-- decodeLogo()/api/portal-logo serve it unchanged. NULL (never '') means "no
-- logo" — the has_logo checks test IS NOT NULL so Postgres never has to
-- detoast the value.
--
-- Idempotent. Also self-healed at runtime by ensureCompanyLogoColumns()
-- (api/_lib/portal/logo.js), so a manual Neon apply is optional.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo            TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_updated_by TEXT;
