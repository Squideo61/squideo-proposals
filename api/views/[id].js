// POST  /api/views/[id]   body: { sessionId, durationSeconds? }   public
// GET   /api/views/[id]                                            requires auth
import sql from '../_lib/db.js';
import { cors, requireAuth, optionalAuth } from '../_lib/middleware.js';
import { sendNotification, ensureTrackingNotificationDefaults } from '../_lib/notifications.js';
import { advanceStage, dealIdForProposal } from '../_lib/dealStage.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 64) : null;
    const durationSeconds = Math.max(0, Math.min(86400, Number(body.durationSeconds) || 0));
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    // A logged-in team member previewing the proposal (same-origin cookie) is not
    // a client — don't record the view, alert, or advance the deal. This is why
    // "Catherine Major opened it" fired for an internal reviewer. Clients have no
    // CRM account so they're never authenticated here.
    const internalViewer = await optionalAuth(req).catch(() => null);
    if (internalViewer) return res.status(200).json({ ok: true, internal: true });

    const h = req.headers;
    const ip =
      (h['x-forwarded-for'] || '').split(',')[0].trim() ||
      h['x-real-ip'] ||
      null;
    const country = h['x-vercel-ip-country'] || null;
    const region = h['x-vercel-ip-country-region'] || null;
    const cityRaw = h['x-vercel-ip-city'];
    let city = null;
    if (cityRaw) {
      try { city = decodeURIComponent(cityRaw); } catch { city = cityRaw; }
    }
    const ua = h['user-agent'] || null;

    await sql`
      INSERT INTO proposal_views
        (proposal_id, session_id, opened_at, last_active_at, duration_seconds,
         ip_address, country, region, city, user_agent)
      VALUES
        (${id}, ${sessionId}, NOW(), NOW(), ${durationSeconds},
         ${ip}, ${country}, ${region}, ${city}, ${ua})
      ON CONFLICT (proposal_id, session_id) DO UPDATE SET
        last_active_at   = NOW(),
        duration_seconds = GREATEST(proposal_views.duration_seconds, EXCLUDED.duration_seconds)
    `;

    // Race-safe claim: only one caller can flip first_view_emailed_at from
    // NULL to NOW(). Concurrent POSTs (and the per-15s heartbeats) that lose the
    // race get 0 rows back and skip the alert, so the owner is notified exactly
    // ONCE per proposal — not once per viewer session. A client whose browser
    // doesn't persist localStorage (mail in-app webviews, privacy mode) churns
    // through fresh session ids and would otherwise re-fire the alert on every
    // remount; the single atomic claim makes that impossible.
    const claim = await sql`
      UPDATE proposals
      SET first_view_emailed_at = NOW()
      WHERE id = ${id} AND first_view_emailed_at IS NULL
      RETURNING id
    `;
    const isFirstEver = claim.length > 0;

    if (isFirstEver) {
      try {
        const rows = await sql`SELECT data FROM proposals WHERE id = ${id}`;
        if (rows.length) {
          const data = rows[0].data || {};
          const ownerEmail = data.preparedByEmail || null;
          const title = data.proposalTitle || data.clientName || 'Your proposal';
          // The "just opened your proposal" email alert was removed — the in-app
          // tracking-bell notification below covers first-view alerts. We still
          // claim first_view_emailed_at above so this block fires exactly once.
          // Engagement feed: one tracking-bell alert (in-app + desktop push, no
          // email) the first time the proposal is opened. Owner-scoped.
          if (ownerEmail) {
            const where = city || country || null;
            const dealId = await dealIdForProposal(id).catch(() => null);
            await ensureTrackingNotificationDefaults();
            await sendNotification('tracking.proposal_opened', {
              ownerEmail,
              inAppOnly: true,
              subject: `Proposal opened: ${title}`,
              inApp: {
                title: `Proposal opened: ${title}`,
                body: `${data.clientName || 'Someone'} opened it${where ? ' · ' + where : ''}`,
                link: dealId ? `#/deal/${dealId}` : null,
                tag: `proposal-open-${id}`,
              },
            });
          }
        }
      } catch (err) {
        console.error('[views] view notification failed', err);
      }
    }

    // CRM: advance deal to 'viewed' on every view. The ratchet rule prevents
    // downgrading a deal that's already further along (signed/paid).
    try {
      const dealId = await dealIdForProposal(id);
      if (dealId) {
        await advanceStage(dealId, 'viewed', { payload: { proposalId: id, sessionId } });
      }
    } catch (err) {
      console.error('[views] advanceStage failed', err);
    }

    return res.status(200).json({ ok: true });
  }

  if (req.method === 'GET') {
    const user = await requireAuth(req, res);
    if (!user) return;
    const rows = await sql`
      SELECT session_id, opened_at, last_active_at, duration_seconds,
             ip_address, country, region, city, user_agent
      FROM proposal_views
      WHERE proposal_id = ${id}
      ORDER BY opened_at DESC
    `;
    return res.status(200).json(rows);
  }

  res.status(405).end();
}
