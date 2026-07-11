// Org team: everyone with portal access, plus self-serve colleague invites
// (hard-bound to this organisation server-side).
import React, { useCallback, useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState, SectionHeading, fmtDate } from '../components.jsx';
import { UserPlus, Mail, Clock } from 'lucide-react';

export default function Team() {
  const { user, companyId, showToast } = usePortal();
  const [data, setData] = useState(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const companyName = user?.companies?.find((c) => c.id === companyId)?.name;

  const load = useCallback(async () => {
    if (!companyId) return;
    setData(await portalApi.get(`team?companyId=${encodeURIComponent(companyId)}`));
  }, [companyId]);

  useEffect(() => { load().catch((err) => showToast(err.message)); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const invite = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await portalApi.post(`team?companyId=${encodeURIComponent(companyId)}`, { email, name });
      showToast(`Invite sent to ${email} ✓`);
      setEmail(''); setName('');
      await load();
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (inviteId) => {
    try {
      await portalApi.post('team-revoke-invite', { inviteId });
      await load();
    } catch (err) {
      showToast(err.message);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: BRAND.ink }}>Your team</h1>
        <p style={{ margin: '6px 0 0', fontSize: 13.5, color: BRAND.muted }}>
          Everyone at {companyName || 'your organisation'} with portal access — invite colleagues so nobody's out of the loop.
        </p>
      </div>

      <Card>
        <SectionHeading>Invite a colleague</SectionHeading>
        <form onSubmit={invite} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input className="input" placeholder="Their name (optional)" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 150 }} />
          <input className="input" type="email" required placeholder="colleague@company.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 2, minWidth: 200 }} />
          <button className="btn" type="submit" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <UserPlus size={15} /> {busy ? 'Sending…' : 'Send invite'}
          </button>
        </form>
        <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 8 }}>
          They'll get an email invite to {companyName || 'your organisation'}'s portal — they can only ever see your organisation's projects.
        </div>
      </Card>

      <Card>
        <SectionHeading>Members</SectionHeading>
        {!data ? (
          <div style={{ color: BRAND.muted, fontSize: 13, textAlign: 'center', padding: 10 }}>Loading…</div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {data.members.map((m) => (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 4px', borderBottom: `1px solid ${BRAND.border}` }}>
                  <div style={{
                    width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
                    background: BRAND.blue + '22', color: BRAND.blue,
                    display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 13,
                  }}>
                    {(m.name || m.email)[0].toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink }}>
                      {m.name || m.email} {m.email === user?.email && <span style={{ color: BRAND.muted, fontWeight: 500 }}>(you)</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {[m.email, m.jobTitle].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div style={{ fontSize: 11.5, color: BRAND.muted, flexShrink: 0 }}>
                    Joined {fmtDate(m.joinedAt)}
                  </div>
                </div>
              ))}
            </div>
            {(data.invites || []).length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.muted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  Pending invites
                </div>
                {data.invites.map((i) => (
                  <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', fontSize: 13 }}>
                    <Mail size={14} color={BRAND.muted} />
                    <span style={{ flex: 1, color: BRAND.ink }}>{i.email}</span>
                    <span style={{ fontSize: 11.5, color: BRAND.muted, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <Clock size={12} /> expires {fmtDate(i.expiresAt)}
                    </span>
                    <button className="btn-ghost" style={{ fontSize: 12, color: '#DC2626' }} onClick={() => revoke(i.id)}>Revoke</button>
                  </div>
                ))}
              </div>
            )}
            {data.members.length === 0 && (data.invites || []).length === 0 && (
              <EmptyState title="Just you so far" body="Invite colleagues above so your whole team can follow progress." />
            )}
          </>
        )}
      </Card>
    </div>
  );
}
