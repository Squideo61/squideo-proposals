// "Client portal" card on the deal page: manage the discounted extras offers
// the client sees in their portal (derived from the proposal, plus custom
// upsells), tune the per-deal discount, and resend the portal welcome invite.
// Backed by /api/crm/portal-admin.
import React, { useCallback, useEffect, useState } from 'react';
import { Check, Eye, EyeOff, Plus, Send, Sparkles, Trash2, UserPlus, X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { formatGBP } from '../../utils.js';
import { Card, Empty } from './Card.jsx';
import { Modal } from '../ui.jsx';

// Pick who gets a portal invite for this deal. Defaults to the deal's contacts
// + proposal signer (anyone who doesn't already have access is pre-ticked);
// extra emails can be typed in and optionally saved as CRM contacts.
function InviteModal({ dealId, data, onClose, onSent }) {
  const candidates = data?.candidates || [];
  const [picked, setPicked] = useState(() => {
    const s = new Set();
    for (const c of candidates) if (!c.hasAccess) s.add(c.email);
    return s;
  });
  const [extras, setExtras] = useState([]); // [{ email, name, createContact }]
  const [newEmail, setNewEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const toggle = (email) => setPicked((prev) => {
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
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/api/crm/portal-admin?op=invite-deal', { dealId, recipients });
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
        They'll get an email to set up portal access for <strong>{data?.companyName || 'this organisation'}</strong> —
        where they can track progress, review drafts and download videos.
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
            <div style={{ fontSize: 13.5, fontWeight: 600, color: BRAND.ink }}>{c.name || c.email}</div>
            <div style={{ fontSize: 11.5, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.name ? `${c.email} · ` : ''}{c.source}
            </div>
          </div>
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

export function PortalDealCard({ dealId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [showCustom, setShowCustom] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
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

  const derived = data?.derived || [];
  const customOffers = (data?.offers || []).filter((o) => o.kind === 'custom');
  const hiddenIds = new Set((data?.offers || []).filter((o) => o.kind === 'override' && o.hidden).map((o) => o.proposalExtraId));
  const discountPct = Math.round((data?.discount ?? 0.10) * 100);

  return (
    <Card
      title={<><Sparkles size={12} style={{ verticalAlign: -1, marginRight: 5 }} />Client portal</>}
      action={
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn-ghost" style={{ fontSize: 12 }} disabled={!data} onClick={() => setShowInvite(true)} title="Invite this deal's contacts to the client portal">
            <Send size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Portal invite
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: BRAND.muted, marginBottom: 12 }}>
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
            <span style={{ marginLeft: 'auto', fontSize: 11.5 }}>Prices follow the proposal — edits there update these offers.</span>
          </div>

          {derived.length === 0 && customOffers.length === 0 && (
            <Empty text="No portal extras to offer — the signed proposal has no remaining optional extras. Add a custom offer to upsell." />
          )}

          {derived.map((o) => {
            const extraId = o.key.startsWith('prop:') ? o.key.slice(5).split(':')[0] : null;
            const isHidden = hiddenIds.has(extraId);
            return (
              <div key={o.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid ' + BRAND.border, fontSize: 13, opacity: isHidden ? 0.5 : 1 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, color: BRAND.ink }}>{o.title}</span>
                  {o.kind === 'custom' && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#7C3AED' }}>CUSTOM</span>}
                </div>
                {o.originalAmount != null && o.originalAmount !== o.amount && (
                  <span style={{ color: BRAND.muted, textDecoration: 'line-through', fontSize: 12 }}>{formatGBP(o.originalAmount)}</span>
                )}
                <span style={{ fontWeight: 700 }}>{formatGBP(o.amount)}</span>
                {o.kind === 'proposal' && (
                  <button className="btn-ghost" disabled={busy} style={{ fontSize: 11.5, padding: 4 }} title={isHidden ? 'Show in portal' : 'Hide from portal'} onClick={() => toggleDerived(o)}>
                    {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                )}
              </div>
            );
          })}

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
        </>
      )}

      {showInvite && data && (
        <InviteModal
          dealId={dealId}
          data={data}
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
