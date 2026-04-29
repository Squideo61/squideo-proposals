import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  if (req.method === 'GET' && req.query.view === 'leaderboard') {
    return leaderboard(res);
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

  res.status(405).end();
}

async function leaderboard(res) {
  const totals = await sql`
    SELECT
      COALESCE(NULLIF(p.data->>'preparedByEmail', ''), 'unknown') AS email,
      COUNT(*) AS created_count,
      COUNT(s.proposal_id) AS signed_count,
      COALESCE(SUM(
        CASE WHEN s.proposal_id IS NOT NULL
             THEN COALESCE((p.data->>'basePrice')::numeric, 0)
             ELSE 0 END
      ), 0) AS deal_value,
      COALESCE(SUM(pay.amount), 0) AS revenue_paid
    FROM proposals p
    LEFT JOIN signatures s ON s.proposal_id = p.id
    LEFT JOIN payments  pay ON pay.proposal_id = p.id
    GROUP BY 1
    ORDER BY signed_count DESC, created_count DESC
  `;

  const trend = await sql`
    SELECT
      COALESCE(NULLIF(p.data->>'preparedByEmail', ''), 'unknown') AS email,
      DATE_TRUNC('month', p.created_at) AS month,
      COUNT(*) AS created,
      COUNT(s.proposal_id) AS signed
    FROM proposals p
    LEFT JOIN signatures s ON s.proposal_id = p.id
    WHERE p.created_at >= NOW() - INTERVAL '12 months'
    GROUP BY 1, 2
    ORDER BY 2 ASC
  `;

  const users = await sql`SELECT email, name, avatar FROM users`;
  const userMap = Object.fromEntries(users.map(u => [u.email, u]));

  return res.status(200).json({
    totals: totals.map(r => {
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
    }),
    trend: trend.map(r => ({
      email: r.email,
      month: r.month,
      created: Number(r.created) || 0,
      signed: Number(r.signed) || 0,
    })),
  });
}
