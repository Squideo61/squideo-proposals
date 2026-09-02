// What's on the Sales Pipeline board and what's been put away.
//
// Paid and Lost are terminal, but they never empty themselves, so every deal
// we've ever won or lost piles up in them and buries the live end of the
// funnel. A deal drops off the board when:
//
//   • it's been sat in Paid or Lost for over a month AND has no money still in
//     the air (see hasOutstandingMoney) — the automatic clear-out, which needs
//     no state at all, or
//   • someone cleared it off by hand (deal.pipelineArchivedAt).
//
// Either way the deal is untouched in the CRM — page, finance, files, search
// and reporting all carry on exactly as before. This is only about what the
// board renders, which is why the whole rule lives client-side.
//
// Two manual overrides sit on top, and both beat the age rule: archiving puts a
// deal away whatever its age, restoring keeps one on the board despite it.
import { hasOutstandingMoney } from './saleStatus.js';

export const CLEAR_AFTER_DAYS = 30;

// The only stages that ever clear themselves. Long-term is a deliberate parking
// spot, not a finished deal, so it's left alone however long it sits there.
export const CLEARED_STAGES = new Set(['paid', 'lost']);

// How long this deal has been sat in its current stage, in days. Falls back to
// when it was created, so a legacy deal with no recorded stage change still
// ages rather than pinning itself to the top of Paid forever.
export function daysInStage(deal, now = Date.now()) {
  const at = new Date(deal?.stageChangedAt || deal?.createdAt || 0).getTime();
  if (!at || Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now - at) / 86400000));
}

// Why a deal isn't on the board, or null if it is:
//   'manual' — someone archived it
//   'age'    — finished, settled, and older than the cut-off
export function archiveReason(deal, now = Date.now()) {
  if (!deal) return null;
  if (deal.pipelineArchivedAt) return 'manual';
  // A deliberate restore outranks the age rule — that's what restoring means.
  if (deal.pipelineRestoredAt) return null;
  if (!CLEARED_STAGES.has(deal.stage)) return null;
  // Never clear a deal that still owes us something: a Paid-stage deal sitting
  // on "Pending invoice" is unfinished admin, and the board is where anyone
  // would look for it.
  if (hasOutstandingMoney(deal)) return null;
  const age = daysInStage(deal, now);
  return age != null && age > CLEAR_AFTER_DAYS ? 'age' : null;
}

export const isArchived = (deal, now = Date.now()) => archiveReason(deal, now) !== null;

// Splits a stage's deals into what's on the board and what's been put away,
// preserving the order given.
export function splitArchived(deals, now = Date.now()) {
  const current = [];
  const archived = [];
  for (const d of deals || []) (isArchived(d, now) ? archived : current).push(d);
  return { current, archived };
}

// One line saying why this deal is off the board, for the archive list.
export function describeArchive(deal, stageLabel, now = Date.now()) {
  const reason = archiveReason(deal, now);
  if (!reason) return null;
  if (reason === 'manual') {
    const when = deal.pipelineArchivedAt
      ? new Date(deal.pipelineArchivedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : null;
    return `Archived by hand${when ? ' · ' + when : ''}`;
  }
  const age = daysInStage(deal, now);
  return `${stageLabel || deal.stage} · ${age} days`;
}
