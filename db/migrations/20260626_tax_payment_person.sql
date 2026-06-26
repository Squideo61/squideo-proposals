-- Tax pay dates (Finance → Performance → Directors): group payments by the
-- person responsible and remember each director's constant personal-tax
-- reference so it's pre-filled rather than re-typed every time.
--   • director_tax_payments.person — 'adam' | 'ben' | 'company' (grouping).
--     Existing rows are back-filled from the title text.
--   • director_tax_refs           — the saved HMRC reference per director,
--     kept in step with whatever was last entered on a Personal Tax payment.
-- Idempotent; the ensureDirectorFinance() self-heal in stats.js re-runs these.

ALTER TABLE director_tax_payments ADD COLUMN IF NOT EXISTS person TEXT;

UPDATE director_tax_payments
   SET person = CASE
                  WHEN title ILIKE '%adam%' THEN 'adam'
                  WHEN title ILIKE '%ben%'  THEN 'ben'
                  ELSE 'company'
                END
 WHERE person IS NULL;

CREATE TABLE IF NOT EXISTS director_tax_refs (
  person      TEXT PRIMARY KEY,          -- 'adam' | 'ben'
  reference   TEXT,                      -- their constant HMRC personal-tax reference
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
