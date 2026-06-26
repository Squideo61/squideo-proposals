// Sales Insights — everything the CRM can infer about the *sales cycle* itself:
// pipeline health, velocity/time-in-stage, win rates, forecasting, rep
// performance, deal-size shape, proposal engagement → outcome, and stalled
// deals needing a nudge. Deliberately scoped to what happens to a deal once it's
// in the pipeline — lead sourcing (channel/campaign/ROAS) lives in Marketing and
// is not duplicated here.
//
// Values come from annotateDeals().effectiveValue (signed > latest proposal >
// manual) so every figure reconciles with the pipeline. Sale date = the
// signature's signed_at (fallback: the stage→signed change).
import sql from '../db.js';
import { annotateDeals } from './deals.js';

const STAGES = ['lead', 'responded', 'proposal_sent', 'viewed', 'interested', 'signed', 'paid', 'long_term', 'lost'];
const STAGE_RANK = Object.fromEntries(STAGES.map((s, i) => [s, i]));
const OPEN_STAGES = ['lead', 'responded', 'proposal_sent', 'viewed', 'interested'];
const WON_STAGES = new Set(['signed', 'paid', 'long_term']);
// Pre-sale journey shown in the funnel (ends at the first "won" stage).
const FUNNEL_STAGES = ['lead', 'responded', 'proposal_sent', 'viewed', 'interested', 'signed'];
// Probability weighting per open stage for the weighted forecast.
const STAGE_PROB = { lead: 0.05, responded: 0.10, proposal_sent: 0.30, viewed: 0.45, interested: 0.65 };
// One-off list of historical imported/back-entered deals to exclude from the
// signed-proposal metrics — they were bulk-entered (not won through the
// pipeline) and inflate the figures. This is an explicit, finite set, NOT a
// forward-applying rule: genuine same-day signs (e.g. Stockton) are deliberately
// absent, and any new deal — however fast it closes — is counted. No more
// imports are expected; if a future cleanup is ever needed, add IDs here.
const EXCLUDED_IMPORT_DEAL_IDS = new Set([
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
const STAGE_LABEL = {
  lead: 'Lead', responded: 'Responded', proposal_sent: 'Proposal sent', viewed: 'Viewed',
  interested: 'Interested', signed: 'Signed', paid: 'Paid', long_term: 'Long-term', lost: 'Lost',
};

const round2 = (n) => Number((Number(n) || 0).toFixed(2));
const round1 = (n) => Number((Number(n) || 0).toFixed(1));
const pctRate = (num, den) => (den > 0 ? round1((num / den) * 100) : null);
const days = (a, b) => (a && b ? (new Date(b).getTime() - new Date(a).getTime()) / 86400000 : null);
function median(arr) {
  const s = arr.filter((n) => n != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function parseRange(req) {
  let from = null, to = null;
  try { const u = new URL(req.url, 'http://localhost'); from = u.searchParams.get('from'); to = u.searchParams.get('to'); } catch { /* ignore */ }
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const now = new Date();
  const toDate = isDate(to) ? new Date(to + 'T00:00:00Z') : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const toExcl = new Date(toDate.getTime() + 86400000);
  const fromDate = isDate(from) ? new Date(from + 'T00:00:00Z') : new Date(toExcl.getTime() - 365 * 86400000);
  return { fromDate, toExcl, fromStr: fromDate.toISOString().slice(0, 10), toStr: toExcl.toISOString().slice(0, 10) };
}

export async function salesInsightsRoute(req, res, id, action, user) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    return res.status(200).json(await buildInsights(req));
  } catch (err) {
    console.error('[sales-insights]', err?.message);
    return res.status(500).json({ error: 'Failed to build sales insights' });
  }
}

async function buildInsights(req) {
  const { fromDate, toExcl, fromStr, toStr } = parseRange(req);
  const inRange = (d) => d && new Date(d) >= fromDate && new Date(d) < toExcl;

  const dealRows = await sql`SELECT * FROM deals`;
  const annotated = await annotateDeals(dealRows);
  const annById = new Map(annotated.map((d) => [d.id, d]));

  // Sale date + payment plan from signatures.
  let signedMap = new Map();
  try {
    const sig = await sql`
      SELECT p.deal_id AS did, MIN(s.signed_at) AS signed_at,
             (ARRAY_AGG(s.data ->> 'paymentOption'))[1] AS payment_option
        FROM signatures s JOIN proposals p ON p.id = s.proposal_id
       WHERE s.signed_at IS NOT NULL
       GROUP BY p.deal_id`;
    signedMap = new Map(sig.map((r) => [r.did, { signedAt: r.signed_at, paymentOption: r.payment_option || null }]));
  } catch { /* no signatures table */ }

  // Earliest proposal per deal — the real "cycle start" for deals that were
  // auto-created at signature time (their deals.created_at ≈ signed_at, which
  // would otherwise make the sales cycle look like ~0 days).
  let firstPropMap = new Map();
  try {
    const props = await sql`SELECT deal_id, MIN(created_at) AS first_at FROM proposals WHERE deal_id IS NOT NULL GROUP BY deal_id`;
    firstPropMap = new Map(props.map((r) => [r.deal_id, r.first_at]));
  } catch { /* no proposals table */ }

  // The true top-of-funnel for a deal that came from a web-form enquiry is the
  // enquiry date — earlier than the deal/proposal. Used only to time the sales
  // cycle accurately (not to report on lead source, which is Marketing's job).
  let leadCreatedMap = new Map();
  try {
    const qrs = await sql`SELECT deal_id, MIN(created_at) AS first_at FROM quote_requests WHERE deal_id IS NOT NULL GROUP BY deal_id`;
    leadCreatedMap = new Map(qrs.map((r) => [r.deal_id, r.first_at]));
  } catch { /* no quote_requests table */ }

  // Stage-change history per deal (for velocity / time-in-stage / max reached).
  const stageEventsByDeal = new Map();
  try {
    const evs = await sql`
      SELECT deal_id, payload, occurred_at
        FROM deal_events
       WHERE event_type = 'stage_change'
       ORDER BY deal_id, occurred_at ASC`;
    for (const e of evs) {
      if (!stageEventsByDeal.has(e.deal_id)) stageEventsByDeal.set(e.deal_id, []);
      stageEventsByDeal.get(e.deal_id).push({ to: e.payload?.to, at: e.occurred_at });
    }
  } catch { /* no deal_events */ }

  // ---- Per-deal derived facts ------------------------------------------------
  const deals = dealRows.map((r) => {
    const a = annById.get(r.id) || {};
    const sig = signedMap.get(r.id) || null;
    const stage = r.stage || 'lead';
    const isWon = WON_STAGES.has(stage) || !!sig;
    const isLost = stage === 'lost';
    const isOpen = !isWon && !isLost;
    const events = stageEventsByDeal.get(r.id) || [];
    // Sale date = the FIRST time the deal reached a won stage, not the last
    // stage change. Otherwise a deal signed weeks ago that recently moved
    // signed→paid (which bumps stage_changed_at) would wrongly count as a sale
    // in the current window. Prefer a real signature, then the first won event,
    // then fall back to stage_changed_at.
    let firstWonAt = null;
    for (const ev of events) { if (ev.to === 'signed' || ev.to === 'paid' || ev.to === 'long_term') { firstWonAt = ev.at; break; } }
    const saleAt = sig?.signedAt || firstWonAt || (isWon ? r.stage_changed_at : null);
    // Cycle starts at the earliest real touch — the deal's creation OR its first
    // proposal (whichever is earlier), so signature-originated deals aren't 0-day.
    const firstPropAt = firstPropMap.get(r.id) || null;
    const leadAt = leadCreatedMap.get(r.id) || null;
    const starts = [r.created_at, firstPropAt, leadAt].filter(Boolean).map((x) => new Date(x).getTime());
    const cycleStartAt = starts.length ? new Date(Math.min(...starts)).toISOString() : r.created_at;
    const value = Number(a.effectiveValue) || 0;
    const cycleDays = days(cycleStartAt, saleAt);
    const isImported = EXCLUDED_IMPORT_DEAL_IDS.has(r.id);
    // A "signed proposal" must have an actual signature, or have reached the
    // signed/paid stage. Being moved to "long-term" (an ongoing-client status)
    // does NOT by itself count as signing a proposal, so a deal parked in
    // long_term with no signature is kept out of the signed-proposal metrics.
    const reachedSignedOrPaid = stage === 'signed' || stage === 'paid'
      || events.some((e) => e.to === 'signed' || e.to === 'paid');
    const isSignedProposal = !!sig?.signedAt || reachedSignedOrPaid;
    const hasProposal = a.valueSource === 'proposal' || a.valueSource === 'signed' || (a.proposalCount || 0) > 0;
    const tracking = a.tracking || {};
    return {
      id: r.id, title: r.title, stage, owner: r.owner_email || null,
      createdAt: r.created_at, cycleStartAt, cycleDays, isImported, stageChangedAt: r.stage_changed_at, lastActivityAt: r.last_activity_at,
      // isSale = a genuine signed proposal: signed/paid (or carrying a signature),
      // a real value, and not a listed historical import. £0 records, bare
      // long-term parks, and imports stay out of the signed-proposal metrics —
      // while also staying out of open/lost.
      lostReason: r.lost_reason || null, value, isWon, isSale: isSignedProposal && value > 0 && !isImported, isImportedSale: isSignedProposal && value > 0 && isImported, isLost, isOpen, saleAt,
      paymentOption: sig?.paymentOption || null, hasProposal,
      proposalOpens: tracking.proposalOpens || 0, lastOpenedAt: tracking.lastOpenedAt || null,
      events,
    };
  });

  const dealById = new Map(deals.map((d) => [d.id, d]));

  // Furthest stage a deal ever reached (so a deal that slipped back, or was
  // marked lost, is still credited with the progress it made).
  const maxReachedRank = (d) => {
    let max = STAGE_RANK[d.isLost ? 'lead' : d.stage] ?? 0;
    for (const e of d.events) { const rk = STAGE_RANK[e.to]; if (rk != null && e.to !== 'lost' && rk > max) max = rk; }
    if (d.isWon) max = Math.max(max, STAGE_RANK.signed);
    return max;
  };

  // ---- Learned win-probabilities (continuously self-calibrating) -------------
  // Rather than fixed stage weights, estimate P(win | reached stage) from the
  // whole deal history: of every *decided* deal (won or lost) that ever reached
  // a stage, what share were won. Each estimate is blended with the static prior
  // via pseudo-counts (PRIOR_STRENGTH), so a thin sample leans on the prior and
  // converges to the firm's real rate as deals close. Enforced monotonic — a
  // deal further down the funnel can't be less likely to win than one behind it.
  // Recomputed on every request, so it tracks performance with no training job.
  const PRIOR_STRENGTH = 6;
  // A "win" here = a genuine signed proposal (d.isSale): excludes imports, £0
  // placeholders and bare long-term parks, so none of those distort the learned
  // stage win-rates. Losses are all real losses.
  const decidedAll = deals.filter((d) => d.isSale || d.isLost);
  const winProb = {};
  const probDetail = [];
  let runMax = 0;
  for (const stage of OPEN_STAGES) {
    const reached = decidedAll.filter((d) => maxReachedRank(d) >= STAGE_RANK[stage]);
    const wins = reached.filter((d) => d.isSale).length;
    const prior = STAGE_PROB[stage] || 0;
    const blended = (wins + prior * PRIOR_STRENGTH) / (reached.length + PRIOR_STRENGTH);
    runMax = Math.max(runMax, blended);
    winProb[stage] = runMax;
    probDetail.push({ stage, label: STAGE_LABEL[stage], prob: round1(runMax * 100), wins, decided: reached.length });
  }
  const probSample = decidedAll.length;

  // ---- Pipeline now (open, as of today — not range-scoped) -------------------
  const open = deals.filter((d) => d.isOpen);
  const byStage = OPEN_STAGES.map((stage) => {
    const ds = open.filter((d) => d.stage === stage);
    const value = ds.reduce((s, d) => s + d.value, 0);
    return { stage, label: STAGE_LABEL[stage], count: ds.length, value: round2(value), weighted: round2(value * (winProb[stage] || 0)) };
  });
  const openValue = round2(open.reduce((s, d) => s + d.value, 0));
  const weightedForecast = round2(open.reduce((s, d) => s + d.value * (winProb[d.stage] || 0), 0));

  // ---- Won / lost in range ---------------------------------------------------
  const wonInRange = deals.filter((d) => d.isSale && inRange(d.saleAt));
  const lostInRange = deals.filter((d) => d.isLost && inRange(d.stageChangedAt));
  const wonValue = round2(wonInRange.reduce((s, d) => s + d.value, 0));
  const decided = wonInRange.length + lostInRange.length;
  const winRate = pctRate(wonInRange.length, decided);
  const cycleDaysArr = wonInRange.map((d) => days(d.cycleStartAt, d.saleAt)).filter((n) => n != null && n >= 0);
  const avgCycleDays = cycleDaysArr.length ? round1(cycleDaysArr.reduce((a, b) => a + b, 0) / cycleDaysArr.length) : null;
  const medianCycleDays = cycleDaysArr.length ? round1(median(cycleDaysArr)) : null;
  const wonValues = wonInRange.map((d) => d.value).filter((v) => v > 0);
  const avgDealValue = wonValues.length ? round2(wonValues.reduce((a, b) => a + b, 0) / wonValues.length) : null;
  const medianDealValue = wonValues.length ? round2(median(wonValues)) : null;

  // ---- Stage funnel + velocity (cohort: deals created in range) --------------
  const cohort = deals.filter((d) => inRange(d.createdAt));
  // Completed durations spent in each stage, across the cohort.
  const stageDurations = Object.fromEntries(FUNNEL_STAGES.map((s) => [s, []]));
  for (const d of cohort) {
    const seq = [{ to: 'lead', at: d.createdAt }, ...d.events.filter((e) => e.to)];
    for (let i = 0; i < seq.length - 1; i++) {
      const dur = days(seq[i].at, seq[i + 1].at);
      if (dur != null && dur >= 0 && stageDurations[seq[i].to]) stageDurations[seq[i].to].push(dur);
    }
  }
  const funnel = FUNNEL_STAGES.map((stage, i) => {
    const reached = cohort.filter((d) => maxReachedRank(d) >= STAGE_RANK[stage]).length;
    const prevReached = i === 0 ? reached : cohort.filter((d) => maxReachedRank(d) >= STAGE_RANK[FUNNEL_STAGES[i - 1]]).length;
    const durs = stageDurations[stage] || [];
    return {
      stage, label: STAGE_LABEL[stage], reached,
      conversionFromPrev: i === 0 ? 100 : pctRate(reached, prevReached),
      conversionFromStart: pctRate(reached, cohort.length),
      avgDaysInStage: durs.length ? round1(durs.reduce((a, b) => a + b, 0) / durs.length) : null,
    };
  });

  // ---- Rep leaderboard -------------------------------------------------------
  const userRows = await sql`SELECT email, name FROM users`;
  const nameByEmail = new Map(userRows.map((u) => [String(u.email).toLowerCase(), u.name]));
  const repMap = new Map();
  const rep = (email) => {
    const key = (email || 'unassigned').toLowerCase();
    if (!repMap.has(key)) repMap.set(key, { email: email || null, name: email ? (nameByEmail.get(key) || email) : 'Unassigned', openValue: 0, openCount: 0, wonCount: 0, wonValue: 0, lostCount: 0, cycle: [], signedDeals: [] });
    return repMap.get(key);
  };
  for (const d of open) { const r = rep(d.owner); r.openValue += d.value; r.openCount += 1; }
  for (const d of wonInRange) {
    const r = rep(d.owner); r.wonCount += 1; r.wonValue += d.value;
    const c = days(d.cycleStartAt, d.saleAt); if (c != null && c >= 0) r.cycle.push(c);
    r.signedDeals.push({ id: d.id, title: d.title || 'Untitled deal', value: round2(d.value), signedAt: d.saleAt, cycleDays: c != null && c >= 0 ? c : null });
  }
  for (const d of lostInRange) { rep(d.owner).lostCount += 1; }
  const reps = [...repMap.values()].map((r) => ({
    email: r.email, name: r.name,
    openValue: round2(r.openValue), openCount: r.openCount,
    wonCount: r.wonCount, wonValue: round2(r.wonValue),
    winRate: pctRate(r.wonCount, r.wonCount + r.lostCount),
    avgCycleDays: r.cycle.length ? round1(r.cycle.reduce((a, b) => a + b, 0) / r.cycle.length) : null,
    signedDeals: r.signedDeals.sort((a, b) => new Date(b.signedAt || 0) - new Date(a.signedAt || 0)),
  })).sort((a, b) => b.wonValue - a.wonValue || b.openValue - a.openValue);

  // ---- Bookings trend (won value by month, last 12 months) -------------------
  const now = new Date();
  const monthKeys = [];
  for (let i = 11; i >= 0; i--) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); monthKeys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`); }
  const trendMap = new Map(monthKeys.map((k) => [k, { month: k, count: 0, value: 0 }]));
  for (const d of deals) {
    if (!d.isSale || !d.saleAt) continue;
    const dt = new Date(d.saleAt);
    const k = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
    if (trendMap.has(k)) { const t = trendMap.get(k); t.count += 1; t.value += d.value; }
  }
  const trend = monthKeys.map((k) => ({ ...trendMap.get(k), value: round2(trendMap.get(k).value) }));

  // ---- Lost analysis ---------------------------------------------------------
  const lostReasonMap = new Map();
  for (const d of lostInRange) {
    const key = (d.lostReason && d.lostReason.trim()) || 'No reason given';
    if (!lostReasonMap.has(key)) lostReasonMap.set(key, { reason: key, count: 0, value: 0 });
    const r = lostReasonMap.get(key); r.count += 1; r.value += d.value;
  }
  const lostByReason = [...lostReasonMap.values()].map((r) => ({ ...r, value: round2(r.value) })).sort((a, b) => b.count - a.count);

  // ---- Deal-size distribution (open + won-in-range) --------------------------
  const sizePool = [...open, ...wonInRange].map((d) => d.value).filter((v) => v > 0);
  const BANDS = [
    { label: '< £1k', min: 0, max: 1000 },
    { label: '£1k–£3k', min: 1000, max: 3000 },
    { label: '£3k–£6k', min: 3000, max: 6000 },
    { label: '£6k–£12k', min: 6000, max: 12000 },
    { label: '£12k+', min: 12000, max: Infinity },
  ];
  const sizeBands = BANDS.map((b) => ({ label: b.label, count: sizePool.filter((v) => v >= b.min && v < b.max).length }));
  const biggestOpen = open.filter((d) => d.value > 0).sort((a, b) => b.value - a.value).slice(0, 8)
    .map((d) => ({ id: d.id, title: d.title, value: round2(d.value), stage: d.stage, stageLabel: STAGE_LABEL[d.stage], owner: d.owner }));

  // ---- Proposal engagement → outcome -----------------------------------------
  const withProposal = deals.filter((d) => d.hasProposal);
  const viewed = withProposal.filter((d) => d.proposalOpens > 0);
  // Win-rate-when-viewed compares DECIDED deals only (won or lost) — including
  // still-open viewed proposals would wrongly count them as "not won".
  const decidedProp = withProposal.filter((d) => d.isSale || d.isLost);
  const viewedDecided = decidedProp.filter((d) => d.proposalOpens > 0);
  const notViewedDecided = decidedProp.filter((d) => d.proposalOpens === 0);
  // Follow-up: a proposal the client opened, still open, sorted by recency.
  const followUp = open.filter((d) => d.hasProposal && d.proposalOpens > 0 && d.lastOpenedAt)
    .sort((a, b) => new Date(b.lastOpenedAt) - new Date(a.lastOpenedAt))
    .slice(0, 10)
    .map((d) => ({ id: d.id, title: d.title, value: round2(d.value), stage: d.stage, stageLabel: STAGE_LABEL[d.stage], owner: d.owner, opens: d.proposalOpens, lastOpenedAt: d.lastOpenedAt }));
  const engagement = {
    sent: withProposal.length,
    viewed: viewed.length,
    viewRate: pctRate(viewed.length, withProposal.length),
    winRateViewed: pctRate(viewedDecided.filter((d) => d.isSale).length, viewedDecided.length),
    winRateNotViewed: pctRate(notViewedDecided.filter((d) => d.isSale).length, notViewedDecided.length),
    followUp,
  };

  // ---- Stalled open deals (no activity in 14+ days) --------------------------
  const STALE_DAYS = 14;
  const stalled = open.map((d) => {
    const ref = d.lastActivityAt || d.stageChangedAt || d.createdAt;
    return { ...d, daysStale: ref ? Math.floor(days(ref, new Date().toISOString())) : null };
  }).filter((d) => d.daysStale != null && d.daysStale >= STALE_DAYS)
    .sort((a, b) => b.value - a.value || b.daysStale - a.daysStale)
    .slice(0, 12)
    .map((d) => ({ id: d.id, title: d.title, value: round2(d.value), stage: d.stage, stageLabel: STAGE_LABEL[d.stage], owner: d.owner, daysStale: d.daysStale }));

  return {
    from: fromStr, to: toStr,
    kpis: {
      openValue, openCount: open.length, weightedForecast,
      wonCount: wonInRange.length, wonValue,
      winRate, avgCycleDays, medianCycleDays, avgDealValue, medianDealValue,
      lostCount: lostInRange.length, lostValue: round2(lostInRange.reduce((s, d) => s + d.value, 0)),
    },
    pipeline: { byStage, openValue, weightedForecast },
    forecastModel: { sampleSize: probSample, priorStrength: PRIOR_STRENGTH, stages: probDetail },
    funnel,
    reps,
    trend,
    lost: { count: lostInRange.length, value: round2(lostInRange.reduce((s, d) => s + d.value, 0)), byReason: lostByReason },
    dealSize: { avg: avgDealValue, median: medianDealValue, bands: sizeBands, biggestOpen },
    engagement,
    stalled,
  };
}
