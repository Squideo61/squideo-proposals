// Org team: everyone with portal access, everyone else we hold at the
// organisation (so nobody has to remember who's missing), plus self-serve
// colleague invites — hard-bound to this organisation server-side.
import React, { useCallback, useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState, SectionHeading, fmtDate } from '../components.jsx';
import { UserPlus, Mail, Clock, Send } from 'lucide-react';

// Staff in manage mode don't send the standard invite — they hand off to the
// CRM, which mints the invite and opens the email composer prefilled from the
// "Client portal invite" template. The composer only exists in the CRM bundle,
// hence the new tab. Clients inviting their own colleagues never come through
// here: their invite sends the standard branded email straight away.
function openComposeInvite({ companyId, email, name }) {
  const q = new URLSearchParams({ portalInvite: companyId, portalInviteEmail: email });
  if (name) q.set('portalInviteName', name);
  window.open(`/?${q.toString()}`, '_blank', 'noopener');
}

export default function Team() {
  const { user, companyId, manageMode, showToast } = usePortal();
  const [data, setData] = useState(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [invitingId, setInvitingId] = useState(null);
  const companyName = user?.companies?.find((c) => c.id === companyId)?.name;

  const load = useCallback(async () => {
    if (!companyId) return;
    setData(await portalApi.get(`team?companyId=${encodeURIComponent(companyId)}`));
  }, [companyId]);

  useEffect(() => { load().catch((err) => showToast(err.message)); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const invite = async (e) => {
    e.preventDefault();
    if (manageMode) {
      openComposeInvite({ companyId, email, name });
      setEmail(''); setName('');
      return;
    }
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

  // One-click invite for someone we already have on file — no retyping.
  const inviteContact = async (c) => {
    if (manageMode) {
      openComposeInvite({ companyId, email: c.email, name: c.name });
      return;
    }
    setInvitingId(c.id);
    try {
      await portalApi.post(`team?companyId=${encodeURIComponent(companyId)}`, { email: c.email, name: c.name });
      showToast(`Invite sent to ${c.email} ✓`);
      await load();
    } catch (err) {
      showToast(err.message);
    } finally {
      setInvitingId(null);
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
          Everyone we have at {companyName || 'your organisation'} — invite the ones who aren't on the portal yet so nobody's out of the loop.
        </p>
      </div>

      <Card>
        <SectionHeading>Invite a colleague</SectionHeading>
        <form onSubmit={invite} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input className="input" placeholder="Their name (optional)" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 150 }} />
          <input className="input" type="email" required placeholder="colleague@company.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 2, minWidth: 200 }} />
          <button className="btn" type="submit" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <UserPlus size={15} /> {busy ? 'Sending…' : manageMode ? 'Write invite' : 'Send invite'}
          </button>
        </form>
        <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 8 }}>
          {manageMode
            ? 'Staff: this opens the CRM composer with their invite link, so you can write the email yourself.'
            : `They'll get an email invite to ${companyName || 'your organisation'}'s portal — they can only ever see your organisation's projects.`}
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
                <PersonRow
                  key={m.id}
                  name={m.name}
                  email={m.email}
                  jobTitle={m.jobTitle}
                  isYou={m.email === user?.email}
                  right={
                    <>
                      <Pill label="Portal access" bg="#DCFCE7" color="#15803D" />
                      <span style={{ fontSize: 11.5, color: BRAND.muted, flexShrink: 0 }}>Joined {fmtDate(m.joinedAt)}</span>
                    </>
                  }
                />
              ))}
              {/* People we hold at the organisation who've never been invited.
                  Shown so the client can see the gaps and close them in a click. */}
              {(data.contacts || []).map((c) => (
                <PersonRow
                  key={c.id}
                  name={c.name}
                  email={c.email}
                  jobTitle={c.jobTitle}
                  muted
                  right={
                    <>
                      <Pill label="Not on the portal" bg="#F1F5F9" color="#64748B" />
                      <button
                        className="btn"
                        disabled={invitingId === c.id}
                        onClick={() => inviteContact(c)}
                        style={{ fontSize: 12.5, padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}
                      >
                        <Send size={13} /> {invitingId === c.id ? 'Sending…' : manageMode ? 'Write invite' : 'Invite'}
                      </button>
                    </>
                  }
                />
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
            {data.members.length === 0 && (data.invites || []).length === 0 && (data.contacts || []).length === 0 && (
              <EmptyState title="Just you so far" body="Invite colleagues above so your whole team can follow progress." />
            )}
          </>
        )}
      </Card>
    </div>
  );
}

function Pill({ label, bg, color }) {
  return (
    <span style={{
      background: bg, color, fontSize: 10.5, fontWeight: 700, flexShrink: 0,
      padding: '3px 8px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: 0.4,
    }}>
      {label}
    </span>
  );
}

function PersonRow({ name, email, jobTitle, isYou, muted, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 4px', borderBottom: `1px solid ${BRAND.border}`, flexWrap: 'wrap' }}>
      <div style={{
        width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
        background: muted ? '#F1F5F9' : BRAND.blue + '22', color: muted ? '#94A3B8' : BRAND.blue,
        display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 13,
      }}>
        {(name || email || '?')[0].toUpperCase()}
      </div>
      <div style={{ flex: 1, minWidth: 140 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink }}>
          {name || email} {isYou && <span style={{ color: BRAND.muted, fontWeight: 500 }}>(you)</span>}
        </div>
        <div style={{ fontSize: 11.5, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {[email, jobTitle].filter(Boolean).join(' · ')}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{right}</div>
    </div>
  );
}
