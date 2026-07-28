// Compute a single deal's client task list server-side, outside api/portal.js.
// The portal itself derives tasks in bulk (gatherDealStates → tasksFor), but the
// "Send intro email" hook (api/crm/portal-admin.js) and the reminder cron
// (api/_lib/crm/cron.js) need the same list for ONE deal. This assembles the same
// bundle deriveProjectTasks expects, for a single deal, then derives it.

import sql from '../db.js';
import { ensureVoiceoverCatalogue } from '../voiceover.js';
import { voiceoverProposalContext } from '../proposalPricing.js';
import { deriveProjectTasks, countOpenTasks } from './tasks.js';

// → { deal, tasks, openCount } or null if the deal is missing.
export async function computeDealTasks(dealId) {
  if (!dealId) return null;
  const [deal] = await sql`
    SELECT id, company_id, title, po_number, payment_terms,
           client_tasks_launched_at, production_phase
      FROM deals WHERE id = ${dealId}
  `;
  if (!deal) return null;

  // Self-heal the voiceover columns/table before the video query joins them
  // (mirrors gatherDealStates in api/portal.js).
  await ensureVoiceoverCatalogue();

  const [propRows, videoRows, kickoffRows, brandRows] = await Promise.all([
    sql`
      SELECT p.data AS proposal_data, s.data AS signature_data, s.signed_at
        FROM proposals p
        LEFT JOIN signatures s ON s.proposal_id = p.id
       WHERE p.deal_id = ${dealId}
       ORDER BY (s.signed_at IS NOT NULL) DESC, p.created_at DESC
       LIMIT 1
    `,
    sql`
      SELECT v.id, v.voiceover_artist_id
        FROM project_videos v
       WHERE v.deal_id = ${dealId}
       ORDER BY v.sort_order ASC, v.created_at ASC
    `,
    sql`
      SELECT starts_at, meet_url, client_timezone FROM intro_call_bookings
       WHERE deal_id = ${dealId} AND kind = 'kickoff' AND status = 'confirmed'
       ORDER BY created_at DESC LIMIT 1
    `.catch(() => []),
    sql`
      SELECT EXISTS (
        SELECT 1 FROM portal_company_files f
         WHERE f.company_id = ${deal.company_id} AND f.category = 'brand'
      ) AS has_brand_assets
    `.catch(() => [{ has_brand_assets: false }]),
  ]);

  const prop = propRows[0] || null;
  let hasVoiceover = false;
  if (prop) {
    try {
      const vo = voiceoverProposalContext(prop.proposal_data, prop.signature_data);
      hasVoiceover = vo.aiIncluded || vo.humanPurchased || vo.humanIncludedStandard;
    } catch { hasVoiceover = false; }
  }

  const tasks = deriveProjectTasks({
    deal,
    videos: videoRows,
    hasKickoffBooking: kickoffRows.length > 0,
    kickoffBooking: kickoffRows[0]
      ? { startsAt: kickoffRows[0].starts_at, timezone: kickoffRows[0].client_timezone || null, joinUrl: kickoffRows[0].meet_url || null }
      : null,
    hasVoiceover,
    hasBrandAssets: brandRows[0]?.has_brand_assets ?? false,
    sigPaymentOption: prop?.signature_data?.paymentOption || null,
  });
  return { deal, tasks, openCount: countOpenTasks(tasks) };
}
