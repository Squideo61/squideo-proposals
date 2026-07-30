// Handles /?portalInvite=…&portalInviteEmail=… — the hand-off from the client
// portal's Team page when a STAFF member (manage mode) invites someone.
//
// The composer only exists in the CRM, so the portal can't open it directly.
// It opens this URL in a new tab instead; we mint the invite and pop the
// composer prefilled, exactly as the company/contact cards do. Clients invite
// from the portal itself and never come through here — their invite sends the
// standard email immediately.
import { useEffect, useRef } from 'react';
import { usePortalInviteCompose } from './usePortalInviteCompose.js';

export function PortalInviteDeepLink() {
  const { compose } = usePortalInviteCompose();
  // Strict-mode double-mount would otherwise mint the invite twice, re-keying
  // the token between the two and leaving the first draft's link dead.
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    const params = new URLSearchParams(window.location.search);
    const companyId = params.get('portalInvite');
    const email = params.get('portalInviteEmail');
    if (!companyId || !email) return;
    handled.current = true;
    const name = params.get('portalInviteName');
    // Drop the params first: the composer is a long-lived surface and a reload
    // shouldn't silently mint a second invite.
    params.delete('portalInvite');
    params.delete('portalInviteEmail');
    params.delete('portalInviteName');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + (window.location.hash || ''));
    compose({ companyId, email, name: name || null });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
