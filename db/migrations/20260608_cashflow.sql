-- Cash Flow (Business → Finance → Performance → "Cash Flow" tab). Admin-only.
-- Company costs (recurring overheads + one-off entries) used to compute each
-- month's profit (cash received net − costs), Corporation Tax to set aside
-- (HMRC marginal relief on the trailing 12-month profit) and a suggested
-- monthly revenue target. Plus a dedicated activity feed for cost changes.
--
-- The app self-heals these (ensureCashflow in api/_lib/crm/stats.js), so this
-- file documents the schema and lets a fresh DB skip the first-call ALTERs.

CREATE TABLE IF NOT EXISTS cashflow_costs (
  id             TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'expense',   -- 'wages' | 'expense'
  amount         NUMERIC NOT NULL DEFAULT 0,        -- monthly amount (money out)
  recurring      BOOLEAN NOT NULL DEFAULT true,
  month          TEXT,                              -- 'YYYY-MM' for one-offs (NULL when recurring)
  effective_from TEXT,                              -- recurring: first month it applies (NULL = open start)
  effective_to   TEXT,                              -- recurring: last month it applies (NULL = ongoing)
  sort_order     INT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cashflow_activity (
  id          BIGSERIAL PRIMARY KEY,
  actor_email TEXT,
  action      TEXT NOT NULL,        -- 'cost.add' | 'cost.update' | 'cost.delete' | 'goal.update'
  summary     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Desired monthly profit, drives the suggested revenue target.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS cashflow_profit_goal NUMERIC;
