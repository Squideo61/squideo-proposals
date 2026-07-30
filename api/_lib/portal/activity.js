// Customer-portal activity for the staff-side CRM: a login log (the one client
// event with no existing home) plus a stitched timeline that merges those logins
// with action breadcrumbs read straight from their authoritative domain
// timestamps (signatures, proposal_billing, deals.po_received_at, deal_files,
// deal_extras, project_videos.voiceover_selected_at, portal_company_files,
// quote_requests). Action events are never copied into portal_activity, so the
// log can't drift from the real records.
//
// Also derives the per-deal "steps completed" checklist (reusing the portal's own
// task engine) and a per-org rollup of it.

import sql from '../db.js';
import { makeId } from '../crm/shared.js';
import { ensurePortalTables } from './db.js';
import { computeDealTasks } from './taskContext.js';

// Geo + IP from Vercel's edge headers (same approach as email/view tracking).
function viewerFrom(req) {
  const h = (req && req.headers) || {};
  const ip = (h['x-forwarded-for'] || '').split(',')[0].trim() || h['x-real-ip'] || null;
  const country = h['x-vercel-ip-country'] || null;
  const region = h['x-vercel-ip-country-region'] || null;
  let city = h['x-vercel-ip-city'] || null;
  if (city) { try { city = decodeURIComponent(city); } catch { /* keep raw */ } }
  const ua = h['user-agent'] ? String(h['user-agent']).slice(0, 500) : null;
  return { ip, country, region, city, ua };
}

// Record a portal activity event (currently only 'login'). Best-effort — a
// logging hiccup must never break the client action that triggered it.
export async function logPortalActivity({ req = null, portalUserId, companyId = null, dealId = null, eventKey, detail = null }) {
  if (!portalUserId || !eventKey) return;
  try {
    await ensurePortalTables();
    const v = viewerFrom(req);
    await sql`
      INSERT INTO portal_activity
        (id, portal_user_id, company_id, deal_id, event_key, detail, ip, country, region, city, user_agent)
      VALUES
        (${makeId('pact')}, ${portalUserId}, ${companyId}, ${dealId}, ${eventKey},
         ${detail ? JSON.stringify(detail) : null}::jsonb, ${v.ip}, ${v.country}, ${v.region}, ${v.city}, ${v.ua})`;
  } catch (err) {
    console.warn('[portal] activity log failed', err.message);
  }
}

function locLabel(r) {
  return [r.city, r.country].filter(Boolean).join(', ') || null;
}

// A merged, newest-first timeline for one deal or one organisation. Logins come
// from portal_activity; every other event is read live from its domain table.
// Returns [{ type, at, actor, text, link, loc, ua }].
export async function portalTimeline({ companyId = null, dealId = null, limit = 40 } = {}) {
  await ensurePortalTables();

  // Resolve scope → the company (for login attribution) and the set of deals.
  let company = companyId;
  let dealIds = [];
  if (dealId) {
    const [d] = await sql`SELECT id, company_id FROM deals WHERE id = ${dealId}`;
    if (!d) return [];
    company = company || d.company_id;
    dealIds = [dealId];
  } else if (companyId) {
    const ds = await sql`SELECT id FROM deals WHERE company_id = ${companyId}`;
    dealIds = ds.map((r) => r.id);
  }
  const dealScope = !dealId; // company view labels each row with its deal

  const items = [];
  const push = (row) => { if (row && row.at) items.push(row); };

  // --- Logins (the whole point of portal_activity) ---
  if (company) {
    const memberIds = (await sql`SELECT portal_user_id FROM portal_memberships WHERE company_id = ${company}`)
      .map((r) => r.portal_user_id);
    if (memberIds.length) {
      const logins = await sql`
        SELECT a.created_at, a.ip, a.country, a.region, a.city, a.user_agent, pu.name, pu.email
          FROM portal_activity a JOIN portal_users pu ON pu.id = a.portal_user_id
         WHERE a.event_key = 'login' AND a.portal_user_id = ANY(${memberIds})
         ORDER BY a.created_at DESC LIMIT ${limit}`;
      for (const l of logins) {
        push({ type: 'login', at: l.created_at, actor: l.name || l.email || null, text: 'Logged in', link: null, loc: locLabel(l), ua: l.user_agent || null });
      }
    }
  }

  // --- Deal-scoped action breadcrumbs (from authoritative timestamps) ---
  if (dealIds.length) {
    const [signed, paid, pos, files, extras, voiceovers] = await Promise.all([
      sql`SELECT s.signed_at AS at, COALESCE(s.name, s.data->>'name') AS actor, p.deal_id, d.title
            FROM signatures s JOIN proposals p ON p.id = s.proposal_id JOIN deals d ON d.id = p.deal_id
           WHERE p.deal_id = ANY(${dealIds}) AND s.signed_at IS NOT NULL`,
      sql`SELECT pb.paid_at AS at, pb.paid_amount, p.deal_id, d.title
            FROM proposal_billing pb JOIN proposals p ON p.id = pb.proposal_id JOIN deals d ON d.id = p.deal_id
           WHERE p.deal_id = ANY(${dealIds}) AND pb.paid_at IS NOT NULL AND COALESCE(pb.paid_amount, 0) > 0`,
      sql`SELECT po_received_at AS at, po_number, id AS deal_id, title FROM deals
           WHERE id = ANY(${dealIds}) AND po_received_at IS NOT NULL`,
      sql`SELECT f.created_at AS at, f.filename, f.category, f.deal_id, d.title, pu.name AS actor
            FROM deal_files f JOIN deals d ON d.id = f.deal_id
            LEFT JOIN portal_users pu ON pu.id = f.portal_user_id
           WHERE f.deal_id = ANY(${dealIds}) AND f.source = 'portal'
           ORDER BY f.created_at DESC LIMIT ${limit}`
        .catch(() => []),
      sql`SELECT e.created_at AS at, e.description, e.amount, e.deal_id, d.title, pu.name AS actor
            FROM deal_extras e JOIN deals d ON d.id = e.deal_id
            LEFT JOIN portal_users pu ON pu.id = e.portal_user_id
           WHERE e.deal_id = ANY(${dealIds}) AND e.source = 'portal'
           ORDER BY e.created_at DESC LIMIT ${limit}`,
      sql`SELECT v.voiceover_selected_at AS at, v.title AS video_title, v.deal_id, d.title,
                 va.name AS artist, pu.name AS actor
            FROM project_videos v JOIN deals d ON d.id = v.deal_id
            LEFT JOIN voiceover_artists va ON va.id = v.voiceover_artist_id
            LEFT JOIN portal_users pu ON pu.id = v.voiceover_selected_by
           WHERE v.deal_id = ANY(${dealIds}) AND v.voiceover_selected_at IS NOT NULL`,
    ]);
    const suffix = (title) => (dealScope && title ? ` · ${title}` : '');
    const link = (id) => `#/deal/${id}`;
    for (const r of signed) push({ type: 'signed', at: r.at, actor: r.actor || null, text: `Signed the proposal${suffix(r.title)}`, link: link(r.deal_id) });
    for (const r of paid) push({ type: 'paid', at: r.at, actor: null, text: `Paid £${Number(r.paid_amount || 0).toFixed(2)}${suffix(r.title)}`, link: link(r.deal_id) });
    for (const r of pos) push({ type: 'po', at: r.at, actor: null, text: `Submitted PO ${r.po_number || ''}`.trim() + suffix(r.title), link: link(r.deal_id) });
    for (const r of files) {
      const what = r.category === 'script' ? 'a script' : r.category === 'visual_direction' ? 'visual direction' : null;
      push({
        type: 'file', at: r.at, actor: r.actor || null,
        text: what ? `Sent ${what}: ${r.filename}${suffix(r.title)}` : `Uploaded ${r.filename}${suffix(r.title)}`,
        link: link(r.deal_id),
      });
    }
    for (const r of extras) push({ type: 'extra', at: r.at, actor: r.actor || null, text: `Added an extra: ${r.description} (£${Number(r.amount || 0).toFixed(2)} ex VAT)`, link: link(r.deal_id) });
    for (const r of voiceovers) push({ type: 'voiceover', at: r.at, actor: r.actor || null, text: `Selected voiceover${r.artist ? ` — ${r.artist}` : ''}${r.video_title ? ` for ${r.video_title}` : ''}${suffix(r.title)}`, link: link(r.deal_id) });
  }

  // --- Company-only breadcrumbs (org brand files, joins, quote requests) ---
  if (!dealId && company) {
    const [brand, joined, quotes] = await Promise.all([
      sql`SELECT f.created_at AS at, f.filename, pu.name AS actor
            FROM portal_company_files f LEFT JOIN portal_users pu ON pu.id = f.uploaded_by_portal_user
           WHERE f.company_id = ${company} ORDER BY f.created_at DESC LIMIT ${limit}`,
      sql`SELECT m.created_at AS at, pu.name AS actor, pu.email
            FROM portal_memberships m JOIN portal_users pu ON pu.id = m.portal_user_id
           WHERE m.company_id = ${company}`,
      sql`SELECT created_at AS at, status FROM quote_requests
           WHERE company_id = ${company} ORDER BY created_at DESC LIMIT ${limit}`.catch(() => []),
    ]);
    for (const r of brand) push({ type: 'file', at: r.at, actor: r.actor || null, text: `Uploaded ${r.filename} to brand & documents`, link: '#/company/' + company });
    for (const r of joined) push({ type: 'joined', at: r.at, actor: r.actor || r.email || null, text: 'Joined the portal', link: null });
    for (const r of quotes) push({ type: 'quote', at: r.at, actor: null, text: 'Requested a new video (portal)', link: '#/quote-requests' });
  }

  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  return items.slice(0, limit);
}

// Every client's portal activity in one feed, newest first — the staff-side
// "what are they all doing in there" view.
//
// portalTimeline above answers "what has THIS client done", scoped to one
// company or deal and reading each action from its own domain table. This one
// is deliberately narrower in kind and wider in scope: it reads portal_activity
// (logins, page views, downloads), which is now the record of client *presence*
// in the portal. Actions still live on their own tables and show on the deal.
const ACTIVITY_LABELS = {
  login: 'Signed in',
  download: 'Downloaded a file',
};

const VIEW_LABELS = {
  home: 'Opened their dashboard',
  project: 'Opened a project',
  library: 'Browsed the video library',
  documents: 'Opened documents',
  extras: 'Looked at the extras on offer',
  voiceover: 'Opened the voiceover picker',
  kickoff: 'Opened the kick-off booking',
  script: 'Opened script & visual direction',
  request: 'Opened the new-video request',
  'video-credit': 'Looked at video credit',
  team: 'Opened their team',
  settings: 'Opened settings',
  review: 'Opened a video review',
  storyboard: 'Opened a storyboard review',
};

export async function portalActivityFeed({ limit = 100, companyId = null, before = null } = {}) {
  await ensurePortalTables();
  const rows = await sql`
    SELECT a.id, a.event_key, a.detail, a.created_at, a.deal_id,
           a.ip, a.country, a.region, a.city, a.user_agent,
           pu.name AS actor, pu.email AS actor_email,
           c.id AS company_id, c.name AS company_name,
           d.title AS deal_title
      FROM portal_activity a
      JOIN portal_users pu ON pu.id = a.portal_user_id
      LEFT JOIN companies c ON c.id = a.company_id
      LEFT JOIN deals d ON d.id = a.deal_id
     WHERE (${companyId}::text IS NULL OR a.company_id = ${companyId})
       AND (${before}::timestamptz IS NULL OR a.created_at < ${before})
     ORDER BY a.created_at DESC
     LIMIT ${Math.min(Number(limit) || 100, 300)}
  `.catch(() => []);

  return rows.map((r) => {
    const view = r.detail && typeof r.detail === 'object' ? r.detail.view : null;
    const text = r.event_key === 'view'
      ? (VIEW_LABELS[view] || 'Opened the portal')
      : (ACTIVITY_LABELS[r.event_key] || r.event_key);
    return {
      id: r.id,
      type: r.event_key,
      at: r.created_at,
      actor: r.actor || r.actor_email || null,
      actorEmail: r.actor_email || null,
      companyId: r.company_id || null,
      companyName: r.company_name || null,
      dealId: r.deal_id || null,
      dealTitle: r.deal_title || null,
      text: text + (r.deal_title ? ` · ${r.deal_title}` : ''),
      loc: locLabel(r),
      ua: r.user_agent || null,
    };
  });
}

// The ordered "steps completed" checklist for one deal: sign → deposit/PO →
// kick-off tasks (brand / voiceover / kick-off call). Reuses the portal's own
// task engine so applicability (PO route, whether a voiceover is included, etc.)
// stays in one place. Returns [{ key, label, done, at, current }].
export async function dealSteps(dealId) {
  const ctx = await computeDealTasks(dealId);
  if (!ctx) return [];
  const { deal, tasks } = ctx;

  const [[sig], [dep], [d2], [kb]] = await Promise.all([
    sql`SELECT s.signed_at, COALESCE(s.data->>'paymentOption', '') AS pay_option
          FROM signatures s JOIN proposals p ON p.id = s.proposal_id
         WHERE p.deal_id = ${dealId} AND s.signed_at IS NOT NULL
         ORDER BY s.signed_at ASC LIMIT 1`,
    sql`SELECT pb.paid_at FROM proposal_billing pb JOIN proposals p ON p.id = pb.proposal_id
         WHERE p.deal_id = ${dealId} AND pb.paid_at IS NOT NULL AND COALESCE(pb.paid_amount, 0) > 0
         ORDER BY pb.paid_at ASC LIMIT 1`,
    sql`SELECT po_number, po_received_at, payment_terms FROM deals WHERE id = ${dealId}`,
    // The current confirmed kick-off booking. A reschedule cancels the old row
    // and books a new one, so the most-recently-created confirmed booking is
    // always the live time — this keeps the step in step with any reschedule.
    sql`SELECT starts_at, ends_at, meet_url, client_timezone
          FROM intro_call_bookings
         WHERE deal_id = ${dealId} AND kind = 'kickoff' AND status = 'confirmed'
         ORDER BY created_at DESC LIMIT 1`.catch(() => []),
  ]);

  const steps = [];
  steps.push({ key: 'signed', label: 'Signed the proposal', done: !!sig?.signed_at, at: sig?.signed_at || null });
  const isPo = sig?.pay_option === 'po' || d2?.payment_terms === 'po';
  if (isPo) {
    steps.push({ key: 'po', label: 'Submitted purchase order', done: !!d2?.po_number, at: d2?.po_received_at || null });
  } else {
    steps.push({ key: 'deposit', label: 'Paid the deposit', done: !!dep?.paid_at, at: dep?.paid_at || null });
  }
  // The launched kick-off tasks (skip 'po' — handled above as a milestone).
  for (const t of tasks) {
    if (t.key === 'po') continue;
    const step = { key: t.key, label: t.title, done: t.status === 'done', at: null };
    // Surface the booked kick-off time + join link so staff can see (and join)
    // the call straight from the step. Updates automatically when rescheduled.
    if (t.key === 'kickoff' && kb?.starts_at) {
      step.meeting = {
        startsAt: kb.starts_at,
        endsAt: kb.ends_at || null,
        joinUrl: kb.meet_url || null,
        timezone: kb.client_timezone || null,
      };
    }
    steps.push(step);
  }
  const current = steps.find((s) => !s.done);
  if (current) current.current = true;
  return steps;
}

// Per-org rollup: each of the company's in-flight deals with its step progress,
// for the organisation page. Bounded to the most recent handful of live deals.
export async function companyStepsSummary(companyId) {
  if (!companyId) return [];
  const deals = await sql`
    SELECT id, title FROM deals
     WHERE company_id = ${companyId}
       AND (stage IN ('signed', 'paid') OR production_phase IS NOT NULL)
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 8`;
  // Compute each deal's checklist concurrently (each dealSteps is several
  // queries — sequential would stack up round-trips on the org page).
  const summaries = await Promise.all(deals.map(async (d) => {
    const steps = await dealSteps(d.id).catch(() => []);
    if (!steps.length) return null;
    const done = steps.filter((s) => s.done).length;
    const current = steps.find((s) => s.current);
    return { dealId: d.id, title: d.title, done, total: steps.length, currentLabel: current?.label || null };
  }));
  return summaries.filter(Boolean);
}
