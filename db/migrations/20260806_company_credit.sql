-- Per-company control over the video-credit rate card.
--
-- Until now visibility was one blunt rule: prospects don't see it, everyone
-- else does. That's right by default — credit is the rung after a first
-- project, so a style exists to repeat — but it's wrong at both edges:
--
--   · Some clients (NHS framework buyers especially) need to see their credit
--     from day one, before anything is signed.
--   · Some clients we'd rather quote per project than hand a rate card to.
--
-- So the default rule stays, and these two columns are the override.
--
-- Self-healed at runtime by ensureCompanyCreditColumns() in
-- api/_lib/crm/companyCredit.js.

-- TRI-STATE, and the NULL matters:
--   NULL  → fall back to the default rule (visible unless the org is a prospect)
--   TRUE  → always visible, even for a prospect
--   FALSE → hidden, even for an established client
-- A two-state boolean would have forced a default onto every existing company
-- at migration time and thrown away the distinction between "nobody has
-- decided" and "somebody decided no".
ALTER TABLE companies ADD COLUMN IF NOT EXISTS credit_enabled BOOLEAN;

-- Per-company £/min, overriding settings.default_proposal.partnerProgramme
-- .standardRatePerMin. NULL means "use whatever the resolver works out" —
-- their last proposal's rate, else the workspace default. Stored ex VAT, like
-- every other rate in the product.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS credit_rate_per_min NUMERIC;

-- Who turned it on and when. This decides pricing a client can see, so it
-- shouldn't be an anonymous change.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS credit_enabled_by TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS credit_enabled_at TIMESTAMPTZ;

-- The portal reads this per session; the partial index keeps the override
-- lookup off a full scan once there are a few hundred prospect companies.
CREATE INDEX IF NOT EXISTS companies_credit_enabled_idx
  ON companies (credit_enabled) WHERE credit_enabled IS NOT NULL;
