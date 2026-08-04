-- The fillable video brief.
--
-- Replaces the "download a Word template" lead magnet. A template produces a
-- document the client has to fill in alone, off our site, with no prompts — and
-- most never come back. This is the same questions as a resumable web form that
-- autosaves every field, so a half-finished brief is still a warm lead we can
-- see, and a finished one arrives as a real document the team can respond to.
--
-- Self-healed at runtime by ensureClientBriefs() in api/_lib/brief/db.js.

CREATE TABLE IF NOT EXISTS client_briefs (
  id               TEXT        PRIMARY KEY,
  portal_user_id   TEXT        NOT NULL,
  company_id       TEXT,
  -- Set when the brief is attached to real work, so a client can brief a second
  -- video later without overwriting the first.
  deal_id          TEXT,
  -- One JSONB blob rather than 30 columns: the question set will change, and a
  -- brief written against last year's questions must still render. Keys are the
  -- stable `key` fields in api/_lib/brief/questions.js.
  answers          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- completed_at = they reached the end. submitted_at = they pressed send.
  -- Someone can finish and sit on it, and that's a different sales signal.
  completed_at     TIMESTAMPTZ,
  submitted_at     TIMESTAMPTZ,
  quote_request_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most ONE open draft per person, which is what makes "load or create" on
-- GET deterministic — no ordering guesswork about which draft they meant.
-- Submitted briefs are unconstrained so they can write another.
CREATE UNIQUE INDEX IF NOT EXISTS client_briefs_open_idx
  ON client_briefs (portal_user_id)
  WHERE submitted_at IS NULL;

CREATE INDEX IF NOT EXISTS client_briefs_company_idx ON client_briefs (company_id);

-- Lets the CRM show "started a brief" as a heat signal without a table scan.
CREATE INDEX IF NOT EXISTS client_briefs_updated_idx ON client_briefs (updated_at DESC);
