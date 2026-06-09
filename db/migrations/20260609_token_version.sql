-- Session-token revocation. Each session JWT carries a `tv` claim equal to the
-- user's token_version at issue time; api/_lib/middleware.js (requireAuth)
-- rejects any token whose tv no longer matches. Bumping token_version
-- (password change, 2FA reset, "sign out everywhere") invalidates every
-- previously issued session for that user.
--
-- The app self-heals this column (api/_lib/sessions.js), so this file just
-- documents the schema and lets a fresh DB skip the first-call ALTER.

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;
