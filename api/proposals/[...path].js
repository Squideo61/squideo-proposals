// Consolidated proposals endpoint. Handles:
//   GET    /api/proposals                 — list (auth)
//   GET    /api/proposals?view=leaderboard — leaderboard (auth)
//   GET    /api/proposals/:id             — public single read
//   PUT    /api/proposals/:id             — save + auto-create-deal (auth)
//   DELETE /api/proposals/:id             — delete (auth)
import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

// Allowlist of fields the public client view (ClientView + ThankYouView +
// SignedBlock + printProposal) actually consumes. The full `data` JSONB on
// `proposals` is auth-only — anything not enumerated here must not leak to the
// unauthenticated GET. Add new fields explicitly as the client viewer evolves.
const PUBLIC_PROPOSAL_FIELDS = [
  'clientName', 'contactBusinessName', 'clientLogo',
  'proposalTitle', 'date', 'expiryDate', 'validityDays',
  'preparedBy', 'preparedByTitle', 'preparedByEmail',
  'intro', 'team', 'requirement', 'projectVision',
  'basePrice', 'videoOptions', 'baseInclusions', 'optionalExtras',
  'partnerProgramme',
  'processVideoUrl', 'showProcessVideo',
  'vatRate', 'paymentOptions', 'paymentOptionDescs',
];

function publicProposalView(data) {
  const src = data || {};
  const out = {};
  for (const k of PUBLIC_PROPOSAL_FIELDS) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse the proposal id from req.url directly (Vercel's req.query.path has
  // proven unreliable for non-optional catch-all routes). The parent route
  // /api/proposals is rewritten in vercel.json to /api/proposals/_root, which
  // we treat as the no-id collection request.
  const urlPath = (req.url || '').split('?')[0];
  const segs = urlPath.split('/').filter(Boolean).slice(2); // strip 'api', 'proposals'
  const first = segs[0] || null;
  const id = first === '_root' ? null : first;

  // --- Collection routes (no id) ---
  if (!id) {
    if (req.method !== 'GET') return res.status(405).end();
    const user = await requireAuth(req, res);
    if (!user) return;
    if (req.query.view === 'leaderboard') return leaderboard(req, res);
    return list(req, res);
  }

  // --- Item routes (with id) ---

  if (req.method === 'GET') {
    // Public — clients read their proposal without auth.
    const rows = await sql`
      SELECT data, number_year, number_seq, deal_id
      FROM proposals WHERE id = ${id}
    `;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    return res.status(200).json({
      ...publicProposalView(r.data),
      _number: r.number_year && r.number_seq ? { year: r.number_year, seq: r.number_seq } : null,
      _dealId: r.deal_id || null,
    });
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  if (req.method === 'PUT') {
    const body = req.body || {};
    // `_dealId` is a side-channel pre-link from the caller (e.g. the CRM
    // "create proposal from deal" button). It's not part of the proposal's
    // own data — pull it out before we persist.
    const presetDealId = typeof body._dealId === 'string' && body._dealId ? body._dealId : null;
    const presetContactId = typeof body._contactId === 'string' && body._contactId ? body._contactId : null;
    const data = { ...body };
    delete data._dealId;
    delete data._contactId;
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
    // If the caller pre-linked a deal, set deal_id BEFORE the auto-create
    // block below runs — that's what suppresses the auto-deal creation.
    if (presetDealId) {
      await sql`
        UPDATE proposals SET deal_id = ${presetDealId}
        WHERE id = ${id} AND deal_id IS NULL
      `;
    }

    // Auto-create-deal on first save, then keep the deal's value + title in
    // sync with the proposal on every subsequent save so editing basePrice
    // doesn't leave a stale £1,250 (the DEFAULT_PROPOSAL price) on the deal.
    // We only sync when the deal id matches the auto-created form
    // (`deal_<proposalId>`) so a manually-created deal that someone later
    // linked to this proposal keeps its hand-set value.
    let createdDealId = null;
    try {
      const meta = await sql`SELECT deal_id FROM proposals WHERE id = ${id}`;
      const hasDeal = !!meta[0]?.deal_id;
      const expectedAutoDealId = 'deal_' + id;
      const title = (data.contactBusinessName || data.clientName || 'Untitled deal').toString().slice(0, 200);
      const ownerEmail = data.preparedByEmail || user.email || null;
      const value = Number.isFinite(Number(data.basePrice)) ? Number(data.basePrice) : null;

      if (!hasDeal) {
        const inserted = await sql`
          INSERT INTO deals (id, title, primary_contact_id, owner_email, stage, value, last_activity_at)
          VALUES (${expectedAutoDealId}, ${title}, ${presetContactId}, ${ownerEmail}, 'proposal_sent', ${value}, NOW())
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `;
        if (inserted.length) {
          await sql`
            INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
            VALUES (${expectedAutoDealId}, 'deal_created', ${JSON.stringify({ source: 'proposal', proposalId: id, title })}, ${user.email || null})
          `;
          createdDealId = expectedAutoDealId;
        }
        await sql`UPDATE proposals SET deal_id = ${expectedAutoDealId} WHERE id = ${id} AND deal_id IS NULL`;
      } else if (meta[0].deal_id === expectedAutoDealId) {
        await sql`
          UPDATE deals
             SET title = ${title},
                 value = ${value},
                 primary_contact_id = COALESCE(primary_contact_id, ${presetContactId}),
                 updated_at = NOW()
           WHERE id = ${expectedAutoDealId}
        `;
      }
    } catch (err) {
      console.error('[proposals] auto-create deal failed', err);
    }

    const rows = await sql`SELECT number_year, number_seq, deal_id FROM proposals WHERE id = ${id}`;
    const n = rows[0];
    return res.status(200).json({
      ok: true,
      number: n && n.number_year && n.number_seq ? { year: n.number_year, seq: n.number_seq } : null,
      dealId: n?.deal_id || null,
      dealCreated: !!createdDealId,
    });
  }

  if (req.method === 'DELETE') {
    // Admins can delete anything. Members can delete proposals they own
    // (preparedByEmail matches their login) so they can clean up their own
    // mistakes without pulling an admin in.
    if (user.role !== 'admin') {
      const rows = await sql`SELECT data->>'preparedByEmail' AS owner FROM proposals WHERE id = ${id}`;
      const owner = rows[0]?.owner || null;
      if (!owner || !user.email || owner.toLowerCase() !== user.email.toLowerCase()) {
        return res.status(403).json({ error: 'You can only delete proposals you created' });
      }
    }
    await sql`DELETE FROM proposals WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
}

async function list(req, res) {
  const rows = await sql`
    SELECT p.id, p.data, p.created_at, p.updated_at,
           p.number_year, p.number_seq, p.deal_id,
           COALESCE(v.opens, 0)    AS view_opens,
           COALESCE(v.duration, 0) AS view_duration,
           v.last_active_at        AS view_last_active,
           pb.xero_invoice_id      AS billing_invoice_id,
           pb.xero_quote_id        AS billing_quote_id
    FROM proposals p
    LEFT JOIN (
      SELECT proposal_id,
             COUNT(*)               AS opens,
             SUM(duration_seconds)  AS duration,
             MAX(last_active_at)    AS last_active_at
      FROM proposal_views
      GROUP BY proposal_id
    ) v ON v.proposal_id = p.id
    LEFT JOIN proposal_billing pb ON pb.proposal_id = p.id
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
      _dealId: row.deal_id || null,
      _views: {
        opens: Number(row.view_opens) || 0,
        duration: Number(row.view_duration) || 0,
        lastActiveAt: row.view_last_active || null,
      },
      _hasXeroInvoice: !!row.billing_invoice_id,
      _hasXeroQuote: !!row.billing_quote_id,
    };
  }
  return res.status(200).json(proposals);
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
