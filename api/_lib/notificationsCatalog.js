// Static catalog of notification keys. Lives in its own file (no db imports)
// so the SPA can import it directly for UI rendering — same source of truth
// as the backend recipient resolver in ./notifications.js.
//
// `channel` routes a notification to one of the in-app bells:
//   - 'tracking': engagement signals — email opens & proposal opens (the eye
//                 bell, leftmost; sits left of the £ bell)
//   - 'finance' : sales & money updates (the £ bell)
//   - 'general' : everything else / project updates (the standard bell)
// Missing/unknown → treated as 'general' by channelForKey().

export const NOTIFICATIONS = [
  {
    key: 'user.invite_accepted',
    label: 'New teammate joined',
    description: 'Someone accepts a workspace invite and finishes setting up their account.',
    audience: 'broadcast',
    group: 'Workspace',
    channel: 'general',
  },
  {
    key: 'proposal.signed',
    label: 'Proposal signed',
    description: 'A client accepts and signs a proposal you sent.',
    audience: 'broadcast',
    group: 'Proposals',
    channel: 'finance',
  },
  {
    key: 'proposal.first_view',
    label: 'Proposal first opened',
    description: 'A client opens one of your proposals for the first time.',
    audience: 'owner',
    group: 'Proposals',
    channel: 'finance',
  },
  {
    key: 'payment.received',
    label: 'Proposal payment received',
    description: 'A Stripe checkout for a signed proposal completes.',
    audience: 'broadcast',
    group: 'Payments',
    channel: 'finance',
  },
  {
    key: 'payment.partner_credit',
    label: 'Partner programme payment',
    description: 'A monthly Partner Programme charge succeeds.',
    audience: 'broadcast',
    group: 'Payments',
    channel: 'finance',
  },
  {
    key: 'invoice.paid_manual',
    label: 'Invoice marked paid (manual)',
    description: 'Someone marks a CRM invoice as paid by hand.',
    audience: 'broadcast',
    group: 'Payments',
    channel: 'finance',
  },
  {
    key: 'extra.added',
    label: 'Extra charge added',
    description: 'A production manager logs an ad-hoc extra charge on a deal during production.',
    audience: 'broadcast',
    group: 'Payments',
    channel: 'finance',
  },
  {
    key: 'pp.marked_paid',
    label: 'Pending payment marked paid',
    description: 'Someone ticks off a pending payment (an imported PP/PO or a partner fee) as collected.',
    audience: 'broadcast',
    group: 'Payments',
    channel: 'finance',
  },
  {
    key: 'invoice.paid_xero',
    label: 'Invoice paid (Xero sync)',
    description: 'A scheduled Xero sync detects a paid invoice.',
    audience: 'broadcast',
    group: 'Payments',
    channel: 'finance',
  },
  {
    key: 'invoice.needs_generating',
    label: 'Invoice needs generating',
    description: 'A proposal you own has been signed for over an hour with no invoice raised.',
    audience: 'owner',
    group: 'Payments',
    channel: 'finance',
  },
  {
    key: 'invoice.client_requested',
    label: 'Client chose to be invoiced',
    description: "A client picks 'Send me an invoice' instead of paying by card on a signed proposal.",
    audience: 'broadcast',
    group: 'Payments',
    channel: 'finance',
  },
  {
    key: 'invoice.issued',
    label: 'Invoice issued to client',
    description: 'An invoice is issued from Xero to a client via the email-me-an-invoice route.',
    audience: 'broadcast',
    group: 'Payments',
    channel: 'finance',
  },
  {
    key: 'task.reminder',
    label: 'Task reminders (at due time) — in-app',
    description: 'An in-app alert the moment a task assigned to you reaches its due time.',
    audience: 'assignee',
    group: 'CRM',
    channel: 'general',
  },
  {
    key: 'task.reminder_email',
    label: 'Task reminders (at due time) — email',
    description: 'Also email me when a task assigned to me reaches its due time. Off by default — the in-app alert covers it; switch on to also get an email.',
    audience: 'assignee',
    group: 'CRM',
    channel: 'general',
  },
  {
    key: 'task.digest',
    label: 'Daily task digest — in-app',
    description: 'A morning in-app summary of the tasks assigned to you that are due today.',
    audience: 'assignee',
    group: 'CRM',
    channel: 'general',
  },
  {
    key: 'task.digest_email',
    label: 'Daily task digest — email',
    description: 'Also email me the morning summary of my tasks due today. Off by default — the in-app digest covers it; switch on to also get an email.',
    audience: 'assignee',
    group: 'CRM',
    channel: 'general',
  },
  {
    key: 'quote_request.new',
    label: 'New quote request',
    description: 'Someone submits the public quote-request form.',
    audience: 'broadcast',
    group: 'Leads',
    channel: 'finance',
  },
  {
    key: 'quote_request.qualified',
    label: 'Quote request qualified',
    description: 'A teammate qualifies a quote request into a deal.',
    audience: 'broadcast',
    group: 'Leads',
    channel: 'finance',
  },
  {
    key: 'quote_request.partial',
    label: 'Abandoned quote request',
    description: 'A visitor starts the quote form, stops typing for 20 minutes, and we have enough info to follow up.',
    audience: 'broadcast',
    group: 'Leads',
    channel: 'finance',
  },
  {
    key: 'revision.feedback_submitted',
    label: 'Client submitted video feedback',
    description: 'A client finishes reviewing a video revision and sends their comments to the team.',
    audience: 'assignee',
    group: 'Revisions',
    channel: 'general',
  },
  {
    key: 'storyboard.feedback_submitted',
    label: 'Client submitted storyboard feedback',
    description: 'A client finishes reviewing a storyboard and sends their comments to the team.',
    audience: 'assignee',
    group: 'Revisions',
    channel: 'general',
  },
  {
    key: 'revision.draft_completed',
    label: 'Video revision draft completed',
    description: 'Every client comment on a video draft has been marked done by the team.',
    audience: 'broadcast',
    group: 'Revisions',
    channel: 'general',
  },
  {
    key: 'storyboard.draft_completed',
    label: 'Storyboard revision draft completed',
    description: 'Every client comment on a storyboard draft has been marked done by the team.',
    audience: 'broadcast',
    group: 'Revisions',
    channel: 'general',
  },
  {
    key: 'tracking.email_opened',
    label: 'Email opened',
    description: 'A recipient opens an email you sent (the first open of each email).',
    audience: 'owner',
    group: 'Tracking',
    channel: 'tracking',
  },
  {
    key: 'tracking.proposal_opened',
    label: 'Proposal opened',
    description: 'Someone opens a proposal you own (once per new viewer).',
    audience: 'owner',
    group: 'Tracking',
    channel: 'tracking',
  },
  {
    key: 'comment.mention',
    label: 'Mentioned in a comment',
    description: 'A teammate @-mentions you in a comment on a deal or project.',
    audience: 'assignee',
    group: 'CRM',
    channel: 'general',
  },
  {
    key: 'intro_call.booked',
    label: 'Intro call booked',
    description: 'A client books an intro call via a project booking link.',
    audience: 'assignee',
    group: 'CRM',
    channel: 'general',
  },
  {
    key: 'project.good_to_go',
    label: 'Project good to go',
    description: 'A deal is marked "Good to go" and moves into production — a new project for the team to pick up.',
    audience: 'broadcast',
    group: 'Production',
    channel: 'general',
  },
  {
    key: 'leave.requested',
    label: 'Annual leave requested',
    description: 'A team member submits an annual-leave request that needs approving.',
    audience: 'broadcast',
    group: 'Production',
    channel: 'general',
  },
  {
    key: 'leave.decided',
    label: 'Your leave was approved / declined',
    description: 'A manager approves or declines your annual-leave request.',
    audience: 'assignee',
    group: 'Production',
    channel: 'general',
  },
  {
    key: 'schedule.conflict',
    label: 'Schedule clash',
    description: "A production block can't fit before its delivery date (or clashes with booked leave) and needs manual review.",
    audience: 'broadcast',
    group: 'Production',
    channel: 'general',
  },
  {
    key: 'finance.quarter_summary',
    label: 'Quarterly VAT & Corp Tax summary',
    description: 'At the end of each calendar quarter, a summary of the VAT and Corporation Tax you should have set aside.',
    audience: 'owner',
    group: 'Finance',
    channel: 'finance',
  },
  {
    key: 'finance.tax_payment_due',
    label: 'Tax payment due (directors)',
    description: 'Reminders before a logged tax payment is due: move the funds out of savings so they clear, then pay HMRC.',
    audience: 'owner',
    group: 'Finance',
    channel: 'finance',
  },
];

const KEYS = new Set(NOTIFICATIONS.map(n => n.key));

export function isValidNotificationKey(key) {
  return KEYS.has(key);
}

export function getNotificationMeta(key) {
  return NOTIFICATIONS.find(n => n.key === key) || null;
}

// The in-app notification channels (bells). Order is left→right in the top bar:
// 'tracking' (eye) · 'finance' (£) · 'general' (standard bell).
export const NOTIFICATION_CHANNELS = [
  { key: 'tracking', label: 'View Tracking', short: 'Views' },
  { key: 'finance', label: 'Sales & finance', short: 'Finance' },
  { key: 'general', label: 'Updates', short: 'Updates' },
];

const KNOWN_CHANNELS = new Set(['tracking', 'finance', 'general']);

// Which bell a notification key belongs to. Unknown/missing → 'general'.
export function channelForKey(key) {
  const meta = NOTIFICATIONS.find(n => n.key === key);
  return meta && KNOWN_CHANNELS.has(meta.channel) ? meta.channel : 'general';
}

// Keys routed to a non-general bell — used by the feed endpoint to split
// counts/items per channel with a single `notification_key = ANY(...)` filter.
export const FINANCE_CHANNEL_KEYS = NOTIFICATIONS
  .filter(n => n.channel === 'finance')
  .map(n => n.key);

export const TRACKING_CHANNEL_KEYS = NOTIFICATIONS
  .filter(n => n.channel === 'tracking')
  .map(n => n.key);

// Keys that should NOT surface in any top-bar bell, even though they're
// persisted as in-app rows. Task reminders/digests live in the Tasks panel
// (and fire desktop popups + Tier-2 push), so the team doesn't need them
// duplicated in the Updates bell. We still write the rows — they power Web Push
// (Tier 2) and a "clear all" path purges them — but the feed endpoint filters
// them out of the general channel's items + unread count.
export const BELL_HIDDEN_KEYS = ['task.reminder', 'task.digest'];
