// Who can see the video-credit rate card, and at what rate.
//
// The default position is the commercial one: credit is the rung AFTER a first
// project — you buy production time in bulk once a style exists to repeat — so
// a `prospect` org (a crash-course signup we've never scoped anything for)
// doesn't see £/min. Showing it would anchor every quote we sent them later.
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
export function creditVisibleFor({ creditEnabled = null, prospect = false } = {}) {
  if (creditEnabled === true) return true;    // forced on — NHS, frameworks
  if (creditEnabled === false) return false;  // forced off — quote them per project
  return !prospect;                           // the default: clients yes, prospects no
}

// Explains the rule to staff in the CRM, so the button never leaves someone
// wondering why a client can or can't see it.
export function creditAccessLabel({ creditEnabled = null, prospect = false } = {}) {
  if (creditEnabled === true) return { on: true, why: 'Switched on for this organisation' };
  if (creditEnabled === false) return { on: false, why: 'Switched off for this organisation' };
  return prospect
    ? { on: false, why: 'Hidden by default — this is a prospect, not a client yet' }
    : { on: true, why: 'Visible by default — they have a project with us' };
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
  return {
    companyId: co.id,
    companyName: co.name,
    prospect: co.prospect === true,
    creditEnabled: co.credit_enabled,           // true | false | null
    visible: creditVisibleFor({ creditEnabled: co.credit_enabled, prospect: co.prospect }),
    label: creditAccessLabel({ creditEnabled: co.credit_enabled, prospect: co.prospect }),
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
