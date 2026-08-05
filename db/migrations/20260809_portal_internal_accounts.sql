-- Mark portal accounts that belong to us, not to clients.
--
-- Testing the portal means signing up to it, and every one of those signups
-- landed in Marketing → Portal as a course lead. Three test accounts against a
-- real month's traffic is the difference between a number you can act on and
-- one you quietly stop trusting.
--
-- Two mechanisms, because one isn't enough:
--
--   internal = TRUE     — an explicit flag, for personal addresses used to test
--                         (nobody could infer these from the address).
--   @squideo.co.uk /    — a domain rule applied at query time, so the next
--   @squideo.com          person who tests with their work address is excluded
--                         without anyone remembering to run SQL.
--
-- The flag is NOT the same as disabling the account: these are live, working
-- logins that we want to keep using. It only says "don't count this as a lead".

ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS internal BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS portal_users_internal_idx
  ON portal_users (internal) WHERE internal;

-- The known test accounts. Staff @squideo addresses need no row here — the
-- domain rule catches them.
UPDATE portal_users
   SET internal = TRUE
 WHERE LOWER(email) IN (
   'shelton61@icloud.com',
   'divisionspares@gmail.com'
 );
