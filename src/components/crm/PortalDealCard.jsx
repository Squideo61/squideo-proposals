// "Client portal" card on the deal page: manage the discounted extras offers
// the client sees in their portal (derived from the proposal, plus custom
// upsells), tune the per-deal discount, and resend the portal welcome invite.
// Backed by /api/crm/portal-admin.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, ChevronDown, ChevronRight, Eye, EyeOff, Plus, Send, Sparkles, Trash2, UserPlus, X,
} from 'lucide-react';
// (Eye/EyeOff mark an offer hidden or shown.)
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { useStore } from '../../store.jsx';
import { permissionsInclude } from '../../lib/permissions.js';
import { formatGBP } from '../../utils.js';
import { Card, Empty } from './Card.jsx';
import { Modal } from '../ui.jsx';
import { PortalStepsActivity } from './PortalStepsActivity.jsx';
import { ClientBriefBlock } from './ClientBriefBlock.jsx';
import { PortalOpenButtons } from './PortalOpenButtons.jsx';
import { pickInviteDefaults } from '../../lib/portalInviteRecipients.js';

// Pick who gets a portal invite for this deal. Defaults to the deal's contacts
// + proposal signer (anyone who doesn't already have access is pre-ticked);
// extra emails can be typed in and optionally saved as CRM contacts.
function InviteModal({ dealId, data, inviterName, onClose, onSent }) {
  const candidates = data?.candidates || [];
  // The invite is addressed to the deal's PRIMARY contact and nobody else by
  // default. It used to tick everyone who lacked access, which on a deal with
  // several contacts meant the main one was just another name on a list — and
  // if the list came back in the wrong order (it could; the query wasn't
  // ordered) they could be left off while a secondary got the invite.
  //
  // Falling back to the first candidate keeps deals with no primary set working
  // exactly as before rather than opening the modal with nothing chosen.
  // The rule itself lives in src/lib/portalInviteRecipients.js so it can be
  // tested; this only holds what the sender has since changed.
  const defaults = useMemo(() => pickInviteDefaults(candidates), [candidates]);
  const [picked, setPicked] = useState(() => new Set(defaults.to ? [defaults.to.email] : []));
  const [ccPicked, setCcPicked] = useState(() => new Set(defaults.cc));
  const [extras, setExtras] = useState([]); // [{ email, name, createContact }]
  const [newEmail, setNewEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The wording that will go out. Seeded with the standard copy (matching the
  // server's fallback exactly) so what's on screen is what sends — Squideo
  // sends this one, so this is the only chance to read it first.
  const org = data?.companyName || 'your team';
  const [subject, setSubject] = useState(
    `${inviterName || 'A colleague'} invited you to ${org}'s Squideo portal`
  );
  const [message, setMessage] = useState(
    "Track your team's video projects, review drafts, share files and download finished videos — all in one place."
  );

  const toggle = (email) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email); else next.add(email);
      return next;
    });
    // Nobody is both addressed and copied — an invite of their own beats a
    // carbon copy of someone else's.
    setCcPicked((prev) => {
      const next = new Set(prev);
      next.delete(email);
      return next;
    });
  };

  const toggleCc = (email) => setCcPicked((prev) => {
    const next = new Set(prev);
    if (next.has(email)) next.delete(email); else next.add(email);
    return next;
  });

  const addExtra = () => {
    const email = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError('Enter a valid email address');
    if (candidates.some((c) => c.email === email) || extras.some((e) => e.email === email)) {
      return setError('That email is already on the list');
    }
    setExtras((all) => [...all, { email, name: '', createContact: true }]);
    setNewEmail('');
    setError(null);
  };

  const send = async () => {
    const recipients = [
      ...candidates.filter((c) => picked.has(c.email)).map((c) => ({ email: c.email, name: c.name })),
      ...extras.map((e) => ({ email: e.email, name: e.name || null, createContact: e.createContact })),
    ];
    if (!recipients.length) return setError('Pick at least one person to invite');
    if (!subject.trim()) return setError('Give the email a subject');
    setBusy(true);
    setError(null);
    try {
      const cc = candidates
        .filter((c) => ccPicked.has(c.email) && !picked.has(c.email))
        .map((c) => ({ email: c.email, name: c.name }));
      const r = await api.post('/api/crm/portal-admin?op=invite-deal', {
        dealId, recipients, cc, subject: subject.trim(), message: message.trim(),
      });
      onSent(`Portal invite sent to ${r.sent.length} ${r.sent.length === 1 ? 'person' : 'people'}`
        + (r.failed?.length ? ` — ${r.failed.length} failed` : ''));
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const total = picked.size + extras.length;

  return (
    <Modal onClose={onClose} maxWidth={520}>
      <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700 }}>Invite to the client portal</h3>
      <div style={{ fontSize: 12.5, color: BRAND.muted, marginBottom: 16 }}>
        The invite goes to the deal's primary contact, with the rest of the deal's
        people copied in. Everyone ticked on the left gets their own login for{' '}
        <strong>{data?.companyName || 'this organisation'}</strong>; anyone marked CC just
        sees that it's happened.
      </div>

      {candidates.length === 0 && (
        <Empty text="This deal has no contacts with an email yet — add one below." />
      )}

      {candidates.map((c) => (
        <label
          key={c.email}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0',
            borderBottom: '1px solid ' + BRAND.border, cursor: c.hasAccess ? 'default' : 'pointer',
            opacity: c.hasAccess ? 0.55 : 1,
          }}
        >
          <input
            type="checkbox"
            disabled={c.hasAccess}
            checked={picked.has(c.email)}
            onChange={() => toggle(c.email)}
            style={{ width: 16, height: 16, flexShrink: 0 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: BRAND.ink, display: 'flex', alignItems: 'center', gap: 7 }}>
              {c.name || c.email}
              {c.primary && (
                <span style={{
                  background: '#EAF6FB', color: '#0B6E93', border: '1px solid #BFE0EE', borderRadius: 999,
                  padding: '1px 7px', fontSize: 10, fontWeight: 800, letterSpacing: 0.3, textTransform: 'uppercase',
                }}>
                  Primary
                </span>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.name ? `${c.email} · ` : ''}{c.source}
            </div>
          </div>
          {/* Copied in rather than invited. Only offered to people who aren't
              already getting their own invite — being both is meaningless. */}
          {!c.hasAccess && !picked.has(c.email) && (
            <label
              onClick={(e) => e.stopPropagation()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: ccPicked.has(c.email) ? BRAND.blue : BRAND.muted, flexShrink: 0, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={ccPicked.has(c.email)}
                onChange={() => toggleCc(c.email)}
                style={{ width: 13, height: 13 }}
              />
              CC
            </label>
          )}
          {c.hasAccess && (
            <span style={{ fontSize: 10.5, fontWeight: 700, color: '#16A34A', display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
              <Check size={12} /> HAS ACCESS
            </span>
          )}
          {!c.hasAccess && c.invitePending && (
            <span style={{ fontSize: 10.5, fontWeight: 700, color: '#B45309', flexShrink: 0 }}>INVITE PENDING</span>
          )}
        </label>
      ))}

      {extras.map((e, i) => (
        <div key={e.email} style={{ padding: '9px 0', borderBottom: '1px solid ' + BRAND.border }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <UserPlus size={15} color={BRAND.blue} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {e.email}
            </div>
            <button
              className="btn-ghost"
              style={{ padding: 4 }}
              onClick={() => setExtras((all) => all.filter((_, j) => j !== i))}
              title="Remove"
            >
              <X size={13} />
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, paddingLeft: 25 }}>
            <input
              className="input"
              placeholder="Their name (optional)"
              value={e.name}
              onChange={(ev) => setExtras((all) => all.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)))}
              style={{ flex: 1, fontSize: 12.5, padding: '4px 8px' }}
            />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6, paddingLeft: 25, fontSize: 12, color: BRAND.muted, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={e.createContact}
              onChange={(ev) => setExtras((all) => all.map((x, j) => (j === i ? { ...x, createContact: ev.target.checked } : x)))}
            />
            Also add them as a contact on this deal
          </label>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <input
          className="input"
          type="email"
          placeholder="Add another email…"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExtra(); } }}
          style={{ flex: 1, fontSize: 13 }}
        />
        <button className="btn-ghost" onClick={addExtra} style={{ fontSize: 12.5 }}>
          <Plus size={13} style={{ verticalAlign: -2, marginRight: 3 }} />Add
        </button>
      </div>

      {/* The draft. Squideo sends this from its own address, wrapped in the
          branded template with the "Join the portal" button and the personal
          link below it — so only the words above the button are editable. */}
      <div style={{ marginTop: 18, borderTop: '1px solid ' + BRAND.border, paddingTop: 14 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.ink, marginBottom: 8 }}>What they'll receive</div>
        <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: BRAND.muted, marginBottom: 3 }}>Subject</label>
        <input
          className="input"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          style={{ width: '100%', fontSize: 13, boxSizing: 'border-box' }}
        />
        <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: BRAND.muted, margin: '10px 0 3px' }}>Message</label>
        <textarea
          className="input"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          style={{ width: '100%', fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }}
        />
        <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 6, lineHeight: 1.5 }}>
          Sent from Squideo, with a <strong>Join the portal</strong> button and each person's own sign-up link underneath.
          Everyone picked above gets the same wording.
        </div>
      </div>

      {error && (
        <div style={{ fontSize: 12.5, color: '#B91C1C', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 6, padding: '7px 10px', marginTop: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy || total === 0} onClick={send}>
          <Send size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
          {busy ? 'Sending…' : total > 0 ? `Send ${total} invite${total === 1 ? '' : 's'}` : 'Send invites'}
        </button>
      </div>
    </Modal>
  );
}

// A ready-to-edit intro email body containing the client's portal link. The PM
// opens this in the composer, tweaks the wording (or loads a saved template),
// and sends. bodyHtml is seeded into the rich-text editor.
export function introEmailHtml({ name, url }) {
  const hi = name ? `Hi ${name},` : 'Hi there,';
  return `<p>${hi}</p>`
    + `<p>Great news — your project is underway! To get started, head to your portal where you can choose your voiceover artist and book your kick-off call:</p>`
    + `<p><a href="${url}" style="color:#2BB8E6;font-weight:600;">Open your Squideo portal &rarr;</a></p>`
    + `<p>Any questions, just reply to this email.</p>`;
}

// Draft the client's intro email and open it in the composer. Fetches the deal's
// current portal contacts *fresh* (a cached list goes stale the moment you add a
// contact), generates the client's portal link — which marks the deal's tasks as
// launched — and seeds the composer with an editable intro that already contains
// it. Shared by the portal card and the deal-header button. Throws on no contact.
export async function launchIntroEmail({ actions, dealId, dealTitle = null }) {
  const info = await api.get(`/api/crm/portal-admin?dealId=${encodeURIComponent(dealId)}`);
  const contact = (info?.candidates || []).find((c) => c.email);
  if (!contact) throw new Error('This deal has no contact with an email — add one first.');
  const { url } = await actions.generatePortalLink(dealId, contact.email, { markIntro: true });
  actions.openComposer({
    dealId,
    dealTitle,
    contactEmail: contact.email,
    initialDraft: {
      to: contact.email,
      subject: dealTitle ? `${dealTitle} — let’s get started` : 'Your project — let’s get started',
      body: introEmailHtml({ name: contact.name?.split(' ')[0] || null, url }),
    },
  });
}

// Heading for the proposal-derived extras list, which is collapsed by default:
// the deal team quotes extras from the proposal itself, so the full price list
// only needs to be on screen when someone is actually changing what the client
// is offered. The counts describe what the CLIENT sees (customs included, since
// they're offered too) so the one line is enough on its own. Degrades to a plain
// heading when there are no proposal extras to expand — same trick as
// TaskSection on the deal page.
function ExtrasHeader({ live, hidden, discountPct, collapsed, onToggle }) {
  const base = {
    display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap',
    fontSize: 11, fontWeight: 700, color: BRAND.muted,
    textTransform: 'uppercase', letterSpacing: 0.5, padding: '6px 0',
  };
  const label = (
    <>
      Portal extras
      <span style={{ opacity: 0.75 }}>· {live} live</span>
      {hidden > 0 && <span style={{ opacity: 0.75 }}>· {hidden} hidden</span>}
      <span style={{ marginLeft: 'auto', color: BRAND.blue }}>{discountPct}% off</span>
    </>
  );
  if (!onToggle) return <div style={base}>{label}</div>;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={collapsed ? 'Show the extras offered in the client portal' : 'Hide the extras list'}
      style={{
        ...base, width: '100%', background: 'transparent', border: 'none',
        cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
      }}
    >
      {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
      {label}
    </button>
  );
}

export function PortalDealCard({ dealId, dealTitle = null }) {
  const { state, actions, showMsg } = useStore();
  // Production Managers run the portal (portal.manage) but releasing the final
  // video before it's paid for is a money call — that stays with invoices.manage,
  // so don't offer them a button the server will refuse.
  const canRelease = permissionsInclude(state.session?.permissions, 'invoices.manage');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [showCustom, setShowCustom] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showExtras, setShowExtras] = useState(false);
  const [custom, setCustom] = useState({ title: '', description: '', amount: '' });
  const [discountEdit, setDiscountEdit] = useState(null); // % string while editing

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/api/crm/portal-admin?dealId=${encodeURIComponent(dealId)}`));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [dealId]);

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

  const saveDiscount = () => {
    const pct = Number(discountEdit);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return flash('Enter a percentage between 0 and 100');
    run(() => api.post('/api/crm/portal-admin?op=set-discount', { dealId, discount: pct / 100 }), 'Discount updated')
      .then(() => setDiscountEdit(null));
  };

  // Hide/show a proposal-derived offer: an 'override' row with hidden toggled.
  const toggleDerived = (offer) => {
    const extraId = offer.key.startsWith('prop:') ? offer.key.slice(5).split(':')[0] : null;
    if (!extraId) return;
    const existing = (data?.offers || []).find((o) => o.kind === 'override' && o.proposalExtraId === extraId);
    if (existing) {
      run(() => api.post('/api/crm/portal-admin?op=offer-update', { id: existing.id, hidden: !existing.hidden }));
    } else {
      run(() => api.post('/api/crm/portal-admin?op=offer-create', { dealId, kind: 'override', proposalExtraId: extraId, hidden: true }));
    }
  };

  const addCustom = (e) => {
    e.preventDefault();
    run(
      () => api.post('/api/crm/portal-admin?op=offer-create', {
        dealId, kind: 'custom',
        title: custom.title, description: custom.description || null, amount: Number(custom.amount),
      }),
      'Custom offer added'
    ).then(() => { setShowCustom(false); setCustom({ title: '', description: '', amount: '' }); });
  };

  // Who a copied invite link is minted for: the first deal contact with an
  // email, matching launchIntroEmail so the link and the intro email always
  // name the same person.
  const inviteContact = (data?.candidates || []).find((c) => c.email) || null;
  // `derived` carries the custom offers too, but those are rendered from the
  // raw rows below (which alone have the description and a delete button), so
  // take only the proposal-derived ones here — otherwise every custom upsell
  // appears on the card twice.
  const proposalOffers = (data?.derived || []).filter((o) => o.kind === 'proposal');
  const customOffers = (data?.offers || []).filter((o) => o.kind === 'custom');
  const allOffers = [...proposalOffers, ...customOffers];
  const liveCount = allOffers.filter((o) => !o.hidden).length;
  const hiddenCount = allOffers.length - liveCount;
  const discountPct = Math.round((data?.discount ?? 0.10) * 100);

  return (
    <Card
      title={<><Sparkles size={12} style={{ verticalAlign: -1, marginRight: 5 }} />Client portal</>}
      action={
        <div style={{ display: 'flex', gap: 6 }}>
          {/* The invite link is per-person, so it's minted for the first deal
              contact with an email — the same one the intro email goes to. */}
          <PortalOpenButtons
            companyId={data?.companyId}
            onError={flash}
            invite={{ dealId, email: inviteContact?.email || null, name: inviteContact?.name || null }}
            disabledReason={data && !data.companyId
              ? 'This deal isn’t linked to a company yet, and a portal belongs to an organisation. Set the company on this deal and you can preview it — no invite needed.'
              : null}
          />
          <button
            className="btn-ghost"
            style={{ fontSize: 12 }}
            disabled={!data || !data.companyId}
            onClick={() => setShowInvite(true)}
            title={data && !data.companyId
              ? 'Link this deal to a company first — an invite gives someone access to that organisation’s portal.'
              : 'Squideo sends the invite email — you confirm the wording first'}
          >
            <Send size={12} style={{ verticalAlign: -1, marginRight: 4 }} />CRM portal invite
          </button>
          <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowCustom(true)}>
            <Plus size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Custom offer
          </button>
        </div>
      }
    >
      {notice && (
        <div style={{ fontSize: 12, color: '#0B6E93', background: '#EAF7FC', border: '1px solid #A9E1F5', borderRadius: 6, padding: '6px 10px', marginBottom: 10 }}>
          {notice}
        </div>
      )}
      {error && <Empty text={error} />}
      {!error && !data && <Empty text="Loading…" />}

      {data && (
        <>
          {/* Portal access status — makes it obvious at a glance whether anyone can
              actually see this portal yet, so "released to client" / offers aren't
              mistaken for the client having been given access. */}
          {(() => {
            const cands = data.candidates || [];
            const withAccess = cands.filter((c) => c.hasAccess);
            const pending = cands.filter((c) => !c.hasAccess && c.invitePending);
            const has = withAccess.length > 0;
            const pend = !has && pending.length > 0;
            // No company = no portal at all: the portal, its members, library and
            // credits all belong to an organisation. Say that instead of "no one
            // has been invited yet", which implies an invite is the missing step
            // when linking a company is (and previewing never needed an invite).
            const orgless = !data.companyId;
            const dot = orgless ? '#B45309' : has ? '#16A34A' : pend ? '#B45309' : BRAND.muted;
            const bg = orgless ? '#FFFBEB' : has ? '#F0FDF4' : pend ? '#FFFBEB' : BRAND.paper;
            const bd = orgless ? '#FDE68A' : has ? '#BBF7D0' : pend ? '#FDE68A' : BRAND.border;
            const label = orgless
              ? 'No company on this deal — link one to open or invite anyone to a portal'
              : has
                ? `${withAccess.length} ${withAccess.length === 1 ? 'contact has' : 'contacts have'} portal access`
                : pend
                  ? `Invite sent — awaiting sign-up (${pending.length})`
                  : 'No one has been invited yet — you can still preview it with “View client portal”';
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, padding: '7px 10px', borderRadius: 8, background: bg, border: '1px solid ' + bd }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0 }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.ink }}>{label}</span>
                {!has && !orgless && (
                  <button className="btn-link" style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700 }} disabled={!data} onClick={() => setShowInvite(true)}>
                    {pend ? 'Manage invites' : 'Send invite'}
                  </button>
                )}
              </div>
            );
          })()}

          {allOffers.length === 0 && (
            <Empty text="No portal extras to offer — the signed proposal has no remaining optional extras. Add a custom offer to upsell." />
          )}

          {allOffers.length > 0 && (
            <ExtrasHeader
              live={liveCount}
              hidden={hiddenCount}
              discountPct={discountPct}
              collapsed={!showExtras}
              onToggle={proposalOffers.length ? () => setShowExtras((v) => !v) : null}
            />
          )}

          {showExtras && proposalOffers.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5, color: BRAND.muted, margin: '2px 0 8px' }}>
                <span>Portal extras discount:</span>
                {discountEdit == null ? (
                  <button className="btn-link" style={{ fontSize: 12.5, fontWeight: 700 }} onClick={() => setDiscountEdit(String(discountPct))}>
                    {discountPct}% — edit
                  </button>
                ) : (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <input className="input" value={discountEdit} onChange={(e) => setDiscountEdit(e.target.value)} style={{ width: 56, fontSize: 12.5, padding: '3px 6px' }} />%
                    <button className="btn" style={{ fontSize: 11.5, padding: '3px 10px' }} disabled={busy} onClick={saveDiscount}>Save</button>
                    <button className="btn-ghost" style={{ fontSize: 11.5 }} onClick={() => setDiscountEdit(null)}>Cancel</button>
                  </span>
                )}
                <span style={{ fontSize: 11.5 }}>Prices follow the proposal — edits there update these offers.</span>
              </div>

              {proposalOffers.map((o) => (
                <div key={o.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid ' + BRAND.border, fontSize: 13, opacity: o.hidden ? 0.5 : 1 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 600, color: BRAND.ink }}>{o.title}</span>
                  </div>
                  {o.originalAmount != null && o.originalAmount !== o.amount && (
                    <span style={{ color: BRAND.muted, textDecoration: 'line-through', fontSize: 12 }}>{formatGBP(o.originalAmount)}</span>
                  )}
                  <span style={{ fontWeight: 700 }}>{formatGBP(o.amount)}</span>
                  <button className="btn-ghost" disabled={busy} style={{ fontSize: 11.5, padding: 4 }} title={o.hidden ? 'Show in portal' : 'Hide from portal'} onClick={() => toggleDerived(o)}>
                    {o.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
              ))}
            </>
          )}

          {customOffers.map((o) => (
            <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid ' + BRAND.border, fontSize: 13, opacity: o.hidden ? 0.5 : 1 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: BRAND.ink }}>{o.title}</span>
                <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#7C3AED' }}>CUSTOM</span>
                {o.description && <div style={{ fontSize: 11.5, color: BRAND.muted }}>{o.description}</div>}
              </div>
              <span style={{ fontWeight: 700 }}>{formatGBP(o.amount)}</span>
              <button className="btn-ghost" disabled={busy} style={{ fontSize: 11.5, padding: 4 }} title={o.hidden ? 'Show in portal' : 'Hide from portal'}
                onClick={() => run(() => api.post('/api/crm/portal-admin?op=offer-update', { id: o.id, hidden: !o.hidden }))}>
                {o.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
              <button className="btn-ghost is-danger" disabled={busy} style={{ fontSize: 11.5, padding: 4 }} title="Delete offer"
                onClick={() => run(() => api.post('/api/crm/portal-admin?op=offer-delete', { id: o.id }), 'Offer deleted')}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}

          {data.finalRelease && (
            <div style={{ marginTop: 12, padding: '10px 12px', border: '1px solid ' + BRAND.border, borderRadius: 8, background: data.finalRelease.unlocked ? '#F0FDF4' : '#FFFBEB' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.ink }}>
                    Final video: {data.finalRelease.unlocked ? 'released to client' : 'locked until paid'}
                  </div>
                  <div style={{ fontSize: 11.5, color: BRAND.muted }}>
                    {data.finalRelease.override
                      ? 'Released early by staff override.'
                      : data.finalRelease.unlocked
                        ? 'The deal is paid in full — the client can download their signed-off video.'
                        : 'The client can download the signed-off video once the balance is settled.'}
                  </div>
                </div>
                {!canRelease ? null : data.finalRelease.override ? (
                  <button className="btn-ghost" disabled={busy} style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                    onClick={() => run(() => actions.setFinalReleaseOverride(dealId, false), 'Override removed')}>
                    Remove override
                  </button>
                ) : !data.finalRelease.unlocked && (
                  <button className="btn" disabled={busy} style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                    title="Release the finished video to the client now, before the balance is paid"
                    onClick={() => run(() => actions.setFinalReleaseOverride(dealId, true), 'Final video released')}>
                    Release now
                  </button>
                )}
              </div>
            </div>
          )}

          <ClientBriefBlock briefs={data.briefs || []} />

          <PortalStepsActivity variant="deal" steps={data.steps || []} activity={data.activity || []} />
        </>
      )}

      {showInvite && data && (
        <InviteModal
          dealId={dealId}
          data={data}
          // Names the sender in the default subject, matching what the server
          // would fall back to.
          inviterName={state.session?.name || 'The Squideo team'}
          onClose={() => setShowInvite(false)}
          onSent={(msg) => { flash(msg); load(); }}
        />
      )}


      {showCustom && (
        <Modal onClose={() => setShowCustom(false)} maxWidth={420}>
          <h3 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 700 }}>Custom portal offer</h3>
          <form onSubmit={addCustom} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input className="input" required placeholder="Title — e.g. Vertical cutdown for socials" value={custom.title} onChange={(e) => setCustom((c) => ({ ...c, title: e.target.value }))} />
            <textarea className="input" rows={2} placeholder="Description shown to the client (optional)" value={custom.description} onChange={(e) => setCustom((c) => ({ ...c, description: e.target.value }))} />
            <input className="input" required type="number" min="1" step="0.01" placeholder="Price ex VAT (£) — shown as-is, no further discount" value={custom.amount} onChange={(e) => setCustom((c) => ({ ...c, amount: e.target.value }))} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn-ghost" onClick={() => setShowCustom(false)}>Cancel</button>
              <button className="btn" type="submit" disabled={busy}>Add offer</button>
            </div>
          </form>
        </Modal>
      )}
    </Card>
  );
}
