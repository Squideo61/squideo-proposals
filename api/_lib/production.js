// Production helpers — moving a paid deal onto the production board. Mirrors
// the best-effort, event-logging style of dealStage.js: every hook is wrapped
// in try/catch by its caller so a failure here can never break the payment
// flow that triggered it.
import sql from './db.js';
import { logDealEvent } from './dealStage.js';
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
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS production_stage_changed_at TIMESTAMPTZ`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS production_credits INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS producer_email TEXT`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS payment_terms TEXT`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS delivery_deadline DATE`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS text_direction_deadline DATE`;
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS revision_project_id TEXT`;
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
      INSERT INTO project_videos (id, deal_id, title, status, sort_order, created_by)
      VALUES (${makeId('pvid')}, ${dealId}, 'Video 1', 'not_started', 0, ${actorEmail})
    `;
  }

  await logDealEvent(dealId, 'entered_production', { actorEmail, payload: { phase, stage, source } });
  return { entered: true, phase, stage };
}
