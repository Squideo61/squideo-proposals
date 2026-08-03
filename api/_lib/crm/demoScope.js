// The seeded demo project (Admin → Testing) is real CRM data: a company, a
// signed £2,400 proposal, a deal in production. That's the point — you walk the
// client journey against the real code. But it means every money report counts
// it, and pretend business on the Finance page is worse than no demo at all:
// pending payments, cash generated, income, targets and commission all quietly
// drift by whatever the demo is worth.
//
// So Finance excludes it. One predicate, applied where each report assembles
// its rows, rather than a WHERE clause bolted onto thirty queries — the row
// shapes differ (did / deal_id / dealId / company_id) but they all carry one of
// them, so `isDemo(row)` reads the same everywhere.
//
// Identified by the company NAME, exactly as api/crm/demo.js finds it to seed
// and tear down — no flag column, nothing to migrate, and no way for the two to
// disagree about what the demo is.
//
// Deliberately NOT applied to Sales, Projects or the pipeline: that's where you
// exercise the demo, so it needs to show.

import sql from '../db.js';

export const DEMO_COMPANY_NAME = '[DEMO] Test Client';

const TTL_MS = 60_000;
let cache = null; // { at, companyIds, dealIds }

// Seeding or tearing down the demo changes what's excluded — the demo routes
// call this so the next report doesn't read a stale set.
export function invalidateDemoScope() { cache = null; }

const EXCLUDES_NOTHING = {
  companyIds: new Set(), dealIds: new Set(), isDemo: () => false, notDemo: () => true,
};

// Returns { companyIds, dealIds, isDemo(row), notDemo(row) }.
//
// isDemo reads whichever id the caller's row happens to carry. A row with
// NEITHER (imported sheet rows, partner fees, recurring "Other") is never
// demo — nothing seeded can reach those tables.
export async function demoScope() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  let rows;
  try {
    rows = await sql`
      SELECT c.id AS company_id, d.id AS deal_id
        FROM companies c
        LEFT JOIN deals d ON d.company_id = c.id
       WHERE c.name = ${DEMO_COMPANY_NAME}`;
  } catch (err) {
    // Never take the Finance page down over the demo filter.
    console.warn('[demoScope] lookup failed', err.message);
    return EXCLUDES_NOTHING;
  }
  const companyIds = new Set();
  const dealIds = new Set();
  for (const r of rows || []) {
    if (r.company_id) companyIds.add(r.company_id);
    if (r.deal_id) dealIds.add(r.deal_id);
  }
  const isDemo = (row) => {
    if (!row) return false;
    const company = row.companyId ?? row.company_id ?? null;
    if (company && companyIds.has(company)) return true;
    const deal = row.dealId ?? row.deal_id ?? row.did ?? null;
    return !!deal && dealIds.has(deal);
  };
  cache = { at: Date.now(), companyIds, dealIds, isDemo, notDemo: (row) => !isDemo(row) };
  return cache;
}
