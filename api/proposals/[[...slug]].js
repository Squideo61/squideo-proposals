import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // [[...slug]] is an optional catch-all — `slug` is undefined for the
  // collection route (/api/proposals) and an array like ['abc'] for the
  // item route (/api/proposals/abc).
  const raw = req.query.slug;
  const id = Array.isArray(raw) ? raw[0] : (typeof raw === 'string' ? raw : null);

  // ── Collection routes (/api/proposals) ──────────────────────────────────
  if (!id) {
    const user = await requireAuth(req, res);
    if (!user) return;

    if (req.method === 'GET' && req.query.view === 'leaderboard') {
      return leaderboard(req, res);
    }

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT p.id, p.data, p.created_at, p.updated_at,
               p.number_year, p.number_seq,
               COALESCE(v.opens, 0)    AS view_opens,
               COALESCE(v.duration, 0) AS view_duration,
               v.last_active_at        AS view_last_active
        FROM proposals p
        LEFT JOIN (
          SELECT proposal_id,
                 COUNT(*)               AS opens,
                 SUM(duration_seconds)  AS duration,
                 MAX(last_active_at)    AS last_active_at
          FROM proposal_views
          GROUP BY proposal_id
        ) v ON v.proposal_id = p.id
        ORDER BY p.created_at DESC
      `;
      const proposals = {};
      for (const row of rows) {
        proposals[row.id] = {
          ...row.data,
          _createdAt: row.created_at,
          _number: row.number_year && row.number_seq
            ? { year: row.number_year, seq: row.number_seq }
            : null,
          _views: {
            opens: Number(row.view_opens) || 0,
            duration: Number(row.view_duration) || 0,
            lastActiveAt: row.view_last_active || null,
          },
        };
      }
      return res.status(200).json(proposals);
    }

    return res.status(405).end();
  }

  // ── Item routes (/api/proposals/:id) ────────────────────────────────────

  // GET is public so clients can view their proposal
  if (req.method === 'GET') {
    const rows = await sql`
      SELECT data, number_year, number_seq
      FROM proposals WHERE id = ${id}
    `;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    return res.status(200).json({
      ...r.data,
      _number: r.number_year && r.number_seq ? { year: r.number_year, seq: r.number_seq } : null,
    });
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  if (req.method === 'PUT') {
    const data = req.body;
    const y = new Date().getFullYear();
    await sql`
      INSERT INTO proposals (id, data, updated_at, number_year, number_seq)
      VALUES (
        ${id}, ${JSON.stringify(data)}, NOW(), ${y},
        COALESCE(
          (SELECT MAX(number_seq) + 1 FROM proposals WHERE number_year = ${y}),
          1
        )
      )
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `;
    const rows = await sql`SELECT number_year, number_seq FROM proposals WHERE id = ${id}`;
    const n = rows[0];
    return res.status(200).json({
      ok: true,
      number: n && n.number_year && n.number_seq ? { year: n.number_year, seq: n.number_seq } : null,
    });
  }

  if (req.method === 'DELETE') {
    await sql`DELETE FROM proposals WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}

async function leaderboard(req, res) {
  const rangeIn = String(req.query.range || 'month').toLowerCase();
  const range = ['month', 'year', 'all'].includes(rangeIn) ? rangeIn : 'month';

  const now = new Date();
  let start;
  let grain;
  let periodLabel;
  if (range === 'month') {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    grain = 'day';
    periodLabel = now.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  } else if (range === 'year') {
    start = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate()));
    grain = 'month';
    periodLabel = 'Past 12 months';
  } else {
    start = new Date(0);
    grain = 'month';
    periodLabel = 'All time';
  }
  const startISO = start.toISOString();

  const totals = await sql`
    SELECT
      COALESCE(NULLIF(p.data->>'preparedByEmail', ''), 'unknown') AS email,
      COUNT(*) FILTER (WHERE p.created_at >= ${startISO}) AS created_count,
      COUNT(s.proposal_id) FILTER (WHERE s.signed_at >= ${startISO}) AS signed_count,
      COALESCE(SUM(
        CASE WHEN s.signed_at >= ${startISO}
             THEN COALESCE((p.data->>'basePrice')::numeric, 0)
             ELSE 0 END
      ), 0) AS deal_value,
      COALESCE(SUM(pay.amount) FILTER (WHERE pay.paid_at >= ${startISO}), 0) AS revenue_paid
    FROM proposals p
    LEFT JOIN signatures s ON s.proposal_id = p.id
    LEFT JOIN payments  pay ON pay.proposal_id = p.id
    GROUP BY 1
    ORDER BY signed_count DESC, created_count DESC, deal_value DESC
  `;

  const createdTrend = grain === 'day'
    ? await sql`
        SELECT
          COALESCE(NULLIF(p.data->>'preparedByEmail', ''), 'unknown') AS email,
          DATE_TRUNC('day', p.created_at) AS bucket,
          COUNT(*) AS count
        FROM proposals p
        WHERE p.created_at >= ${startISO}
        GROUP BY 1, 2
        ORDER BY 2 ASC
      `
    : await sql`
        SELECT
          COALESCE(NULLIF(p.data->>'preparedByEmail', ''), 'unknown') AS email,
          DATE_TRUNC('month', p.created_at) AS bucket,
          COUNT(*) AS count
        FROM proposals p
        WHERE p.created_at >= ${startISO}
        GROUP BY 1, 2
        ORDER BY 2 ASC
      `;

  const signedTrend = grain === 'day'
    ? await sql`
        SELECT
          COALESCE(NULLIF(p.data->>'preparedByEmail', ''), 'unknown') AS email,
          DATE_TRUNC('day', s.signed_at) AS bucket,
          COUNT(*) AS count
        FROM signatures s
        JOIN proposals p ON p.id = s.proposal_id
        WHERE s.signed_at >= ${startISO}
        GROUP BY 1, 2
        ORDER BY 2 ASC
      `
    : await sql`
        SELECT
          COALESCE(NULLIF(p.data->>'preparedByEmail', ''), 'unknown') AS email,
          DATE_TRUNC('month', s.signed_at) AS bucket,
          COUNT(*) AS count
        FROM signatures s
        JOIN proposals p ON p.id = s.proposal_id
        WHERE s.signed_at >= ${startISO}
        GROUP BY 1, 2
        ORDER BY 2 ASC
      `;

  const users = await sql`SELECT email, name, avatar FROM users`;
  const userMap = Object.fromEntries(users.map(u => [u.email, u]));

  const totalsOut = totals
    .map(r => {
      const u = userMap[r.email];
      return {
        email: r.email,
        name: u?.name || r.email,
        avatar: u?.avatar || null,
        created: Number(r.created_count) || 0,
        signed: Number(r.signed_count) || 0,
        dealValue: Number(r.deal_value) || 0,
        revenuePaid: Number(r.revenue_paid) || 0,
      };
    })
    .filter(t => t.created > 0 || t.signed > 0 || t.revenuePaid > 0);

  return res.status(200).json({
    range,
    grain,
    periodLabel,
    startISO,
    totals: totalsOut,
    createdTrend: createdTrend.map(r => ({
      email: r.email,
      bucket: r.bucket,
      count: Number(r.count) || 0,
    })),
    signedTrend: signedTrend.map(r => ({
      email: r.email,
      bucket: r.bucket,
      count: Number(r.count) || 0,
    })),
  });
}
