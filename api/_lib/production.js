// Production helpers — moving a paid deal onto the production board. Mirrors
// the best-effort, event-logging style of dealStage.js: every hook is wrapped
// in try/catch by its caller so a failure here can never break the payment
// flow that triggered it.
import sql from './db.js';
import { logDealEvent } from './dealStage.js';
import { FIRST_PRODUCTION } from './productionStages.js';
import { makeId } from './crm/shared.js';

// Move a deal into production (the "project is born" moment). Called from the
// Stripe paid hooks and from the manual "Add to production" button.
//
// Idempotent: a deal that already has a production_phase is left untouched, so
// the webhook and the /verify fallback racing on the same payment can both call
// this without double-creating the project or its default video.
export async function enterProduction(dealId, { source = null, actorEmail = null } = {}) {
  if (!dealId) return { entered: false, reason: 'no-deal' };

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
