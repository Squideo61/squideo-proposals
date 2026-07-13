// "Client portal" card on a contact page: whether this person has portal
// access, which organisations they can see, what they've been doing in there,
// and the account controls (invite, password-reset link, sign out everywhere,
// disable/enable). Backed by /api/crm/portal-admin?contactId=.
import React, { useCallback, useEffect, useState } from 'react';
import { Building2, Clock, KeyRound, LogOut, Mail, RefreshCw, Send, Sparkles, Upload, UserCheck, UserX, FileText } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { formatRelativeTime } from '../../utils.js';
import { Card, Empty } from './Card.jsx';

const ACTIVITY_ICONS = { file: Upload, extra: Sparkles, quote: FileText };

export function PortalContactCard({ contactId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [inviteCompanyId, setInviteCompanyId] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api.get(`/api/crm/portal-admin?contactId=${encodeURIComponent(contactId)}`);
      setData(d);
      setInviteCompanyId((prev) => prev || d.companies?.[0]?.id || '');
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [contactId]);

  useEffect(() => { load(); }, [load]);

  const flash = (msg) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3500);
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

  if (error) return <Card title="Client portal"><Empty text={error} /></Card>;
  if (!data) return <Card title="Client portal"><Empty text="Loading…" /></Card>;

  if (data.noEmail) {
    return (
      <Card title={<><KeyRound size={12} style={{ verticalAlign: -1, marginRight: 5 }} />Client portal</>}>
        <Empty text="Add an email address to this contact to give them portal access." />
      </Card>
    );
  }

  const { account, memberships = [], invites = [], activity = [], companies = [] } = data;
  const puid = account?.id;

  const statusPill = account
    ? (account.disabled
      ? { label: 'Access disabled', bg: '#DC262622', color: '#B91C1C' }
      : { label: 'Has portal access', bg: '#16A34A22', color: '#15803D' })
    : (invites.length
      ? { label: 'Invite pending', bg: '#F59E0B22', color: '#B45309' }
      : { label: 'No portal access', bg: '#94A3B822', color: '#64748B' });

  return (
    <Card
      title={<><KeyRound size={12} style={{ verticalAlign: -1, marginRight: 5 }} />Client portal</>}
      action={
        <span style={{ background: statusPill.bg, color: statusPill.color, fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 5, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          {statusPill.label}
        </span>
      }
    >
      {notice && (
        <div style={{ fontSize: 12, color: '#0B6E93', background: '#EAF7FC', border: '1px solid #A9E1F5', borderRadius: 6, padding: '6px 10px', marginBottom: 10 }}>
          {notice}
        </div>
      )}

      {/* ── No account yet: invite them to one of their organisations ── */}
      {!account && (
        <>
          {invites.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              {invites.map((i) => (
                <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 12.5 }}>
                  <Mail size={12} color={BRAND.muted} />
                  <span style={{ flex: 1, color: BRAND.ink }}>
                    Invited to <strong>{i.companyName}</strong> · expires {formatRelativeTime(i.expiresAt)}
                  </span>
                  <button className="btn-ghost" disabled={busy} style={{ fontSize: 11.5 }} title="Resend invite"
                    onClick={() => run(() => api.post('/api/crm/portal-admin?op=resend-invite', { inviteId: i.id }), 'Invite resent')}>
                    <RefreshCw size={12} />
                  </button>
                  <button className="btn-ghost is-danger" disabled={busy} style={{ fontSize: 11.5 }} title="Revoke invite"
                    onClick={() => run(() => api.post('/api/crm/portal-admin?op=revoke-invite', { inviteId: i.id }), 'Invite revoked')}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          {companies.length === 0 ? (
            <Empty text="Link this contact to an organisation before inviting them — the portal shows an organisation's projects." />
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {companies.length > 1 ? (
                <select className="input" value={inviteCompanyId} onChange={(e) => setInviteCompanyId(e.target.value)} style={{ flex: 1, fontSize: 13 }}>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              ) : (
                <span style={{ flex: 1, fontSize: 13, color: BRAND.muted }}>
                  Invite them to <strong style={{ color: BRAND.ink }}>{companies[0].name}</strong>'s portal
                </span>
              )}
              <button
                className="btn"
                disabled={busy || !inviteCompanyId}
                style={{ fontSize: 12.5 }}
                onClick={() => run(
                  () => api.post('/api/crm/portal-admin?op=invite', { companyId: inviteCompanyId, email: data.email, name: account?.name }),
                  'Portal invite sent'
                )}
              >
                <Send size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Send invite
              </button>
            </div>
          )}
        </>
      )}

      {/* ── Has an account: status, orgs, activity, controls ── */}
      {account && (
        <>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12.5, color: BRAND.muted, marginBottom: 12 }}>
            <span>
              <Clock size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              {account.lastLoginAt ? `Last signed in ${formatRelativeTime(account.lastLoginAt)}` : 'Never signed in'}
            </span>
            <span>Account created {formatRelativeTime(account.createdAt)}</span>
          </div>

          <div style={{ marginBottom: 12 }}>
            {memberships.map((m) => (
              <div key={m.companyId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 13 }}>
                <Building2 size={13} color={BRAND.muted} />
                <span style={{ flex: 1, color: m.disabled ? BRAND.muted : BRAND.ink, textDecoration: m.disabled ? 'line-through' : 'none' }}>
                  {m.companyName}
                </span>
                {m.disabled ? (
                  <button className="btn-ghost" disabled={busy} style={{ fontSize: 11.5, color: '#16A34A' }}
                    onClick={() => run(() => api.post('/api/crm/portal-admin?op=enable-member', { portalUserId: puid, companyId: m.companyId }), 'Access to this organisation restored')}>
                    Restore
                  </button>
                ) : (
                  <button className="btn-ghost is-danger" disabled={busy} style={{ fontSize: 11.5 }}
                    title="Remove their access to this organisation only"
                    onClick={() => run(() => api.post('/api/crm/portal-admin?op=disable-member', { portalUserId: puid, companyId: m.companyId }), 'Removed from this organisation')}>
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, margin: '4px 0 6px' }}>
            Portal activity
          </div>
          {activity.length === 0 ? (
            <div style={{ fontSize: 12.5, color: BRAND.muted, fontStyle: 'italic', marginBottom: 12 }}>
              Nothing yet — uploads, extras and video requests they make in the portal show here.
            </div>
          ) : (
            <div style={{ marginBottom: 12 }}>
              {activity.map((a, i) => {
                const Icon = ACTIVITY_ICONS[a.type] || FileText;
                const body = (
                  <>
                    <Icon size={12} color={BRAND.muted} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.text}</span>
                    <span style={{ color: BRAND.muted, fontSize: 11.5, flexShrink: 0 }}>{formatRelativeTime(a.at)}</span>
                  </>
                );
                return a.link ? (
                  <a key={i} href={a.link} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 12.5, textDecoration: 'none' }}>
                    {body}
                  </a>
                ) : (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 12.5 }}>
                    {body}
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderTop: '1px solid ' + BRAND.border, paddingTop: 10 }}>
            <button className="btn-ghost" disabled={busy} style={{ fontSize: 12 }}
              title="Email them a single-use link to choose a new password (expires in 60 minutes)"
              onClick={() => run(() => api.post('/api/crm/portal-admin?op=user-reset-link', { portalUserId: puid }), `Password-reset link emailed to ${account.email}`)}>
              <Mail size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Send password reset
            </button>
            <button className="btn-ghost" disabled={busy} style={{ fontSize: 12 }}
              title="End their portal sessions on every device (they can sign back in)"
              onClick={() => run(() => api.post('/api/crm/portal-admin?op=user-signout', { portalUserId: puid }), 'Signed out on all their devices')}>
              <LogOut size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Sign out everywhere
            </button>
            {account.disabled ? (
              <button className="btn-ghost" disabled={busy} style={{ fontSize: 12, color: '#16A34A' }}
                onClick={() => run(() => api.post('/api/crm/portal-admin?op=user-enable', { portalUserId: puid }), 'Portal access restored')}>
                <UserCheck size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Restore access
              </button>
            ) : (
              <button className="btn-ghost is-danger" disabled={busy} style={{ fontSize: 12 }}
                title="Block this person from the portal entirely — sessions end immediately"
                onClick={() => {
                  if (!window.confirm(`Revoke ${account.name || account.email}'s portal access? They'll be signed out immediately and can't sign back in.`)) return;
                  run(() => api.post('/api/crm/portal-admin?op=user-disable', { portalUserId: puid }), 'Portal access revoked');
                }}>
                <UserX size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Revoke access
              </button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
