// "Open this client's portal" — the one place that mints a portal session for
// staff, so every surface that links into the portal (company page, contact
// page, deal card) behaves identically.
//
// Two modes: Preview is read-only (what the client sees, changes disabled) and
// Manage is write-capable — staff work inside the portal for real, uploading
// past videos to the library, inviting the client's team, filing documents.
// The token rides in the opened tab's URL and is held per-tab, never a cookie,
// so it can't disturb a real client's login in the same browser.
import React, { useState } from 'react';
import { Eye, PencilLine, Link2 } from 'lucide-react';
import { api } from '../../api.js';

export async function openPortalAs(companyId, { manage = false } = {}) {
  const r = await api.post('/api/crm/portal-admin?op=preview', { companyId, manage });
  window.open(r.url, '_blank', 'noopener');
}

// `invite` — { dealId, email, name } — switches the middle button from copying
// a team preview link to copying the CLIENT's invite link: the one you paste
// into an email you're writing yourself. Only the deal card can offer it (an
// invite is per-person and per-deal); the company and contact pages keep the
// team link, which is the useful one there.
//
// `disabledReason` — a portal belongs to an ORGANISATION, so with no company
// there's nothing to open. Callers that can explain why (the deal card: no
// company linked to the deal yet) pass the reason and get a disabled button
// that says it. Without one the buttons just don't render, which reads as
// "portals need an invite first" and isn't true — a preview never has.
export function PortalOpenButtons({ companyId, onError, onNotice, size = 12, label = true, invite = null, disabledReason = null }) {
  const [busy, setBusy] = useState(false);
  if (!companyId) {
    if (!disabledReason) return null;
    return (
      <button className="btn-ghost" style={{ fontSize: size }} disabled title={disabledReason}>
        <Eye size={size} style={{ verticalAlign: -1, marginRight: label ? 4 : 0 }} />{label ? 'View client portal' : ''}
      </button>
    );
  }

  const go = async (manage) => {
    setBusy(true);
    try {
      await openPortalAs(companyId, { manage });
    } catch (err) {
      onError?.(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Put a link on the clipboard, falling back to a prompt: some browsers refuse
  // a clipboard write once the user gesture has been spent on the round trip.
  const putOnClipboard = async (url, notice, promptLabel) => {
    try {
      await navigator.clipboard.writeText(url);
      (onNotice || onError)?.(notice);
    } catch {
      window.prompt(promptLabel, url);
    }
  };

  // Team link: carries no token — it names the organisation, and whoever opens
  // it needs their own CRM session and the portal.preview permission. Safe to
  // paste into Slack or an email to the team.
  const copyTeamLink = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/crm/portal-admin?op=preview', { companyId });
      await putOnClipboard(
        r.shareUrl,
        'Preview link copied — only signed-in team members can open it',
        'Copy this preview link:',
      );
    } catch (err) {
      onError?.(err.message || 'Could not copy the link');
    } finally {
      setBusy(false);
    }
  };

  // Client invite link: the personal sign-up/sign-in link for one person, to
  // paste into an email you're writing yourself. It signs the holder in AS that
  // contact, so the toast names them — this is not a link to forward around.
  // Minting one re-keys that person's pending invite (createPortalInvite), so
  // an earlier link they were sent stops working. Said out loud in the toast:
  // silently killing a link someone is about to click would be worse.
  const copyInviteLink = async () => {
    if (!invite?.email) {
      onError?.('Add a contact with an email to this deal first — an invite link is personal to one person.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.post('/api/crm/portal-admin?op=portal-link', {
        dealId: invite.dealId, email: invite.email, name: invite.name || null,
      });
      await putOnClipboard(
        r.url,
        `Invite link copied for ${invite.email} — personal to them, and it replaces any link they were sent before`,
        `Copy this invite link for ${invite.email}:`,
      );
    } catch (err) {
      onError?.(err.message || 'Could not create the invite link');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        className="btn-ghost"
        style={{ fontSize: size }}
        disabled={busy}
        onClick={() => go(false)}
        title="Open this client's portal exactly as they see it (read-only)"
      >
        <Eye size={size} style={{ verticalAlign: -1, marginRight: label ? 4 : 0 }} />{label ? 'View client portal' : ''}
      </button>
      <button
        className="btn-ghost"
        style={{ fontSize: size }}
        disabled={busy}
        onClick={invite ? copyInviteLink : copyTeamLink}
        title={invite
          ? `Copy the client's invite link${invite.email ? ` for ${invite.email}` : ''} to paste into an email you write yourself. It signs them in as that person, and replaces any link they were sent before.`
          : "Copy a link to this preview to send the team — they'll need to be signed in to the CRM to open it"}
      >
        <Link2 size={size} style={{ verticalAlign: -1, marginRight: label ? 4 : 0 }} />
        {label ? (invite ? 'Copy invite link' : 'Copy link') : ''}
      </button>
      <button
        className="btn-ghost"
        style={{ fontSize: size }}
        disabled={busy}
        onClick={() => go(true)}
        title="Open their portal and make changes for real — add past videos to their library, invite their team, file documents"
      >
        <PencilLine size={size} style={{ verticalAlign: -1, marginRight: label ? 4 : 0 }} />{label ? 'Manage' : ''}
      </button>
    </>
  );
}
