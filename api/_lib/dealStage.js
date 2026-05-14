// Deal-stage helpers — keep stage transitions consistent across every API
// route that affects a deal's lifecycle. The ratchet rule prevents a delayed
// view event from downgrading a signed deal back to "viewed".
import sql from './db.js';

export const STAGES = ['lead', 'responded', 'proposal_sent', 'viewed', 'signed', 'paid', 'long_term', 'lost'];

export function isValidStage(stage) {
  return STAGES.includes(stage);
}

function rank(stage) {
  const i = STAGES.indexOf(stage);
  return i === -1 ? -1 : i;
}

// Advance a deal's stage forward, no-op if `toStage` is earlier than the
// current one. `lost` and `long_term` can be set from anywhere, and a deal
// in `long_term` can move to any stage (bidirectional parking lane).
// Writes a `stage_change` event to deal_events when an actual transition
// occurs. All hooks are best-effort — failures must not break the calling
// API route, so the caller wraps this in try/catch.
export async function advanceStage(dealId, toStage, { actorEmail = null, payload = {} } = {}) {
  if (!dealId) return { changed: false, reason: 'no-deal' };
  if (!isValidStage(toStage)) return { changed: false, reason: 'invalid-stage' };

  const rows = await sql`SELECT id, stage FROM deals WHERE id = ${dealId}`;
  if (!rows.length) return { changed: false, reason: 'deal-not-found' };
  const current = rows[0].stage;

  const isForward = rank(toStage) > rank(current);
  const isLost = toStage === 'lost';
  const isLongTerm = toStage === 'long_term' || current === 'long_term';
  if (!isForward && !isLost && !isLongTerm) return { changed: false, reason: 'no-advance', current };
  if (current === toStage) return { changed: false, reason: 'same-stage' };

  await sql`
    UPDATE deals
       SET stage = ${toStage},
           stage_changed_at = NOW(),
           last_activity_at = NOW(),
           updated_at = NOW()
     WHERE id = ${dealId}
  `;
  await sql`
    INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
    VALUES (${dealId}, 'stage_change', ${JSON.stringify({ from: current, to: toStage, ...payload })}, ${actorEmail})
  `;
  return { changed: true, from: current, to: toStage };
}

// Find the deal_id linked to a proposal — used by signatures/views/payments
// hook sites to advance the deal even though they're keyed by proposal_id.
export async function dealIdForProposal(proposalId) {
  if (!proposalId) return null;
  const rows = await sql`SELECT deal_id FROM proposals WHERE id = ${proposalId}`;
  return rows[0]?.deal_id || null;
}

// Returns the linked Xero contact ID for a proposal via deal → company.
// Used by the invoice push paths so the existing Xero contact is reused
// instead of the billing-form name creating a duplicate.
export async function xeroContactIdForProposal(proposalId) {
  if (!proposalId) return null;
  const rows = await sql`
    SELECT c.xero_contact_id
      FROM proposals p
      LEFT JOIN deals d     ON d.id = p.deal_id
      LEFT JOIN companies c ON c.id = d.company_id
     WHERE p.id = ${proposalId}
  `;
  return rows[0]?.xero_contact_id || null;
}

// Append a non-stage event to the timeline. Use for proposal_sent, task_created,
// note, etc. — anything that should appear on the deal timeline without
// changing the stage.
export async function logDealEvent(dealId, eventType, { actorEmail = null, payload = {} } = {}) {
  if (!dealId) return;
  await sql`
    INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
    VALUES (${dealId}, ${eventType}, ${JSON.stringify(payload)}, ${actorEmail})
  `;
  await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${dealId}`;
}
