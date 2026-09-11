// The CRM's academy tables, in one self-heal: the Academies page, orders from
// proposals, and paying by card all use them. Its own module so that the
// academy modules can share it without importing each other.
//
// Mirrored in db/migrations/20260915_academy_billing.sql and
// 20260916_academy_cards.sql, which are the record rather than a step to run.

import sql from '../db.js';

// academy_invoices: what has been billed for which academy period, one row per
// line, so a period can never be invoiced twice (the unique index) and each row
// knows the CRM invoice it went on. A row with no invoice is either a period
// marked as billed some other way (source 'elsewhere') or a claim taken just
// before Xero was asked (source 'invoice'), which the unmark action can clear if
// the request died in between. academy_alerts: which alert has gone out, once.
// academy_settings: per academy, whether its invoices raise themselves.
// academy_orders: an academy sold on a proposal, waiting for (or applied to) the
// academy it is for; a set-up fee on it is billed once it is applied.
// academy_subscriptions: an academy paying by card, one Stripe subscription
// each (./academyCards.js). academy_card_payments: every payment Stripe took,
// and the Xero invoice it was mirrored as, so a webhook sent twice records once.
//
// Never rejects: a self-heal that throws once took the whole CRM down with it.
let tablesReady = null;
export function ensureAcademyTables() {
  if (tablesReady) return tablesReady;
  tablesReady = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS academy_invoices (
        id                TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        company_id        TEXT,
        kind              TEXT NOT NULL,
        period_key        TEXT NOT NULL,
        label             TEXT,
        amount_ex_vat     NUMERIC NOT NULL DEFAULT 0,
        manual_invoice_id TEXT,
        source            TEXT NOT NULL DEFAULT 'invoice',
        note              TEXT,
        created_by        TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS academy_invoices_period_uniq ON academy_invoices (tenant_id, kind, period_key)`;
    await sql`CREATE INDEX IF NOT EXISTS academy_invoices_manual_idx ON academy_invoices (manual_invoice_id)`;
    await sql`
      CREATE TABLE IF NOT EXISTS academy_alerts (
        tenant_id  TEXT NOT NULL,
        kind       TEXT NOT NULL,
        period_key TEXT NOT NULL,
        sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, kind, period_key)
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS academy_settings (
        tenant_id    TEXT PRIMARY KEY,
        auto_invoice BOOLEAN NOT NULL DEFAULT FALSE,
        updated_by   TEXT,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS academy_orders (
        id             TEXT PRIMARY KEY,
        proposal_id    TEXT UNIQUE,
        deal_id        TEXT,
        company_id     TEXT,
        tenant_id      TEXT,
        plan           TEXT NOT NULL,
        plan_name      TEXT,
        billing_period TEXT,
        setup_fee      NUMERIC NOT NULL DEFAULT 0,
        status         TEXT NOT NULL DEFAULT 'waiting',
        signer_name    TEXT,
        signer_email   TEXT,
        applied_at     TIMESTAMPTZ,
        applied_by     TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS academy_subscriptions (
        tenant_id              TEXT PRIMARY KEY,
        stripe_customer_id     TEXT,
        stripe_subscription_id TEXT,
        plan                   TEXT,
        plan_name              TEXT,
        billing_period         TEXT,
        status                 TEXT,
        amount_gross           NUMERIC,
        current_period_end     TIMESTAMPTZ,
        cancel_at              TIMESTAMPTZ,
        email                  TEXT,
        activated_at           TIMESTAMPTZ,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS academy_subscriptions_sub_uniq ON academy_subscriptions (stripe_subscription_id)`;
    await sql`
      CREATE TABLE IF NOT EXISTS academy_card_payments (
        stripe_invoice_id TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        kind              TEXT NOT NULL,
        amount_gross      NUMERIC NOT NULL,
        label             TEXT,
        claim_id          TEXT,
        manual_invoice_id TEXT,
        mirror_error      TEXT,
        mirror_started_at TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
  })().catch((err) => {
    tablesReady = null;
    console.warn('[academies] ensureAcademyTables failed', err?.message || err);
  });
  return tablesReady;
}
