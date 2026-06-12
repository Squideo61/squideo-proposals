-- One-off data import for the Directors tab: Adam's savings/balances + tax pay
-- dates from the spreadsheet. Run once in the Neon SQL editor. Idempotent
-- (fixed ids + ON CONFLICT DO NOTHING) so re-running is harmless, and it
-- self-heals the tables so it works even if 20260612_director_savings_tax.sql
-- hasn't been applied yet. NOT a migration — keep it out of db/migrations/.

CREATE TABLE IF NOT EXISTS director_savings_accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  sort_order INT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS director_savings_pots (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES director_savings_accounts(id) ON DELETE CASCADE,
  label TEXT NOT NULL, amount NUMERIC(12,2) NOT NULL DEFAULT 0, note TEXT, sort_order INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_savings_pots_account ON director_savings_pots (account_id);
CREATE TABLE IF NOT EXISTS director_tax_payments (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT, due_date DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0, reference TEXT, note TEXT,
  reminded_transfer1_at TIMESTAMPTZ, reminded_transfer2_at TIMESTAMPTZ, sort_order INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_tax_payments_due ON director_tax_payments (due_date);

-- Shawbrook Savings Account — balance is "Total In Account (less interest)".
INSERT INTO director_savings_accounts (id, name, balance, sort_order) VALUES
  ('sav_shawbrook', 'Shawbrook Savings Account', 63901.50, 0)
ON CONFLICT (id) DO NOTHING;

-- Earmarked pots (the five funded pots sum to exactly the £63,901.50 balance).
INSERT INTO director_savings_pots (id, account_id, label, amount, note, sort_order) VALUES
  ('pot_shaw_corptax_q4',   'sav_shawbrook', 'Corp Tax — Saved from Q4',          0.00,     'Withdrawn to pay DD from main account', 0),
  ('pot_shaw_vat_prev',     'sav_shawbrook', 'VAT — Saved from Previous Quarter',  15839.89, NULL, 1),
  ('pot_shaw_corptax_cur',  'sav_shawbrook', 'Corp Tax — Current period',          22223.00, NULL, 2),
  ('pot_shaw_personal_div', 'sav_shawbrook', 'Personal + Dividend Tax',            12037.50, NULL, 3),
  ('pot_shaw_vat_q1',       'sav_shawbrook', 'VAT — Q1 Current Period',            12227.00, NULL, 4),
  ('pot_shaw_regular',      'sav_shawbrook', 'Regular Savings',                    1574.11,  NULL, 5)
ON CONFLICT (id) DO NOTHING;

-- Tax pay dates — only the rows fully specified on the sheet (a due date is
-- required). 2026 Q1 VAT (£16,726.12) and 2026 Annual Corp Tax still need dates.
INSERT INTO director_tax_payments (id, title, kind, due_date, amount, reference, sort_order) VALUES
  ('tax_personal_ben',  'Personal Tax — Ben',  'personal_tax', DATE '2026-07-31', 1708.00, '2369277707K', 0),
  ('tax_personal_adam', 'Personal Tax — Adam', 'personal_tax', DATE '2026-07-31', 1652.00, '4100478044K', 1)
ON CONFLICT (id) DO NOTHING;
