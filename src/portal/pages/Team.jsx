// Org team: everyone with portal access, everyone else we hold at the
// organisation (so nobody has to remember who's missing), plus self-serve
// colleague invites — hard-bound to this organisation server-side.
import React, { useCallback, useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState, SectionHeading, fmtDate } from '../components.jsx';
import { UserPlus, Mail, Clock, Send, Search, Link2 } from 'lucide-react';
import InviteComposer from '../../components/InviteComposer.jsx';

export default function Team() {
  const { user, companyId, manageMode, preview, showToast } = usePortal();
  const [data, setData] = useState(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [invitingId, setInvitingId] = useState(null);
  const [composeFor, setComposeFor] = useState(null); // { email, name } in manage mode
  const companyName = user?.companies?.find((c) => c.id === companyId)?.name;

  const load = useCallback(async () => {
    if (!companyId) return;
    setData(await portalApi.get(`team?companyId=${encodeURIComponent(companyId)}`));
  }, [companyId]);

  useEffect(() => { load().catch((err) => showToast(err.message)); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  // Staff in manage mode write the email themselves; a client inviting their
  // own colleague sends the standard branded invite immediately.
  const invite = async (e) => {
    e.preventDefault();
    if (manageMode) {
      setComposeFor({ email, name });
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
      setComposeFor({ email: c.email, name: c.name });
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
      {composeFor && (
        <InviteComposer
          companyId={companyId}
          email={composeFor.email}
          name={composeFor.name}
          senderName={preview?.staffEmail || null}
          onClose={() => setComposeFor(null)}
          onSent={(sentTo) => {
            setComposeFor(null);
            setEmail(''); setName('');
            showToast(`Invite sent to ${sentTo} ✓`);
            load().catch(() => {});
          }}
        />
      )}
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
            ? 'Staff: opens an editable email with their invite link, sent from your Gmail.'
            : `They'll get an email invite to ${companyName || 'your organisation'}'s portal — they can only ever see your organisation's projects.`}
        </div>
      </Card>

      {manageMode && (
        <AddContact
          companyId={companyId}
          companyName={companyName}
          onAdded={(c) => {
            showToast(`${c.name || c.email} added to ${companyName || 'the organisation'} ✓`);
            load().catch(() => {});
          }}
          onError={showToast}
        />
      )}

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

// Staff-only. The team list can only show people we hold at the organisation,
// so this is how the gaps get closed without leaving the portal: attach someone
// already in the contact book, or add a new person. Both write a real CRM
// contact linked to the organisation — the same record the org page shows — so
// they're then one click from an invite in the list below.
function AddContact({ companyId, companyName, onAdded, onError }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [pending, setPending] = useState(null); // contact id being linked, or 'new'
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [title, setTitle] = useState('');

  // Search as they type. Under two characters isn't a search, it's the whole
  // contact book — the server returns nothing, so don't ask.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults(null); setSearching(false); return undefined; }
    setSearching(true);
    const t = window.setTimeout(async () => {
      try {
        const r = await portalApi.get(
          `team-contact?companyId=${encodeURIComponent(companyId)}&q=${encodeURIComponent(term)}`,
        );
        setResults(r.results || []);
      } catch (err) {
        onError(err.message);
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [q, companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const attach = async (payload, key) => {
    if (pending) return;
    setPending(key);
    try {
      const r = await portalApi.post(`team-contact?companyId=${encodeURIComponent(companyId)}`, payload);
      setQ(''); setResults(null); setName(''); setEmail(''); setTitle('');
      onAdded(r.contact);
    } catch (err) {
      onError(err.message);
    } finally {
      setPending(null);
    }
  };

  const hint = { fontSize: 12.5, color: BRAND.muted, padding: '8px 2px' };

  return (
    <Card style={{ border: '1px solid #F5C26B', background: '#FFFCF5' }}>
      <SectionHeading>Add someone to this organisation</SectionHeading>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
        Staff only. Attach a contact we already have to {companyName || 'this organisation'}, or add a new
        one — either way it's a real CRM contact linked to the organisation, not a portal-only entry. Invite
        them to the portal afterwards from the list below.
      </p>

      <div style={{ position: 'relative' }}>
        <Search size={14} color={BRAND.muted} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)' }} />
        <input
          className="input"
          placeholder="Search our contacts by name or email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: '100%', paddingLeft: 32 }}
        />
      </div>

      {q.trim().length >= 2 && (
        <div style={{ marginTop: 6 }}>
          {searching && !results && <div style={hint}>Searching…</div>}
          {results && results.length === 0 && (
            <div style={hint}>Nobody new matches that — add them below.</div>
          )}
          {(results || []).map((c) => (
            <div key={c.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              padding: '9px 2px', borderBottom: `1px solid ${BRAND.border}`,
            }}>
              <div style={{ flex: 1, minWidth: 150 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink }}>{c.name || c.email}</div>
                <div style={{ fontSize: 11.5, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {[c.name ? c.email : null, c.jobTitle, c.companyName].filter(Boolean).join(' · ')}
                </div>
              </div>
              <button
                className="btn"
                disabled={!!pending}
                onClick={() => attach({ contactId: c.id }, c.id)}
                style={{ fontSize: 12.5, padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}
              >
                <Link2 size={13} /> {pending === c.id ? 'Linking…' : 'Link'}
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0 12px' }}>
        <div style={{ flex: 1, height: 1, background: '#EFE2C4' }} />
        <span style={{ fontSize: 10.5, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          or add someone new
        </span>
        <div style={{ flex: 1, height: 1, background: '#EFE2C4' }} />
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); attach({ name, email, title }, 'new'); }}
        style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}
      >
        <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        <input className="input" type="email" required placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 2, minWidth: 190 }} />
        <input className="input" placeholder="Job title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        <button className="btn" type="submit" disabled={!!pending} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <UserPlus size={15} /> {pending === 'new' ? 'Adding…' : 'Add contact'}
        </button>
      </form>
      <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 8 }}>
        An address we already hold is linked to their existing contact rather than duplicated.
      </div>
    </Card>
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
