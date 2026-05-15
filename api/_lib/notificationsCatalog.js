// Static catalog of notification keys. Lives in its own file (no db imports)
// so the SPA can import it directly for UI rendering — same source of truth
// as the backend recipient resolver in ./notifications.js.

export const NOTIFICATIONS = [
  {
    key: 'proposal.signed',
    label: 'Proposal signed',
    description: 'A client accepts and signs a proposal you sent.',
    audience: 'broadcast',
    group: 'Proposals',
  },
  {
    key: 'proposal.first_view',
    label: 'Proposal first opened',
    description: 'A client opens one of your proposals for the first time.',
    audience: 'owner',
    group: 'Proposals',
  },
  {
    key: 'payment.received',
    label: 'Proposal payment received',
    description: 'A Stripe checkout for a signed proposal completes.',
    audience: 'broadcast',
    group: 'Payments',
  },
  {
    key: 'payment.partner_credit',
    label: 'Partner programme payment',
    description: 'A monthly Partner Programme charge succeeds.',
    audience: 'broadcast',
    group: 'Payments',
  },
  {
    key: 'invoice.paid_manual',
    label: 'Invoice marked paid (manual)',
    description: 'Someone marks a CRM invoice as paid by hand.',
    audience: 'broadcast',
    group: 'Payments',
  },
  {
    key: 'invoice.paid_xero',
    label: 'Invoice paid (Xero sync)',
    description: 'A scheduled Xero sync detects a paid invoice.',
    audience: 'broadcast',
    group: 'Payments',
  },
  {
    key: 'task.reminder',
    label: 'Task reminders',
    description: 'Daily 9am summary of tasks assigned to you that are due.',
    audience: 'assignee',
    group: 'CRM',
  },
  {
    key: 'quote_request.new',
    label: 'New quote request',
    description: 'Someone submits the public quote-request form.',
    audience: 'broadcast',
    group: 'Leads',
  },
  {
    key: 'quote_request.partial',
    label: 'Abandoned quote request',
    description: 'A visitor starts the quote form, stops typing for 20 minutes, and we have enough info to follow up.',
    audience: 'broadcast',
    group: 'Leads',
  },
];

const KEYS = new Set(NOTIFICATIONS.map(n => n.key));

export function isValidNotificationKey(key) {
  return KEYS.has(key);
}

export function getNotificationMeta(key) {
  return NOTIFICATIONS.find(n => n.key === key) || null;
}
