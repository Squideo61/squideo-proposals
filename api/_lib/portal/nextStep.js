// The portal's "whose court is the ball in?" engine. A pure, server-side
// derivation from deal + review state so the portal, emails and any future
// digest always agree. First matching rule wins.
//
//   court: 'you'     — the client must act (rendered as the amber banner)
//          'squideo' — we're on it, nothing needed from the client
//          'done'    — delivered / wrapped up
//
// The caller (api/portal/[action].js) gathers the state bundle; keep this
// module free of DB access so it stays trivially testable.

import { PHASE_BY_ID } from '../productionStages.js';

function stageLabel(phaseId, stageId) {
  const phase = PHASE_BY_ID[phaseId];
  const stage = phase?.stages?.find((s) => s.id === stageId);
  return stage?.label || phase?.label || null;
}

export function deriveNextStep({
  deal,                 // deals row (stage, payment_terms, po_number, production_phase/stage)
  proposalId = null,    // latest proposal for the deal
  signature = null,     // signatures row (data JSONB) or null
  revisionPending = null,   // { shareToken, videoTitle } when a cut awaits client feedback
  storyboardPending = null, // { shareToken, storyboardTitle } when a storyboard awaits feedback
  videos = [],          // project_videos rows
} = {}) {
  const stage = deal?.stage || null;
  const phase = deal?.production_phase || null;
  const prodStage = deal?.production_stage || null;
  const sigData = signature?.data || signature || null;

  // 1. Proposal sent but not signed yet.
  if ((stage === 'proposal_sent' || stage === 'viewed') && !signature && proposalId) {
    return {
      court: 'you',
      headline: 'Your proposal is ready to review',
      detail: 'Take a look through the proposal and sign when you’re happy — that locks in your slot in our production schedule.',
      cta: { label: 'Review & sign proposal', href: `/?proposal=${encodeURIComponent(proposalId)}` },
    };
  }

  // 2. Signed on 50/50 terms but the deposit hasn't landed.
  const is5050 = sigData?.paymentOption === '5050' || deal?.payment_terms === '50_50';
  if (stage === 'signed' && is5050 && sigData?.paymentOption !== 'po' && proposalId && !phase) {
    return {
      court: 'you',
      headline: 'Pay your 50% deposit to start production',
      detail: 'Production is scheduled as soon as your deposit arrives — pay securely by card, or reply to your invoice email for bank transfer.',
      cta: { label: 'Pay deposit by card', href: `/?proposal=${encodeURIComponent(proposalId)}&thanks=1` },
    };
  }

  // 3. PO route with no PO number yet.
  const isPo = sigData?.paymentOption === 'po' || deal?.payment_terms === 'po';
  if (stage === 'signed' && isPo && !deal?.po_number) {
    return {
      court: 'you',
      headline: 'Send us your purchase order number',
      detail: 'Once we have your PO number we can raise the invoice and keep everything moving with your finance team.',
      cta: { label: 'Submit PO number', action: 'po-number' },
    };
  }

  // 4. A video cut is waiting on client feedback.
  if (revisionPending?.shareToken) {
    return {
      court: 'you',
      headline: revisionPending.videoTitle
        ? `“${revisionPending.videoTitle}” is ready for your review`
        : 'A new cut is ready for your review',
      detail: 'Watch the latest draft, drop timecoded comments right on the video, then send your feedback (or approve it!).',
      cta: { label: 'Watch & give feedback', href: `/?revision=${encodeURIComponent(revisionPending.shareToken)}` },
    };
  }

  // 5. A storyboard is waiting on client feedback.
  if (storyboardPending?.shareToken) {
    return {
      court: 'you',
      headline: storyboardPending.storyboardTitle
        ? `Storyboard “${storyboardPending.storyboardTitle}” is ready for review`
        : 'Your storyboard is ready for review',
      detail: 'Review each frame, pin comments where you’d like changes, then send your feedback or approve.',
      cta: { label: 'Review storyboard', href: `/?storyboard=${encodeURIComponent(storyboardPending.shareToken)}` },
    };
  }

  // 6. Board says we're explicitly waiting on the client.
  if (prodStage === 'awaiting_feedback_1' || prodStage === 'awaiting_feedback_2') {
    return {
      court: 'you',
      headline: 'We’re waiting on your feedback',
      detail: 'Our team has sent something over for your review — check your inbox (or the links on this page) and send your thoughts so we can push on.',
      cta: null,
    };
  }

  // 7. Group sign-off needed.
  if (prodStage === 'pending_group_sign_off') {
    return {
      court: 'you',
      headline: 'Your team’s final sign-off is needed',
      detail: 'The video is ready — gather any remaining stakeholders and confirm sign-off so we can deliver the final files.',
      cta: null,
    };
  }

  // 8. On hold.
  if (prodStage === 'on_hold') {
    return {
      court: 'squideo',
      headline: 'This project is on hold',
      detail: 'Get in touch with your producer whenever you’re ready to pick things back up.',
      cta: null,
    };
  }

  // 9. Delivered / completed.
  const allVideosDone = videos.length > 0 && videos.every((v) => v.status === 'approved' || v.status === 'delivered');
  if (phase === 'completed' || phase === 'after_care' || allVideosDone) {
    return {
      court: 'done',
      headline: 'Your video is ready 🎉',
      detail: 'The finished files are in your library — download and share them anywhere.',
      cta: { label: 'Open library', href: '#/library' },
    };
  }

  // 10. In production, nothing needed from the client.
  if (phase) {
    const label = stageLabel(phase, prodStage);
    return {
      court: 'squideo',
      headline: 'We’re on it — nothing needed from you',
      detail: label
        ? `Your project is currently at “${label}”. We’ll let you know the moment there’s something to review.`
        : 'Your project is in production. We’ll let you know the moment there’s something to review.',
      cta: null,
    };
  }

  // 11. Signed/paid but production hasn't been opened yet.
  if (stage === 'signed' || stage === 'paid') {
    return {
      court: 'squideo',
      headline: 'We’re getting your project set up',
      detail: 'Everything’s confirmed on your side — our production team is scheduling your project and will be in touch shortly.',
      cta: null,
    };
  }

  return {
    court: 'squideo',
    headline: 'We’re preparing your proposal',
    detail: 'Keep an eye on your inbox — your proposal will land shortly.',
    cta: null,
  };
}
