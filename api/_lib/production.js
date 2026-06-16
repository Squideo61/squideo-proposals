// Production helpers — moving a paid deal onto the production board. Mirrors
// the best-effort, event-logging style of dealStage.js: every hook is wrapped
// in try/catch by its caller so a failure here can never break the payment
// flow that triggered it.
import sql from './db.js';
import { logDealEvent, advanceStage } from './dealStage.js';
import { FIRST_PRODUCTION } from './productionStages.js';
import { makeId } from './crm/shared.js';

// Self-heal for db/migrations/20260522_production_board.sql and
// 20260522_production_video_length.sql. Called by every production code path so
// a workspace that skipped the manual Neon apply still works — without it, a
// missing column (e.g. video_length) makes every project update 500. Module-
// level cached: a successful first call short-circuits later ones for the
// lifetime of the serverless instance. Same pattern as shared.js's ensure*.
let productionSchemaEnsured = null;
export async function ensureProductionSchema() {
  if (productionSchemaEnsured) return productionSchemaEnsured;
  productionSchemaEnsured = (async () => {
    try {
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS production_phase TEXT`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS production_stage TEXT`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS production_entered_at TIMESTAMPTZ`;
      // Manually-set production start date (a PM enters/adjusts it — work can't
      // always begin the day it's paid, e.g. awaiting client assets).
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS production_start_date DATE`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS production_stage_changed_at TIMESTAMPTZ`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS production_credits INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS producer_email TEXT`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS payment_terms TEXT`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS delivery_deadline DATE`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS text_direction_deadline DATE`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS revision_project_id TEXT`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS storyboard_project_id TEXT`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS video_length TEXT`;
      await sql`
        CREATE TABLE IF NOT EXISTS project_videos (
          id                 TEXT        PRIMARY KEY,
          deal_id            TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
          title              TEXT        NOT NULL,
          status             TEXT        NOT NULL DEFAULT 'not_started',
          sort_order         INTEGER     NOT NULL DEFAULT 0,
          revision_video_id  TEXT,
          created_by         TEXT,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS project_videos_deal_idx ON project_videos(deal_id, sort_order, created_at)`;
      // Per-video board fields (videos, not projects, move through the board).
      await sql`ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS production_phase TEXT`;
      await sql`ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS production_stage TEXT`;
      await sql`ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS production_stage_changed_at TIMESTAMPTZ`;
      await sql`ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS payment_terms TEXT`;
      await sql`ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS video_length TEXT`;
      await sql`ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS delivery_deadline DATE`;
      await sql`ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS text_direction_deadline DATE`;
      await sql`ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS producer_email TEXT`;
      await sql`ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS storyboard_id TEXT`;
      await sql`CREATE INDEX IF NOT EXISTS project_videos_stage_idx ON project_videos(production_phase, production_stage)`;
      // Per-video script uploads + milestone approvals (Script section / board auto-advance).
      await sql`
        CREATE TABLE IF NOT EXISTS video_milestones (
          id          TEXT        PRIMARY KEY,
          video_id    TEXT        NOT NULL REFERENCES project_videos(id) ON DELETE CASCADE,
          milestone   TEXT        NOT NULL,
          approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          approved_by TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS video_milestones_unique ON video_milestones(video_id, milestone)`;
      await sql`
        CREATE TABLE IF NOT EXISTS video_scripts (
          id            TEXT        PRIMARY KEY,
          video_id      TEXT        NOT NULL REFERENCES project_videos(id) ON DELETE CASCADE,
          deal_id       TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
          filename      TEXT        NOT NULL,
          mime_type     TEXT,
          size_bytes    BIGINT,
          drive_file_id TEXT,
          web_view_link TEXT,
          blob_url      TEXT,
          blob_pathname TEXT,
          uploaded_by   TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS video_scripts_video_idx ON video_scripts(video_id, created_at DESC)`;
      // Per-milestone content uploads (generalises video_scripts to all milestones).
      await sql`
        CREATE TABLE IF NOT EXISTS video_milestone_assets (
          id            TEXT        PRIMARY KEY,
          video_id      TEXT        NOT NULL REFERENCES project_videos(id) ON DELETE CASCADE,
          milestone     TEXT        NOT NULL,
          filename      TEXT        NOT NULL,
          mime_type     TEXT,
          size_bytes    BIGINT,
          blob_url      TEXT,
          blob_pathname TEXT,
          drive_file_id TEXT,
          web_view_link TEXT,
          uploaded_by   TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS video_milestone_assets_idx ON video_milestone_assets(video_id, milestone, created_at DESC)`;
      // Backfill existing scripts into the Script milestone (once).
      await sql`
        INSERT INTO video_milestone_assets
          (id, video_id, milestone, filename, mime_type, size_bytes, blob_url, blob_pathname, drive_file_id, web_view_link, uploaded_by, created_at)
        SELECT gen_random_uuid()::text, vs.video_id, 'script', vs.filename, vs.mime_type, vs.size_bytes,
               vs.blob_url, vs.blob_pathname, vs.drive_file_id, vs.web_view_link, vs.uploaded_by, vs.created_at
          FROM video_scripts vs
         WHERE NOT EXISTS (
           SELECT 1 FROM video_milestone_assets a
            WHERE a.video_id = vs.video_id AND a.milestone = 'script' AND a.filename = vs.filename AND a.created_at = vs.created_at
         )
      `;
      // Fold the legacy 'visual_direction' milestone into the combined
      // 'script' (Script & Text Direction) milestone — script + text direction
      // are sent to the client together. Assets carry over freely; approvals
      // are de-duped first (the unique (video_id, milestone) index).
      await sql`UPDATE video_milestone_assets SET milestone = 'script' WHERE milestone = 'visual_direction'`;
      await sql`
        DELETE FROM video_milestones v
         WHERE v.milestone = 'visual_direction'
           AND EXISTS (SELECT 1 FROM video_milestones s WHERE s.video_id = v.video_id AND s.milestone = 'script')
      `;
      await sql`UPDATE video_milestones SET milestone = 'script' WHERE milestone = 'visual_direction'`;
      // Multiple producers / team members per video and per project (deal).
      await sql`
        CREATE TABLE IF NOT EXISTS video_assignees (
          video_id    TEXT        NOT NULL REFERENCES project_videos(id) ON DELETE CASCADE,
          user_email  TEXT        NOT NULL,
          assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (video_id, user_email)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS deal_assignees (
          deal_id     TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
          user_email  TEXT        NOT NULL,
          assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (deal_id, user_email)
        )
      `;
      // Backfill from the single producer_email, only where no assignees exist
      // yet (so a deliberately-cleared set is never re-populated on cold start).
      await sql`
        INSERT INTO video_assignees (video_id, user_email)
          SELECT pv.id, pv.producer_email FROM project_videos pv
           WHERE pv.producer_email IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM video_assignees va WHERE va.video_id = pv.id)
          ON CONFLICT DO NOTHING
      `;
      await sql`
        INSERT INTO deal_assignees (deal_id, user_email)
          SELECT d.id, d.producer_email FROM deals d
           WHERE d.producer_email IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM deal_assignees da WHERE da.deal_id = d.id)
          ON CONFLICT DO NOTHING
      `;
      // One-time backfill: existing videos onto the board, inheriting project-level values.
      await sql`
        UPDATE project_videos v
           SET production_phase = 'pre_production', production_stage = 'new_project',
               production_stage_changed_at = NOW(),
               producer_email = d.producer_email, payment_terms = d.payment_terms,
               video_length = d.video_length, delivery_deadline = d.delivery_deadline,
               text_direction_deadline = d.text_direction_deadline
          FROM deals d
         WHERE d.id = v.deal_id AND v.production_phase IS NULL
      `;
    } catch (err) {
      productionSchemaEnsured = null;
      console.warn('[production] schema ensure failed', err.message);
    }
  })();
  return productionSchemaEnsured;
}

// Move a deal into production (the "project is born" moment). Called from the
// Stripe paid hooks and from the manual "Add to production" button.
//
// Idempotent: a deal that already has a production_phase is left untouched, so
// the webhook and the /verify fallback racing on the same payment can both call
// this without double-creating the project or its default video.
export async function enterProduction(dealId, { source = null, actorEmail = null } = {}) {
  if (!dealId) return { entered: false, reason: 'no-deal' };
  await ensureProductionSchema();

  const rows = await sql`SELECT id, production_phase, title FROM deals WHERE id = ${dealId}`;
  if (!rows.length) return { entered: false, reason: 'deal-not-found' };
  if (rows[0].production_phase) return { entered: false, reason: 'already-in-production' };

  const { phase, stage } = FIRST_PRODUCTION;
  await sql`
    UPDATE deals
       SET production_phase           = ${phase},
           production_stage           = ${stage},
           production_entered_at       = NOW(),
           production_stage_changed_at = NOW(),
           last_activity_at            = NOW(),
           updated_at                  = NOW()
     WHERE id = ${dealId}
  `;

  // Default to one video so the common single-video case needs no extra step;
  // more can be added (or pre-paid as credits) on the project page.
  const existing = await sql`SELECT 1 FROM project_videos WHERE deal_id = ${dealId} LIMIT 1`;
  if (!existing.length) {
    await sql`
      INSERT INTO project_videos
        (id, deal_id, title, status, sort_order, production_phase, production_stage, production_stage_changed_at, created_by)
      VALUES
        (${makeId('pvid')}, ${dealId}, 'Video 1', 'not_started', 0, ${phase}, ${stage}, NOW(), ${actorEmail})
    `;
  }

  await logDealEvent(dealId, 'entered_production', { actorEmail, payload: { phase, stage, source } });
  return { entered: true, phase, stage };
}

// Self-heal: enter production for any deal that has been PAID (via any route)
// but isn't on the board yet. Called when the board loads so paid deals always
// appear, even ones paid before the per-route hooks existed or paid via a route
// that didn't fire one (e.g. a Xero invoice reconciled on the company page only).
// Best-effort + idempotent; bounded — only returns deals needing entry.
export async function backfillPaidDealsIntoProduction() {
  await ensureProductionSchema();
  let rows;
  try {
    rows = await sql`
      SELECT d.id
        FROM deals d
       WHERE d.production_phase IS NULL
         AND d.stage <> 'lost'
         AND (
           EXISTS (SELECT 1 FROM payments pay JOIN proposals p ON p.id = pay.proposal_id WHERE p.deal_id = d.id)
           OR EXISTS (SELECT 1 FROM proposal_billing pb JOIN proposals p ON p.id = pb.proposal_id
                       WHERE p.deal_id = d.id AND pb.paid_amount IS NOT NULL AND pb.paid_amount > 0)
           OR EXISTS (SELECT 1 FROM manual_invoices mi WHERE mi.deal_id = d.id AND mi.status = 'paid')
           OR EXISTS (SELECT 1 FROM manual_payments mp JOIN proposals p ON p.id = mp.proposal_id
                       WHERE p.deal_id = d.id AND mp.manual_invoice_id IS NULL)
           OR EXISTS (SELECT 1 FROM partner_invoices pi JOIN proposals p ON p.id = pi.proposal_id WHERE p.deal_id = d.id)
         )
    `;
  } catch (err) {
    console.error('[production] backfill query failed', err.message);
    return 0;
  }
  for (const { id } of rows) {
    try {
      await advanceStage(id, 'paid', { payload: { source: 'production-backfill' } });
      await enterProduction(id, { source: 'production-backfill' });
    } catch (err) {
      console.error('[production] backfill enter failed for', id, err.message);
    }
  }
  return rows.length;
}
