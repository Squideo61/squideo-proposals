// Who can see the video-credit rate card, and at what rate.
//
// The default position is the commercial one: credit is the rung AFTER a first
// project — you buy production time in bulk once a style exists to repeat — so
// an org with nothing in production doesn't see £/min. That covers both a
// `prospect` (a crash-course signup we've never scoped anything for) and a
// company we've only sent a proposal to. Showing it would anchor every quote we
// sent them later, and undercut the one they're currently reading.
//
// But that rule is wrong at both edges, which is what these overrides are for:
// NHS and framework buyers routinely need their balance visible from day one,
// and there are clients we'd rather quote per project than hand a rate card.

import sql from '../db.js';
import { VIDEO_CREDIT } from '../videoCreditPricing.js';

let ensured = null;
export function ensureCompanyCreditColumns() {
  if (ensured) return ensured;
  ensured = (async () => {
    try {
      await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS credit_enabled BOOLEAN`;
      await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS credit_rate_per_min NUMERIC`;
      await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS credit_enabled_by TEXT`;
      await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS credit_enabled_at TIMESTAMPTZ`;
      await sql`CREATE INDEX IF NOT EXISTS companies_credit_enabled_idx
                  ON companies (credit_enabled) WHERE credit_enabled IS NOT NULL`;
    } catch (err) {
      // Never reject: an ensure() that throws takes the whole CRM down with it.
      console.warn('[companyCredit] ensure failed', err.message);
    }
  })();
  return ensured;
}

// THE RULE. Kept in one place so the nav, the API guard and the CRM label can
// never disagree about who sees what.
//
// `creditEnabled` is tri-state on purpose: NULL means nobody has decided, which
// is different from somebody deciding no.
//
// `hasProject` is what "they're a client" actually means here: a deal of theirs
// has entered production. NOT "we've sent them a proposal" — a company we're
// still quoting is a prospect whether or not they arrived via the crash course,
// and handing them £/min mid-negotiation undercuts the proposal they're sitting
// on. See hasProjectFor() for how it's resolved.
export function creditVisibleFor({ creditEnabled = null, prospect = false, hasProject = false } = {}) {
  if (creditEnabled === true) return true;    // forced on — NHS, frameworks
  if (creditEnabled === false) return false;  // forced off — quote them per project
  return !prospect && hasProject === true;    // the default: clients yes, prospects no
}

// Explains the rule to staff in the CRM, so the button never leaves someone
// wondering why a client can or can't see it.
export function creditAccessLabel({ creditEnabled = null, prospect = false, hasProject = false } = {}) {
  if (creditEnabled === true) return { on: true, why: 'Switched on for this organisation' };
  if (creditEnabled === false) return { on: false, why: 'Switched off for this organisation' };
  if (prospect) return { on: false, why: 'Hidden by default — this is a prospect, not a client yet' };
  return hasProject
    ? { on: true, why: 'Visible by default — they have a project under way' }
    : { on: false, why: 'Hidden by default — nothing is in production yet, and a proposal isn’t a project' };
}

// Which of these companies count as clients for the rule above.
//
// Two ways in, because the rate card follows the money rather than the
// paperwork:
//   1. a deal that has entered production — the "Good to go" gate, i.e. signed,
//      paid or on a PO. `production_entered_at` is NULL on deals that went into
//      production before that column existed, hence the phase check too.
//   2. they already hold credit — buying is itself proof they're a client, and
//      nobody may ever be locked out of a balance they've paid for. Matched on
//      the two deterministic links (an explicitly bound subscription, and the
//      `manual_portalcredit_<companyId>` anchor a portal purchase creates); the
//      fuzzy name/Xero matching in clientKeysForCompany is deliberately left
//      out — it costs a join per request, and every client it would find has a
//      project anyway.
//
// Returns a Set of the ids that qualify. Guarded: if either table is missing a
// column this must not take the whole portal down with it, and the caller
// treats an empty result as "no project" — which the staff override can undo.
export async function hasProjectFor(companyIds = []) {
  const ids = (companyIds || []).filter(Boolean);
  if (!ids.length) return new Set();
  const rows = await sql`
    SELECT c.id
      FROM companies c
     WHERE c.id = ANY(${ids})
       AND (
         EXISTS (
           SELECT 1 FROM deals d
            WHERE d.company_id = c.id
              AND (d.production_entered_at IS NOT NULL OR d.production_phase IS NOT NULL)
         )
         OR EXISTS (
           SELECT 1 FROM partner_subscriptions ps
            WHERE ps.company_id = c.id
               OR ps.stripe_subscription_id = 'manual_portalcredit_' || c.id
         )
       )
  `.catch((err) => {
    console.warn('[companyCredit] hasProjectFor failed', err.message);
    return [];
  });
  return new Set(rows.map((r) => r.id));
}

// The rate to quote this company, most specific first:
//   1. their own override
//   2. the rate on their most recent proposal — so the portal never contradicts
//      a number they've already been sent in writing
//   3. the workspace default
//   4. the documented fallback
//
// `suggested` is what the CRM offers to pre-fill the rate box with, and is
// deliberately the same lookup minus step 1, so "use their last proposal's
// rate" and "what they'd get anyway" are the same number.
export async function resolveCreditRate(companyId) {
  const out = { ratePerMin: VIDEO_CREDIT.defaultRatePerMin, source: 'default', suggested: null, override: null };
  if (!companyId) return out;
  await ensureCompanyCreditColumns();

  const [co] = await sql`
    SELECT credit_rate_per_min FROM companies WHERE id = ${companyId}
  `.catch(() => []);
  const override = Number(co?.credit_rate_per_min);
  if (Number.isFinite(override) && override > 0) out.override = override;

  // Most recent proposal for any of this company's deals that actually carries
  // a rate. Older proposals predate the field, hence the NOT NULL filter rather
  // than just taking the newest row.
  const [prop] = await sql`
    SELECT (p.data->'partnerProgramme'->>'standardRatePerMin') AS rate
      FROM proposals p
      JOIN deals d ON d.id = p.deal_id
     WHERE d.company_id = ${companyId}
       AND (p.data->'partnerProgramme'->>'standardRatePerMin') IS NOT NULL
     ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC
     LIMIT 1
  `.catch(() => []);
  const fromProposal = Number(prop?.rate);

  const [row] = await sql`SELECT default_proposal FROM settings WHERE id = 1`.catch(() => []);
  const workspace = Number(row?.default_proposal?.partnerProgramme?.standardRatePerMin);

  if (Number.isFinite(fromProposal) && fromProposal > 0) {
    out.suggested = fromProposal;
    out.suggestedSource = 'their last proposal';
  } else if (Number.isFinite(workspace) && workspace > 0) {
    out.suggested = workspace;
    out.suggestedSource = 'the workspace default';
  } else {
    out.suggested = VIDEO_CREDIT.defaultRatePerMin;
    out.suggestedSource = 'the standard rate';
  }

  if (out.override != null) {
    out.ratePerMin = out.override;
    out.source = 'company';
  } else {
    out.ratePerMin = out.suggested;
    out.source = out.suggestedSource === 'their last proposal' ? 'proposal' : 'workspace';
  }
  return out;
}

export async function loadCompanyCredit(companyId) {
  await ensureCompanyCreditColumns();
  const [co] = await sql`
    SELECT id, name, COALESCE(prospect, FALSE) AS prospect,
           credit_enabled, credit_rate_per_min, credit_enabled_by, credit_enabled_at
      FROM companies WHERE id = ${companyId}
  `.catch(() => []);
  if (!co) return null;
  const rate = await resolveCreditRate(companyId);
  const hasProject = (await hasProjectFor([co.id])).has(co.id);
  return {
    companyId: co.id,
    companyName: co.name,
    prospect: co.prospect === true,
    hasProject,
    creditEnabled: co.credit_enabled,           // true | false | null
    visible: creditVisibleFor({ creditEnabled: co.credit_enabled, prospect: co.prospect, hasProject }),
    label: creditAccessLabel({ creditEnabled: co.credit_enabled, prospect: co.prospect, hasProject }),
    ratePerMin: rate.ratePerMin,
    rateSource: rate.source,
    rateOverride: rate.override,
    suggestedRate: rate.suggested,
    suggestedRateSource: rate.suggestedSource,
    changedBy: co.credit_enabled_by || null,
    changedAt: co.credit_enabled_at || null,
  };
}

export async function setCompanyCredit(companyId, { enabled, ratePerMin }, byEmail = null) {
  await ensureCompanyCreditColumns();
  // `enabled` is tri-state: true / false / null (back to the default rule).
  const en = enabled === true ? true : enabled === false ? false : null;
  const rate = Number(ratePerMin);
  const rateVal = Number.isFinite(rate) && rate > 0 ? rate : null;
  await sql`
    UPDATE companies
       SET credit_enabled      = ${en},
           credit_rate_per_min = ${rateVal},
           credit_enabled_by   = ${byEmail},
           credit_enabled_at   = NOW()
     WHERE id = ${companyId}
  `;
  return loadCompanyCredit(companyId);
}
