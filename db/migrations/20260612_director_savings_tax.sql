-- Directors tab (Finance → Performance → Directors): two new sections below the
-- per-director expense cards.
--   1. Savings & balances  — named bank accounts, each with earmarked "pots"
--      (Corp Tax saved from Q4, VAT from prev quarter, etc.) plus the account's
--      actual cleared balance for reconciliation.
--   2. Tax pay dates       — upcoming Personal / VAT / Corporation Tax payments
--      with due date, amount and HMRC transfer reference, driving automatic
--      reminders to both directors (see cron director-tax-reminders).
-- Idempotent; mirrors the 20260611_director_expenses.sql conventions. The
-- ensureDirectorFinance() self-heal in stats.js re-runs these at request time.

CREATE TABLE IF NOT EXISTS director_savings_accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  balance     NUMERIC(12,2) NOT NULL DEFAULT 0,   -- actual cleared balance (for reconciliation)
  sort_order  INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS director_savings_pots (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES director_savings_accounts(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  note        TEXT,
  sort_order  INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_savings_pots_account ON director_savings_pots (account_id);

CREATE TABLE IF NOT EXISTS director_tax_payments (
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL,            -- e.g. '2026 Q1 VAT', 'Personal Tax — Ben'
  kind                  TEXT,                     -- 'vat' | 'corp_tax' | 'personal_tax' | 'other' (badge/colour)
  due_date              DATE NOT NULL,
  amount                NUMERIC(12,2) NOT NULL DEFAULT 0,
  reference             TEXT,                     -- HMRC transfer reference
  note                  TEXT,
  reminded_transfer1_at TIMESTAMPTZ,              -- 7-days-before reminder sent (Shawbrook → current acct)
  reminded_transfer2_at TIMESTAMPTZ,              -- 6-days-before reminder sent (current acct → HMRC)
  sort_order            INT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tax_payments_due ON director_tax_payments (due_date);
