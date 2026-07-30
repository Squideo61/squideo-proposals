// "Invite to portal" that opens a real email in the composer instead of firing
// the system invite — so the note that lands in the client's inbox comes from a
// person, on a thread they can reply to, and can be edited before it goes.
//
// The invite row is created either way, so a link sent by hand behaves exactly
// like one sent by the system: same 14-day expiry, and "resend" still re-keys it
// to a single live link.
import { useState } from 'react';
import { api } from '../../api.js';
import { useStore } from '../../store.jsx';
import { portalInviteTemplate, fillPortalInvite } from '../../lib/portalInviteEmail.js';

export function usePortalInviteCompose({ onError, onSent } = {}) {
  const { state, actions } = useStore();
  const [busy, setBusy] = useState(false);

  // `dealId`/`dealTitle` are optional — they only file the sent email against a
  // deal's conversation. Inviting from a company or contact page has neither.
  const compose = async ({ companyId, email, name = null, dealId = null, dealTitle = null }) => {
    if (!companyId || !email) return;
    setBusy(true);
    try {
      const res = await api.post('/api/crm/portal-admin?op=invite', {
        companyId, email, name, compose: true,
      });
      // Templates are lazy-loaded by the composer; make sure we have them before
      // picking one, or the first invite of a session gets the fallback copy.
      let templates = state.emailTemplates || [];
      if (!templates.length) {
        templates = (await actions.loadEmailTemplates().catch(() => null)) || [];
      }
      const filled = fillPortalInvite(portalInviteTemplate(templates), {
        inviteUrl: res.inviteUrl,
        email: res.email || email,
        name,
        companyName: res.companyName,
        senderName: state.session?.name || null,
      });
      actions.openComposer({
        dealId,
        dealTitle,
        contactEmail: res.email || email,
        initialDraft: { to: res.email || email, subject: filled.subject, body: filled.bodyHtml },
      });
      onSent?.(res);
    } catch (err) {
      onError?.(err.message || 'Could not prepare the invite');
    } finally {
      setBusy(false);
    }
  };

  return { compose, busy };
}
