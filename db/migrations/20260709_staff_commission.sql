-- Staff Commission — automatic sales commission for on-plan staff.
--
-- Commission is calculated from real cash received (cash basis, ex-VAT),
-- per member, per month, resetting to £0 at the start of each month. Two bands:
--   Band A: band_a_rate on sales up to band_a_cap  (default 5% up to £5,000 = max £250)
--   Band B: band_b_rate on everything above the cap (default 2%, uncapped)
--
-- The app self-heals this schema at runtime (ensureCommission in
-- api/_lib/crm/commission.js), so applying this migration by hand is optional
-- and fully idempotent.

-- Single-row, admin-editable band config (id is pinned to 1). Rates are stored
-- as fractions (0.05 = 5%); band_a_cap is the net-£ threshold for Band A.
CREATE TABLE IF NOT EXISTS commission_config (
  id          INT PRIMARY KEY DEFAULT 1,
  band_a_rate NUMERIC NOT NULL DEFAULT 0.05,
  band_a_cap  NUMERIC NOT NULL DEFAULT 5000,
  band_b_rate NUMERIC NOT NULL DEFAULT 0.02,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT
);
INSERT INTO commission_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Who is on the plan. effective_from ('YYYY-MM') is the first month commission
-- accrues — set to the enrolment month so history before they joined stays £0.
CREATE TABLE IF NOT EXISTS commission_members (
  email          TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
