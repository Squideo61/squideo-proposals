-- Imported Live Sales Sheet history: a per-month override of cash-in ("Sales")
-- and new money owed ("PP's"), for months that predate the CRM go-live. The
-- Finance trend charts splice these over computed CRM figures where present.
-- Self-healed by ensureSalesPpsHistory() in api/_lib/crm/stats.js — running this
-- by hand is optional.

CREATE TABLE IF NOT EXISTS sales_pps_history (
  month      TEXT PRIMARY KEY,                  -- 'YYYY-MM'
  sales      NUMERIC NOT NULL DEFAULT 0,        -- cash in that month (net £)
  pps        NUMERIC NOT NULL DEFAULT 0,        -- new money owed created (net £)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
