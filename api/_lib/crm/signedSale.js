// Single source of truth for what counts as a genuine *signed sale*, shared by
// Sales Insights and Marketing so the two dashboards can never disagree.
//
// A deal qualifies as a signed sale when it:
//   1. has an actual signature, OR has reached the signed/paid stage — being
//      parked in `long_term` without a signature does NOT count (it's an
//      ongoing-client status, not a freshly signed proposal); AND
//   2. carries a real (>0) value — £0 placeholders/test records don't count; AND
//   3. isn't one of the historical imports listed below.

// One-off list of historical imported/back-entered deals to exclude. They were
// bulk-entered (not won through the pipeline) and inflate the figures. This is an
// explicit, finite set, NOT a forward-applying rule: genuine same-day signs (e.g.
// Stockton) are deliberately absent, and any new deal — however fast it closes —
// is counted. No more imports are expected; add IDs here if a cleanup is needed.
export const EXCLUDED_IMPORT_DEAL_IDS = new Set([
  'deal_1782382102434_457941b7961f2ab942', // mylife Diabetes Care Ltd (back-entered; actually signed 9 Apr)
  'deal_1781682720715_fb91b1884055f6ba4d', // Membership Solutions Ltd
  'deal_1781686640156_fa5740ec73d93ac513', // Airport Coordination Ltd (UK)
  'deal_1781618597007_caa655026fa62917c0', // S&E CareTrade Video 1
  'deal_1781597942024_c770f294b689e9fefb', // International Tree Foundation
  'deal_1781602227135_3e91721fc319b53351', // Catherine Hunter - Humber Teaching NHS
  'deal_1781600780429_1c284acc5fc55d7233', // Government of Jersey
  'deal_1781620527698_2fde90050e5d8ec240', // Jola Cloud Solutions Ltd
  'deal_1781769674927_52bc6f33f4a95175d5', // Venues Group
  'deal_1781514371549_24e2d802f192f038b0', // Compliance Chain
  'deal_1781516198554_9048d44792741b95d0', // Alation, Inc
  'deal_1781515516329_553e705cecf85c5090', // Drain Trader Ltd
  'deal_1781514183817_cf11b036ee36cead92', // TB Projects
  'deal_1781515056827_18bfd419331bf22083', // Meliora Medical Group
  'deal_1781263185731_339f21f0dbb0093d5e', // PIB Employee Benefits Limited
  'deal_1781270430083_875f32c215317c50d3', // South East Water
]);

export const isImportedDeal = (id) => EXCLUDED_IMPORT_DEAL_IDS.has(id);

// "Reached signed/paid" — currently at that stage, or moved through it at some
// point (so a deal signed then bumped to long_term still counts). `events` is an
// optional array of stage-change steps shaped { to }; pass [] when not loaded.
export function reachedSignedOrPaid(stage, events = []) {
  return stage === 'signed' || stage === 'paid'
    || (Array.isArray(events) && events.some((e) => e.to === 'signed' || e.to === 'paid'));
}

// The shared predicate. Pass what you have:
//   { id, stage, hasSignature, value, events? }
export function isSignedSale({ id, stage, hasSignature, value, events = [] }) {
  const isSignedProposal = !!hasSignature || reachedSignedOrPaid(stage, events);
  return isSignedProposal && (Number(value) || 0) > 0 && !EXCLUDED_IMPORT_DEAL_IDS.has(id);
}
