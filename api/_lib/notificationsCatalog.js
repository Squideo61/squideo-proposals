// Static catalog of notification keys. Lives in its own file (no db imports)
// so the SPA can import it directly for UI rendering — same source of truth
// as the backend recipient resolver in ./notifications.js.
//
// `channel` routes a notification to one of the two in-app bells:
//   - 'finance' : sales & money updates (the £ bell, left of the bell)
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
    label: 'Task reminders',
    description: 'Daily 9am summary of tasks assigned to you that are due.',
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
    key: 'finance.quarter_summary',
    label: 'Quarterly VAT & Corp Tax summary',
    description: 'At the end of each calendar quarter, a summary of the VAT and Corporation Tax you should have set aside.',
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

// The two in-app notification channels (bells). Order matters: 'finance' is
// rendered to the LEFT of 'general' in the top bar.
export const NOTIFICATION_CHANNELS = [
  { key: 'finance', label: 'Sales & finance', short: 'Finance' },
  { key: 'general', label: 'Updates', short: 'Updates' },
];

// Which bell a notification key belongs to. Unknown/missing → 'general'.
export function channelForKey(key) {
  const meta = NOTIFICATIONS.find(n => n.key === key);
  return meta && meta.channel === 'finance' ? 'finance' : 'general';
}

// All keys routed to the finance (£) bell — used by the feed endpoint to split
// counts/items per channel with a single `notification_key = ANY(...)` filter.
export const FINANCE_CHANNEL_KEYS = NOTIFICATIONS
  .filter(n => n.channel === 'finance')
  .map(n => n.key);
