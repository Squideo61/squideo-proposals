import sql from './db.js';
import { reservedMinutesFor } from './videoCreditAllocations.js';

// Runtime self-heal for db/migrations/20260730_credit_company_link.sql.
// Module-cached; resets on failure so a later call retries.
let creditCompanyLinkEnsured = null;
export function ensureCreditCompanyLink() {
  if (creditCompanyLinkEnsured) return creditCompanyLinkEnsured;
  creditCompanyLinkEnsured = (async () => {
    await sql`ALTER TABLE partner_subscriptions ADD COLUMN IF NOT EXISTS company_id TEXT REFERENCES companies(id) ON DELETE SET NULL`;
    await sql`CREATE INDEX IF NOT EXISTS partner_subscriptions_company_idx ON partner_subscriptions(company_id)`;
  })().catch((err) => { creditCompanyLinkEnsured = null; throw err; });
  return creditCompanyLinkEnsured;
}

// The partner-credit client_keys that belong to a CRM company — the single
// source of truth for "whose credit is this?", used by the company page mirror
// (api/_lib/crm/companies.js) AND the client portal's Video credit balance
// (api/_lib/videoCredit.js). The two used to keep their own copy of this SQL,
// which is how they came to disagree.
//
// partner_subscriptions.company_id is the EXPLICIT link (staff set it from the
// company page). When it's set it's the whole answer for that client; when it's
// NULL we fall back to inferring it three ways:
//   1. proposal → deal → company
//   2. a shared Xero contact
//   3. the client name, normalised — case, punctuation and spacing are ignored,
//      so "The Christie N.H.S. Foundation Trust" matches "The Christie NHS
//      Foundation Trust". (Subsumes a plain case-insensitive match.)
// A client whose name is materially different ("The Christie" vs the full trust
// name) matches none of those, which is exactly what the explicit link is for.
//
// Takes a company ID and loads the row ITSELF. Callers used to pass whatever
// company object they had to hand, and the portal's — built from the session,
// with no xero_contact_id — silently dropped route 2, so a client matched only
// by their Xero contact showed a full balance in the CRM and zero in the portal.
export async function clientKeysForCompany(companyId) {
  const id = typeof companyId === 'object' ? companyId?.id : companyId;
  if (!id) return [];
  await ensureCreditCompanyLink().catch(() => {});
  const [co] = await sql`SELECT id, name, xero_contact_id FROM companies WHERE id = ${id}`;
  if (!co) return [];
  const rows = await sql`
    SELECT DISTINCT ps.client_key
      FROM partner_subscriptions ps
      LEFT JOIN proposals p ON p.id = ps.proposal_id
      LEFT JOIN deals d ON d.id = p.deal_id
     WHERE ps.company_id = ${co.id}
        OR (ps.company_id IS NULL AND (
             d.company_id = ${co.id}
             OR (${co.xero_contact_id}::text IS NOT NULL AND ps.xero_contact_id = ${co.xero_contact_id})
             OR (
                  -- NULLIF guards the empty case: an unnamed company must not
                  -- match every subscription with a blank client_name.
                  NULLIF(regexp_replace(LOWER(COALESCE(${co.name}::text, '')), '[^a-z0-9]', '', 'g'), '') IS NOT NULL
                  AND regexp_replace(LOWER(COALESCE(ps.client_name, '')), '[^a-z0-9]', '', 'g')
                    = regexp_replace(LOWER(COALESCE(${co.name}::text, '')), '[^a-z0-9]', '', 'g')
                )
           ))
  `;
  return rows.map((r) => r.client_key);
}

// Every credit client, annotated with the company it's bound to (if any) — the
// data behind the company page's "link a credit balance" picker. Deliberately
// includes clients that resolve to no company at all: those are the ones that
// were invisible everywhere except Partners & Credits.
export async function creditClientsWithCompany() {
  await ensureCreditCompanyLink().catch(() => {});
  return await sql`
    SELECT ps.client_key,
           MAX(ps.client_name)  AS client_name,
           MAX(ps.company_id)   AS company_id,
           MAX(c.name)          AS company_name
      FROM partner_subscriptions ps
      LEFT JOIN companies c ON c.id = ps.company_id
     GROUP BY ps.client_key
  `.catch(() => []);
}

// A company's TOTAL credit, across both ledgers that hold it:
//
//   · partner credits — partner_subscriptions + credit_allocations, matched to
//     the company by clientKeysForCompany. Portal video-credit purchases land
//     here too.
//   · deal credit-based projects — project_retainers with
//     allocation_type='credits' on any of the company's deals, drawn down by
//     project_retainer_entries.
//
// They're separate systems for good operational reasons, but to the client
// "credit" is one number: a deal card reading "9 credits remaining" and a portal
// reading "0 min" is just wrong. Everything that shows a client's balance — the
// portal, the deal page, the company page — goes through here so they agree.
//
// Money-type retainers are excluded: those are a £ pot, not minutes.
export async function companyCreditTotals(companyId) {
  const id = typeof companyId === 'object' ? companyId?.id : companyId;
  const empty = { issued: 0, used: 0, remaining: 0, reserved: 0, available: 0, keys: [], partner: null, retainers: null };
  if (!id) return empty;

  const keys = await clientKeysForCompany(id);
  const [totals, retainerRows, reservedMap] = await Promise.all([
    keys.length ? creditTotalsForKeys(keys) : Promise.resolve([]),
    sql`
      SELECT r.id, r.allocation_amount,
             COALESCE((SELECT SUM(e.value) FROM project_retainer_entries e WHERE e.retainer_id = r.id), 0) AS used
        FROM project_retainers r
        JOIN deals d ON d.id = r.deal_id
       WHERE d.company_id = ${id}
         AND r.allocation_type = 'credits'
         AND COALESCE(r.status, 'active') = 'active'
    `.catch(() => []),
    // Minutes a production manager has earmarked against specific videos —
    // often videos that haven't started yet. Still on the balance, but spoken
    // for, so they come out of "available" without moving "used".
    reservedMinutesFor([id]).catch(() => new Map()),
  ]);

  const partner = {
    issued: totals.reduce((s, t) => s + (Number(t.credits_issued) || 0), 0),
    used: totals.reduce((s, t) => s + (Number(t.credits_used) || 0), 0),
  };
  partner.remaining = partner.issued - partner.used;

  const retainers = {
    issued: retainerRows.reduce((s, r) => s + (Number(r.allocation_amount) || 0), 0),
    used: retainerRows.reduce((s, r) => s + (Number(r.used) || 0), 0),
    count: retainerRows.length,
  };
  retainers.remaining = retainers.issued - retainers.used;

  // Reservations only ever draw on the partner ledger (see
  // api/_lib/videoCreditAllocations.js) — a deal's own credit project assigns
  // per video through project_retainer_entries, which already shows up in
  // retainers.used.
  const reserved = reservedMap.get(id) || 0;
  partner.reserved = reserved;
  partner.available = partner.remaining - reserved;

  return {
    issued: partner.issued + retainers.issued,
    used: partner.used + retainers.used,
    // `remaining` keeps its long-standing meaning — issued minus used — so
    // nothing that already reads it changes behaviour. `available` is the
    // narrower "free to spend on something new" figure.
    remaining: partner.remaining + retainers.remaining,
    reserved,
    available: partner.remaining + retainers.remaining - reserved,
    keys,
    partner,
    retainers,
  };
}

// Bind (or unbind) every subscription under a client_key to a company.
export async function setCreditClientCompany(clientKey, companyId) {
  await ensureCreditCompanyLink();
  const rows = await sql`
    UPDATE partner_subscriptions SET company_id = ${companyId || null}
     WHERE client_key = ${clientKey}
    RETURNING client_key
  `;
  return rows.length;
}

// Core partner-credit math, shared by the Partners & Credits list
// (api/partner/[action].js → listCredits) and the company "Current Projects"
// view (api/_lib/crm/companies.js). Returns issued / used / remaining + a
// three-way status per partner client.
//
// Credit model (mirrors the comments in api/partner/[action].js):
//  · Stripe-tracked subs: credits_per_month × (1 initial + recurring invoices).
//  · Manual subs, auto_credit=true: credits_per_month × (months elapsed + 1).
//  · Manual subs, auto_credit=false: 0 (topped up via adjustments).
//  · Adjustments (credit_allocations.kind='adjustment'): positive → issued,
//    negative → used. Work (kind='work') → used.
//
// `keys` scopes to a set of client_keys; pass null/empty for every client.
export async function creditTotalsForKeys(keys) {
  const k = keys && keys.length ? keys : null;
  return await sql`
    WITH sub_totals AS (
      SELECT
        ps.client_key,
        ps.client_name,
        ps.status,
        ps.proposal_id,
        ps.stripe_subscription_id,
        (
          CASE
            WHEN ps.stripe_subscription_id LIKE 'manual_%' THEN
              CASE
                WHEN ps.auto_credit IS TRUE THEN
                  ps.credits_per_month * GREATEST(0,
                    EXTRACT(YEAR  FROM AGE(COALESCE(ps.canceled_at, NOW()), COALESCE(ps.start_date, ps.created_at::date)))::INT * 12 +
                    EXTRACT(MONTH FROM AGE(COALESCE(ps.canceled_at, NOW()), COALESCE(ps.start_date, ps.created_at::date)))::INT + 1
                  )
                ELSE 0
              END
            ELSE
              ps.credits_per_month * (
                1 + COALESCE(
                  (SELECT COUNT(*) FROM partner_invoices pi WHERE pi.proposal_id = ps.proposal_id),
                  0
                )
              )
          END
        )::NUMERIC AS issued_from_sub,
        (ps.status = 'active' AND (
          ps.stripe_subscription_id NOT LIKE 'manual_%'
          OR (ps.auto_credit IS TRUE AND ps.credits_per_month > 0)
        )) AS is_recurring_active,
        (ps.stripe_subscription_id LIKE 'manual_%'
          AND ps.auto_credit IS NOT TRUE
          AND ps.credits_per_month = 0) AS is_credits_only,
        (SELECT MAX(paid_at) FROM partner_invoices pi WHERE pi.proposal_id = ps.proposal_id) AS last_recurring,
        (SELECT paid_at FROM payments p WHERE p.proposal_id = ps.proposal_id) AS initial_paid
      FROM partner_subscriptions ps
      WHERE (${k}::text[] IS NULL OR ps.client_key = ANY(${k}::text[]))
    ),
    summary AS (
      SELECT
        client_key,
        MAX(client_name) AS client_name,
        COUNT(*)::INT AS sub_count,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)::INT AS sub_active_count,
        COALESCE(SUM(issued_from_sub), 0)::NUMERIC AS sub_issued,
        GREATEST(MAX(last_recurring), MAX(initial_paid)) AS last_payment_at,
        BOOL_OR(status = 'active') AS any_active,
        BOOL_OR(status = 'paused') AS any_paused,
        BOOL_OR(is_recurring_active) AS any_recurring_active,
        BOOL_OR(is_credits_only) AS any_credits_only
      FROM sub_totals
      GROUP BY client_key
    ),
    movements AS (
      SELECT
        client_key,
        COALESCE(SUM(CASE WHEN kind = 'adjustment' AND credit_cost > 0 THEN credit_cost ELSE 0 END), 0)::NUMERIC AS adj_added,
        COALESCE(SUM(CASE WHEN kind = 'adjustment' AND credit_cost < 0 THEN -credit_cost ELSE 0 END), 0)::NUMERIC AS adj_removed,
        COALESCE(SUM(CASE WHEN kind = 'work' THEN credit_cost ELSE 0 END), 0)::NUMERIC AS work_used
      FROM credit_allocations
      WHERE (${k}::text[] IS NULL OR client_key = ANY(${k}::text[]))
      GROUP BY client_key
    )
    SELECT
      s.client_key,
      s.client_name,
      s.sub_count,
      s.sub_active_count,
      (s.sub_issued + COALESCE(m.adj_added, 0))                                  AS credits_issued,
      (COALESCE(m.work_used, 0) + COALESCE(m.adj_removed, 0))                    AS credits_used,
      (s.sub_issued + COALESCE(m.adj_added, 0)
        - COALESCE(m.work_used, 0) - COALESCE(m.adj_removed, 0))                 AS credits_remaining,
      s.last_payment_at,
      s.any_paused,
      CASE
        WHEN s.any_recurring_active THEN 'active'
        WHEN s.any_credits_only
          OR (s.sub_issued + COALESCE(m.adj_added, 0)
              - COALESCE(m.work_used, 0) - COALESCE(m.adj_removed, 0)) > 0
          THEN 'credits_only'
        ELSE 'inactive'
      END AS status
    FROM summary s
    LEFT JOIN movements m ON m.client_key = s.client_key
    ORDER BY s.any_recurring_active DESC, s.client_name NULLS LAST
  `;
}

// The reverse of clientKeysForCompany: which company (or companies) does this
// credit client resolve to, and by which route? The Partners & Credits page
// needs this to answer "will this balance reach their portal?" — credit that
// matches no company is invisible on the company page and reads as 0 minutes in
// the client portal, which is exactly the failure this reports.
//
// Deliberately mirrors clientKeysForCompany's routes verbatim (explicit link,
// proposal → deal, shared Xero contact, normalised name) so the two can't
// disagree about what is matched.
export async function companiesForClientKey(clientKey) {
  if (!clientKey) return [];
  const byKey = await companyMatchesByClientKey([clientKey]);
  return byKey.get(clientKey) || [];
}

// The same match, for many clients at once: the Partners & Credits list uses it
// to flag balances that reach no organisation at all. `keys` null = every
// client. Returns a Map of client_key → [{ id, name, explicit, matchedBy }].
export async function companyMatchesByClientKey(keys = null) {
  await ensureCreditCompanyLink().catch(() => {});
  const k = keys && keys.length ? keys : null;
  // Both sides are normalised once in a CTE rather than inside the join
  // condition: this is a cross-join between every credit client and every
  // company, so a per-pair regexp_replace would run it hundreds of thousands of
  // times to answer one page load.
  const rows = await sql`
    WITH subs AS (
      SELECT ps.client_key,
             ps.company_id,
             ps.xero_contact_id,
             d.company_id AS deal_company_id,
             regexp_replace(LOWER(COALESCE(ps.client_name, '')), '[^a-z0-9]', '', 'g') AS norm_name
        FROM partner_subscriptions ps
        LEFT JOIN proposals p ON p.id = ps.proposal_id
        LEFT JOIN deals d ON d.id = p.deal_id
       WHERE (${k}::text[] IS NULL OR ps.client_key = ANY(${k}::text[]))
    ),
    cos AS (
      SELECT c.id, c.name, c.xero_contact_id,
             NULLIF(regexp_replace(LOWER(COALESCE(c.name, '')), '[^a-z0-9]', '', 'g'), '') AS norm_name
        FROM companies c
    )
    SELECT s.client_key, c.id, c.name,
           BOOL_OR(s.company_id = c.id)                                  AS by_link,
           BOOL_OR(s.company_id IS NULL AND s.deal_company_id = c.id)    AS by_proposal,
           BOOL_OR(s.company_id IS NULL AND c.xero_contact_id IS NOT NULL
                   AND s.xero_contact_id = c.xero_contact_id)            AS by_xero,
           BOOL_OR(s.company_id IS NULL AND s.norm_name = c.norm_name)   AS by_name
      FROM subs s
      JOIN cos c ON (
            s.company_id = c.id
         OR (s.company_id IS NULL AND (
              s.deal_company_id = c.id
              OR (c.xero_contact_id IS NOT NULL AND s.xero_contact_id = c.xero_contact_id)
              OR s.norm_name = c.norm_name
            ))
      )
     GROUP BY s.client_key, c.id, c.name
  `.catch(() => []);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.client_key)) out.set(r.client_key, []);
    out.get(r.client_key).push({
      id: r.id,
      name: r.name,
      explicit: r.by_link === true,
      matchedBy: [
        r.by_link && 'explicit link',
        r.by_proposal && 'linked proposal',
        r.by_xero && 'shared Xero contact',
        r.by_name && 'name match',
      ].filter(Boolean),
    });
  }
  return out;
}
