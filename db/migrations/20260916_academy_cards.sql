-- Squideo Academy by card (api/_lib/crm/academyCards.js).
--
-- Self-healed by ensureAcademyTables() in api/_lib/crm/academyTables.js, so
-- this file is the record rather than a step that must be run by hand.
--
-- academy_subscriptions: an academy paying for Starter or Team by card, one
-- Stripe subscription each. Amounts are what Stripe takes, in pounds, VAT
-- included. activated_at is set once the academy has been put on its plan, so
-- a webhook sent twice does it once, and the daily job can finish a paid
-- checkout whose academy never got its plan.
CREATE TABLE IF NOT EXISTS academy_subscriptions (
  tenant_id              TEXT PRIMARY KEY,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  plan                   TEXT,
  plan_name              TEXT,
  billing_period         TEXT,
  status                 TEXT,          -- active | trialing | past_due | incomplete | cancelling | cancelled
  amount_gross           NUMERIC,
  current_period_end     TIMESTAMPTZ,
  cancel_at              TIMESTAMPTZ,
  email                  TEXT,
  activated_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_subscriptions_sub_uniq ON academy_subscriptions (stripe_subscription_id);

-- academy_card_payments: every payment Stripe took for an academy, claimed
-- once per Stripe invoice, and the CRM/Xero invoice it was mirrored as (NULL
-- with mirror_error set until it is managed). mirror_started_at is a ten-minute
-- lease, so the webhook, the checkout and the daily job never mirror the same
-- payment twice. claim_id is the academy_invoices row an extras charge claimed.
CREATE TABLE IF NOT EXISTS academy_card_payments (
  stripe_invoice_id TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  kind              TEXT NOT NULL,       -- plan | extras
  amount_gross      NUMERIC NOT NULL,
  label             TEXT,
  claim_id          TEXT,
  manual_invoice_id TEXT,
  mirror_error      TEXT,
  mirror_started_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
