// "Invite to portal" opens a real, editable email in the composer rather than
// firing the system invite. The copy comes from an ordinary saved template
// (seeded server-side as tpl_portal_invite, see api/_lib/crm/templates.js), so
// it's edited in the composer's template panel like any other.
//
// The one thing the template can't know is the invite link, which is minted per
// invite — hence the placeholders below.

import { fillTemplate, unfillTemplate, firstNameFor } from './emailTemplate.js';

export { firstNameFor, wrapSignature, SIGNATURE_MARKER } from './emailTemplate.js';

export const PORTAL_INVITE_TEMPLATE_ID = 'tpl_portal_invite';

// Only used if the seeded template has been deleted. Deliberately terse — the
// good copy lives in the template, which is the editable one.
const FALLBACK = {
  subject: 'Your Squideo client portal is ready',
  bodyHtml: `<p>Hi {{first_name}},</p>
<p>Your Squideo client portal is ready — track progress, review videos and download the finished films.</p>
<p><a href="{{portal_link}}">Set up your login here</a></p>`,
};

export function portalInviteTemplate(templates) {
  const t = (templates || []).find((x) => x.id === PORTAL_INVITE_TEMPLATE_ID);
  if (!t) return FALLBACK;
  return {
    subject: t.subject || FALLBACK.subject,
    bodyHtml: t.bodyHtml || FALLBACK.bodyHtml,
  };
}

// Without this, saving Dan's draft would bake "Hi Dan", his company and —
// worst of all — his one-time invite link into the copy every future client
// receives.
export function unfillPortalInvite(html, vars) {
  return unfillTemplate(html, [
    [vars.inviteUrl, 'portal_link'],
    [vars.email, 'email'],
    [vars.companyName, 'company'],
    [firstNameFor(vars), 'first_name'],
  ]);
}

export function fillPortalInvite(template, vars) {
  return fillTemplate(template, {
    portal_link: vars.inviteUrl || '',
    first_name: firstNameFor(vars),
    name: vars.name || vars.email || '',
    email: vars.email || '',
    company: vars.companyName || 'your organisation',
    sender: vars.senderName || 'The Squideo team',
  });
}
