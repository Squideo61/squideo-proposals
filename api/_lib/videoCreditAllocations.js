// Assigning a client's video credit to a specific video — including one that
// hasn't started, on a project that hasn't started.
//
// A production manager needs to be able to say "this client has 20 minutes of
// credit; 6 of them are for the brand film we haven't begun yet". Until now
// there was nowhere to record that: portal-bought credit sat as one
// company-wide number, and the only per-video credit mechanism belonged to a
// deal's own credit-based project (project_retainers), which not every deal
// has.
//
// A reservation here holds minutes OUT of the client's AVAILABLE balance
// without marking them used, so the portal can honestly show
// "12 available · 6 reserved for Brand film · 4 used". When the video is signed
// off the reservation is settled: a normal partner-ledger work row is written
// and the reservation flips to 'spent', which is the point the client's "used"
// figure moves. Nothing is counted twice — a reserved row has no ledger row
// yet, and a spent one is no longer reserved.
//
// Scope: this draws on the PARTNER ledger (partner credits + portal video-credit
// purchases). A deal that has its own credit-based project already assigns
// credit per video through project_retainer_entries, and that path is left
// exactly as it was; see companyCreditTotals for why the two ledgers coexist.

import sql from './db.js';
import { makeId } from './crm/shared.js';
import { isVideoSignedOff } from './productionStages.js';

// Runtime self-heal for db/migrations/20260901_video_credit_allocations.sql.
// Never rejects: an ensure() that throws takes every caller down with it, and
// this one sits under the deal page, the board and the client portal.
let ensured = null;
export function ensureVideoCreditAllocations() {
  if (ensured) return ensured;
  ensured = (async () => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS video_credit_allocations (
          id          TEXT        PRIMARY KEY,
          video_id    TEXT        NOT NULL REFERENCES project_videos(id) ON DELETE CASCADE,
          deal_id     TEXT        NOT NULL,
          company_id  TEXT        NOT NULL,
          minutes     NUMERIC     NOT NULL CHECK (minutes > 0),
          status      TEXT        NOT NULL DEFAULT 'reserved',
          note        TEXT,
          assigned_by TEXT,
          spent_at    TIMESTAMPTZ,
          released_at TIMESTAMPTZ,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS video_credit_allocations_video_open_idx
                  ON video_credit_allocations(video_id) WHERE status <> 'released'`;
      await sql`CREATE INDEX IF NOT EXISTS video_credit_allocations_company_idx
                  ON video_credit_allocations(company_id, status)`;
      await sql`CREATE INDEX IF NOT EXISTS video_credit_allocations_deal_idx
                  ON video_credit_allocations(deal_id, status)`;
    } catch (err) {
      // Let a later call retry rather than caching the failure forever.
      ensured = null;
      console.warn('[videoCreditAllocations] ensure failed', err.message);
    }
  })();
  return ensured;
}

const num = (v) => Math.round((Number(v) || 0) * 100) / 100;

// ─── Reads ───────────────────────────────────────────────────────────────────

// Reserved (not yet spent) minutes per company. Used by companyCreditTotals so
// every surface that shows a balance subtracts the same commitments.
export async function reservedMinutesFor(companyIds = null) {
  await ensureVideoCreditAllocations();
  const ids = companyIds && companyIds.length ? companyIds : null;
  const rows = await sql`
    SELECT company_id, COALESCE(SUM(minutes), 0) AS minutes
      FROM video_credit_allocations
     WHERE status = 'reserved'
       AND (${ids}::text[] IS NULL OR company_id = ANY(${ids}::text[]))
     GROUP BY company_id
  `.catch(() => []);
  return new Map(rows.map((r) => [r.company_id, num(r.minutes)]));
}

export async function reservedMinutesForCompany(companyId) {
  if (!companyId) return 0;
  const map = await reservedMinutesFor([companyId]);
  return map.get(companyId) || 0;
}

function serialiseAllocation(r) {
  return {
    id: r.id,
    videoId: r.video_id,
    dealId: r.deal_id,
    companyId: r.company_id,
    minutes: num(r.minutes),
    status: r.status,
    note: r.note || null,
    assignedBy: r.assigned_by || null,
    spentAt: r.spent_at || null,
    createdAt: r.created_at,
    videoTitle: r.video_title || null,
    videoNumber: r.video_number == null ? null : Number(r.video_number),
    productionPhase: r.production_phase || null,
    productionStage: r.production_stage || null,
    // A video with no board position is one the team has planned but not
    // started — which is exactly the case this feature exists for, so it's
    // called out rather than left as a null stage.
    planned: !r.production_phase,
    projectTitle: r.project_title || null,
    projectReference: r.project_reference || null,
  };
}

// Every live (reserved or spent) allocation for a company or a deal, annotated
// with the video and project it belongs to. Powers both the CRM card and the
// client's portal list, so the two can't describe the same commitments
// differently.
export async function listVideoCreditAllocations({ companyId = null, dealId = null } = {}) {
  await ensureVideoCreditAllocations();
  if (!companyId && !dealId) return [];
  const rows = await sql`
    SELECT a.*, pv.title AS video_title, pv.video_number,
           pv.production_phase, pv.production_stage,
           d.title AS project_title, d.reference AS project_reference
      FROM video_credit_allocations a
      JOIN project_videos pv ON pv.id = a.video_id
      JOIN deals d ON d.id = a.deal_id
     WHERE a.status <> 'released'
       AND (${companyId}::text IS NULL OR a.company_id = ${companyId})
       AND (${dealId}::text IS NULL OR a.deal_id = ${dealId})
     ORDER BY a.status ASC, a.created_at DESC
  `.catch(() => []);
  return rows.map(serialiseAllocation);
}

// video id → allocation, for decorating a list of videos (deal page, board).
export async function allocationsByVideo(videoIds = []) {
  await ensureVideoCreditAllocations();
  const ids = (videoIds || []).filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await sql`
    SELECT * FROM video_credit_allocations
     WHERE video_id = ANY(${ids}) AND status <> 'released'
  `.catch(() => []);
  return new Map(rows.map((r) => [r.video_id, serialiseAllocation(r)]));
}

// ─── Writes ──────────────────────────────────────────────────────────────────

// What's left to hand out: the company's partner-ledger balance minus everything
// already reserved. `excludeVideoId` leaves the video being edited out of the
// reserved figure, so re-assigning 6 min to a video that already holds 4 needs
// only 2 more to be free rather than the full 6.
export async function availableForCompany(companyId, { excludeVideoId = null } = {}) {
  if (!companyId) return { remaining: 0, reserved: 0, available: 0 };
  const { companyCreditTotals } = await import('./partnerCredits.js');
  const totals = await companyCreditTotals(companyId).catch(() => null);
  // Only the partner ledger is spendable this way — a deal's own credit project
  // is assigned per video through project_retainer_entries instead.
  const remaining = num(totals?.partner?.remaining || 0);
  let reserved = await reservedMinutesForCompany(companyId);
  if (excludeVideoId) {
    const mine = (await allocationsByVideo([excludeVideoId])).get(excludeVideoId);
    if (mine && mine.status === 'reserved') reserved = num(reserved - mine.minutes);
  }
  return { remaining, reserved, available: num(remaining - reserved) };
}

// Assign (or re-assign) minutes of the client's credit to one video. Passing 0
// releases whatever was assigned. Throws with a .status for the route to relay.
export async function setVideoCreditAllocation({ videoId, minutes, user = null, note = null }) {
  await ensureVideoCreditAllocations();
  const m = num(minutes);
  if (!Number.isFinite(m) || m < 0) { const e = new Error('Minutes must be zero or more'); e.status = 400; throw e; }

  const [v] = await sql`
    SELECT pv.id, pv.deal_id, pv.title, d.company_id
      FROM project_videos pv JOIN deals d ON d.id = pv.deal_id
     WHERE pv.id = ${videoId}`;
  if (!v) { const e = new Error('Video not found'); e.status = 404; throw e; }
  if (!v.company_id) {
    const e = new Error('This project has no customer attached, so there is no credit balance to draw on.');
    e.status = 400; throw e;
  }

  if (m === 0) { await releaseVideoCreditAllocation(videoId, user); return null; }

  const [existing] = await sql`
    SELECT * FROM video_credit_allocations WHERE video_id = ${videoId} AND status <> 'released'`;
  if (existing?.status === 'spent') {
    const e = new Error('This video has already drawn its credit down, so it can no longer be changed.');
    e.status = 409; throw e;
  }

  const { available } = await availableForCompany(v.company_id, { excludeVideoId: videoId });
  if (m > available) {
    const e = new Error(`Only ${available} min of credit is free — the rest is already reserved or used.`);
    e.status = 400; throw e;
  }

  if (existing) {
    await sql`
      UPDATE video_credit_allocations
         SET minutes = ${m}, note = ${note},
             assigned_by = ${user?.email || existing.assigned_by || null}, updated_at = NOW()
       WHERE id = ${existing.id}`;
  } else {
    await sql`
      INSERT INTO video_credit_allocations
        (id, video_id, deal_id, company_id, minutes, status, note, assigned_by)
      VALUES
        (${makeId('vca')}, ${videoId}, ${v.deal_id}, ${v.company_id}, ${m}, 'reserved', ${note}, ${user?.email || null})`;
  }
  const [row] = await sql`
    SELECT a.*, pv.title AS video_title, pv.video_number, pv.production_phase, pv.production_stage
      FROM video_credit_allocations a JOIN project_videos pv ON pv.id = a.video_id
     WHERE a.video_id = ${videoId} AND a.status <> 'released'`;
  return row ? serialiseAllocation(row) : null;
}

// Hand reserved minutes back to the balance. Spent allocations are left alone —
// that credit is gone, and pretending otherwise would silently re-issue it.
export async function releaseVideoCreditAllocation(videoId, user = null) {
  await ensureVideoCreditAllocations();
  await sql`
    UPDATE video_credit_allocations
       SET status = 'released', released_at = NOW(), updated_at = NOW(),
           assigned_by = COALESCE(${user?.email || null}, assigned_by)
     WHERE video_id = ${videoId} AND status = 'reserved'`;
  return null;
}

// ─── Settlement ──────────────────────────────────────────────────────────────

// Convert a signed-off video's reservation into an actual draw-down: write the
// partner-ledger work row (idempotent on source_ref) and mark the reservation
// spent. This is the moment the client's "used" figure moves.
//
// Called two ways: directly when a video is moved to a signed-off stage, and
// lazily whenever a balance is read, so a video signed off by some other route
// (the board, an automation) still settles. Best-effort throughout — a credit
// write must never block a stage change.
export async function settleSignedOffAllocations({ companyId = null, dealId = null, videoId = null } = {}) {
  await ensureVideoCreditAllocations();
  let rows;
  try {
    rows = await sql`
      SELECT a.*, pv.production_phase, pv.production_stage, pv.title AS video_title
        FROM video_credit_allocations a
        JOIN project_videos pv ON pv.id = a.video_id
       WHERE a.status = 'reserved'
         AND (${companyId}::text IS NULL OR a.company_id = ${companyId})
         AND (${dealId}::text IS NULL OR a.deal_id = ${dealId})
         AND (${videoId}::text IS NULL OR a.video_id = ${videoId})`;
  } catch { return 0; }

  const due = rows.filter((r) => isVideoSignedOff(r.production_phase, r.production_stage));
  if (!due.length) return 0;

  const { ensureCompanyCreditKey } = await import('./videoCredit.js').catch(() => ({}));
  if (!ensureCompanyCreditKey) return 0;

  let settled = 0;
  for (const r of due) {
    try {
      const key = await ensureCompanyCreditKey({ id: r.company_id });
      if (!key) continue;
      const sourceRef = 'vca_' + r.id;
      const [dupe] = await sql`SELECT 1 FROM credit_allocations WHERE source_ref = ${sourceRef} LIMIT 1`;
      if (!dupe) {
        await sql`
          INSERT INTO credit_allocations
            (client_key, proposal_id, description, credit_cost, kind, allocated_by, source_ref)
          VALUES
            (${key}, NULL, ${'Video credit — ' + (r.video_title || 'video')}, ${Number(r.minutes)},
             'work', ${r.assigned_by || null}, ${sourceRef})`;
      }
      const [upd] = await sql`
        UPDATE video_credit_allocations
           SET status = 'spent', spent_at = NOW(), updated_at = NOW()
         WHERE id = ${r.id} AND status = 'reserved' RETURNING id`;
      if (upd) settled += 1;
    } catch (err) {
      console.warn('[videoCreditAllocations] settle failed', r.id, err.message);
    }
  }
  return settled;
}
