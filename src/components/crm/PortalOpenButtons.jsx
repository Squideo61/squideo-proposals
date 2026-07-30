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
import { Eye, PencilLine } from 'lucide-react';
import { api } from '../../api.js';

export async function openPortalAs(companyId, { manage = false } = {}) {
  const r = await api.post('/api/crm/portal-admin?op=preview', { companyId, manage });
  window.open(r.url, '_blank', 'noopener');
}

export function PortalOpenButtons({ companyId, onError, size = 12, label = true }) {
  const [busy, setBusy] = useState(false);
  if (!companyId) return null;

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

  return (
    <>
      <button
        className="btn-ghost"
        style={{ fontSize: size }}
        disabled={busy}
        onClick={() => go(false)}
        title="Open this client's portal exactly as they see it (read-only)"
      >
        <Eye size={size} style={{ verticalAlign: -1, marginRight: label ? 4 : 0 }} />{label ? 'Preview' : ''}
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
