// "Customer portal" card on the company page: who has portal access, pending
// invites, and the staff controls (invite / resend / revoke / disable).
// Backed by /api/crm/portal-admin.
import React, { useCallback, useEffect, useState } from 'react';
import { Eye, KeyRound, Mail, RefreshCw, Send, UserX, UserCheck } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { formatRelativeTime } from '../../utils.js';
import { Card, Empty } from './Card.jsx';

export function PortalMembersCard({ companyId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/api/crm/portal-admin?companyId=${encodeURIComponent(companyId)}`));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  const flash = (msg) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3000);
  };

  const run = async (fn, okMsg) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) flash(okMsg);
      await load();
    } catch (err) {
      flash(err.message);
    } finally {
      setBusy(false);
    }
  };

  const invite = (e) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    run(
      () => api.post('/api/crm/portal-admin?op=invite', { companyId, email: inviteEmail.trim() }),
      `Invite sent to ${inviteEmail.trim()}`
    ).then(() => { setInviteEmail(''); setShowInvite(false); });
  };

  const members = data?.members || [];
  const invites = data?.invites || [];

  const preview = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/crm/portal-admin?op=preview', { companyId });
      // Cookie-free: the token rides in the URL and is stashed per-tab by the
      // portal on load, so opening it can't disturb a real client's session.
      window.open(r.url, '_blank', 'noopener');
    } catch (err) {
      flash(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={<><KeyRound size={12} style={{ verticalAlign: -1, marginRight: 5 }} />Customer portal</>}
      count={members.length || undefined}
      action={
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn-ghost" style={{ fontSize: 12 }} disabled={busy} onClick={preview} title="Open this client's portal exactly as they see it (read-only)">
            <Eye size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Preview
          </button>
          <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowInvite((v) => !v)}>
            <Send size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Invite
          </button>
        </div>
      }
    >
      {notice && (
        <div style={{ fontSize: 12, color: '#0B6E93', background: '#EAF7FC', border: '1px solid #A9E1F5', borderRadius: 6, padding: '6px 10px', marginBottom: 10 }}>
          {notice}
        </div>
      )}

      {showInvite && (
        <form onSubmit={invite} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            className="input"
            type="email"
            required
            placeholder="client@company.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            style={{ flex: 1, fontSize: 13 }}
          />
          <button className="btn" type="submit" disabled={busy} style={{ fontSize: 12.5 }}>Send</button>
        </form>
      )}

      {error && <Empty text={error} />}
      {!error && !data && <Empty text="Loading…" />}
      {data && members.length === 0 && invites.length === 0 && (
        <Empty text="No portal members yet — clients get an invite automatically when they sign a proposal, or invite one above." />
      )}

      {members.map((m) => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid ' + BRAND.border, fontSize: 13 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, color: m.disabled ? BRAND.muted : BRAND.ink, textDecoration: m.disabled ? 'line-through' : 'none' }}>
              {m.name || m.email}
            </div>
            <div style={{ fontSize: 11.5, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {m.email}
              {m.lastLoginAt ? ` · last seen ${formatRelativeTime(m.lastLoginAt)}` : ' · never signed in'}
            </div>
          </div>
          {m.disabled ? (
            <button
              className="btn-ghost"
              disabled={busy}
              style={{ fontSize: 12, color: '#16A34A' }}
              title="Restore portal access"
              onClick={() => run(() => api.post('/api/crm/portal-admin?op=enable-member', { portalUserId: m.id, companyId }), 'Access restored')}
            >
              <UserCheck size={13} style={{ verticalAlign: -2, marginRight: 3 }} />Enable
            </button>
          ) : (
            <button
              className="btn-ghost is-danger"
              disabled={busy}
              style={{ fontSize: 12 }}
              title="Disable portal access for this person (sessions end immediately)"
              onClick={() => run(() => api.post('/api/crm/portal-admin?op=disable-member', { portalUserId: m.id, companyId }), 'Access disabled')}
            >
              <UserX size={13} style={{ verticalAlign: -2, marginRight: 3 }} />Disable
            </button>
          )}
        </div>
      ))}

      {invites.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
            Pending invites
          </div>
          {invites.map((i) => (
            <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 12.5 }}>
              <Mail size={12} color={BRAND.muted} />
              <span style={{ flex: 1, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.email}</span>
              {i.expired && <span style={{ color: '#DC2626', fontSize: 11 }}>expired</span>}
              <button
                className="btn-ghost"
                disabled={busy}
                style={{ fontSize: 11.5 }}
                title="Resend invite (new link, 14 days)"
                onClick={() => run(() => api.post('/api/crm/portal-admin?op=resend-invite', { inviteId: i.id }), `Invite resent to ${i.email}`)}
              >
                <RefreshCw size={12} style={{ verticalAlign: -2 }} />
              </button>
              <button
                className="btn-ghost is-danger"
                disabled={busy}
                style={{ fontSize: 11.5 }}
                title="Revoke invite"
                onClick={() => run(() => api.post('/api/crm/portal-admin?op=revoke-invite', { inviteId: i.id }), 'Invite revoked')}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
