// POST  /api/views/[id]   body: { sessionId, durationSeconds? }   public
// GET   /api/views/[id]                                            requires auth
import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';
import { sendMail, firstViewHtml, APP_URL } from '../_lib/email.js';

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
    const sessionId = body.sessionId;
    const durationSeconds = Number(body.durationSeconds) || 0;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

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

    const existing = await sql`SELECT 1 FROM proposal_views WHERE proposal_id = ${id} LIMIT 1`;
    const isFirstEver = existing.length === 0;

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

    if (isFirstEver) {
      try {
        const rows = await sql`SELECT data FROM proposals WHERE id = ${id}`;
        if (rows.length) {
          const data = rows[0].data || {};
          const ownerEmail = data.preparedByEmail || null;
          if (ownerEmail) {
            const title = data.proposalTitle || data.clientName || 'Your proposal';
            const link = `${APP_URL}/?proposal=${id}`;
            await sendMail({
              to: ownerEmail,
              subject: `${data.clientName || 'A client'} just opened "${title}"`,
              html: firstViewHtml({ title, clientName: data.clientName, country, city, link }),
              text: `${data.clientName || 'A client'} opened ${title}. ${link}`,
            });
          }
        }
      } catch (err) {
        console.error('[views] first-view email failed', err);
      }
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
