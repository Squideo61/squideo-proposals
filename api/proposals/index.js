import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

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
