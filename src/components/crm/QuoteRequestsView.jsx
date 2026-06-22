import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, FileText, Mail, MailQuestion, Paperclip, Phone, X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatRelativeTime, useIsMobile } from '../../utils.js';
import { Modal } from '../ui.jsx';

export function QuoteRequestsView({ onBack, onOpenDeal, onOpenContact }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  // Clearing a request is admin-only (the wildcard '*' permission). Everyone with
  // quote_requests.manage can still qualify/disqualify.
  const isAdmin = Array.isArray(state.session?.permissions) && state.session.permissions.includes('*');
  const [filter, setFilter] = useState('new');
  const [active, setActive] = useState(null);
  const [reviewedContact, setReviewedContact] = useState(null);
  const [reviewedIsExisting, setReviewedIsExisting] = useState(false);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => { actions.refreshQuoteRequests(filter); }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Instant refresh when someone qualifies / disqualifies from a notification
  // email. The store's global listener also refreshes (for the nav badge),
  // but it always pulls status='new' — we re-fetch with the user's current
  // filter here so the view they're looking at stays correct.
  useEffect(() => {
    const onBroadcast = (msg) => {
      if (msg && msg.type === 'squideo:quote-request-actioned') {
        actions.refreshQuoteRequests(filter);
      }
    };
    let bc = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        bc = new BroadcastChannel('squideo');
        bc.onmessage = (e) => onBroadcast(e.data);
      }
    } catch { /* ignore */ }
    const onStorage = (e) => {
      if (e.key !== 'squideo:event' || !e.newValue) return;
      try { onBroadcast(JSON.parse(e.newValue)); } catch { /* ignore */ }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      if (bc) { try { bc.close(); } catch { /* ignore */ } }
    };
  }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = state.quoteRequests || [];
  const requests = useMemo(
    () => all.filter((r) => filter === 'all' || r.status === filter),
    [all, filter]
  );
  const newCount = all.filter((r) => r.status === 'new').length;

  const handleQualify = async (req) => {
    if (busyId) return;
    setBusyId(req.id);
    const result = await actions.qualifyQuoteRequest(req.id);
    setBusyId(null);
    if (result && result.deal) {
      showMsg('Qualified — deal created');
      setActive(null);
      onOpenDeal?.(result.deal.id);
    } else {
      showMsg('Could not qualify');
    }
  };

  const handleClear = async (req) => {
    if (busyId) return;
    setBusyId(req.id);
    const ok = await actions.clearQuoteRequest(req.id);
    setBusyId(null);
    if (ok) {
      showMsg('Cleared from inbox');
      setActive(null);
    } else {
      showMsg('Could not clear');
    }
  };

  const handleClearAll = async () => {
    if (busyId) return;
    if (!window.confirm(`Clear all ${newCount} new request${newCount === 1 ? '' : 's'} from the inbox? They stay in "All" and aren't marked disqualified, so marketing data is unaffected.`)) return;
    setBusyId('all');
    const n = await actions.clearNewQuoteRequests();
    setBusyId(null);
    if (n >= 0) showMsg(`Cleared ${n} request${n === 1 ? '' : 's'}`);
    else showMsg('Could not clear');
  };

  const handleDisqualify = async (req) => {
    if (busyId) return;
    const contactNote = reviewedIsExisting
      ? 'The existing CRM contact will not be deleted.'
      : 'This deletes the request and the provisional contact.';
    if (!window.confirm(`Disqualify ${req.name || req.email || 'this lead'}? ${contactNote}`)) return;
    setBusyId(req.id);
    const ok = await actions.disqualifyQuoteRequest(req.id);
    setBusyId(null);
    if (ok) {
      showMsg('Disqualified');
      setActive(null);
    } else {
      showMsg('Could not disqualify');
    }
  };

  const openDetail = async (req) => {
    setActive(req);
    setReviewedContact(null);
    setReviewedIsExisting(false);
    if (req.status === 'new') {
      const r = await actions.reviewQuoteRequest(req.id);
      if (r && r.contact) {
        setReviewedContact(r.contact);
        setReviewedIsExisting(r.isExisting === true);
      }
    }
  };

  return (
    <div style={{ padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <MailQuestion size={22} color={BRAND.blue} />
          Quote Requests
        </h1>
        <span style={{ fontSize: 13, color: BRAND.muted }}>
          {filter === 'new' ? `${newCount} new` : `${requests.length} ${filter}`}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {isAdmin && filter === 'new' && newCount > 0 && (
            <button
              onClick={handleClearAll}
              disabled={busyId === 'all'}
              className="btn-ghost"
              title="Remove all new requests from the inbox without disqualifying them"
            >
              {busyId === 'all' ? 'Clearing…' : 'Clear all'}
            </button>
          )}
          {['new', 'qualified', 'all'].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={filter === f ? 'btn' : 'btn-ghost'}
              style={{ textTransform: 'capitalize' }}
            >
              {f}
            </button>
          ))}
        </div>
      </header>

      <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 16px', maxWidth: 680 }}>
        Leads from the public quote form. Click a row to review the full details, then
        Qualify (creates a contact + lead-stage deal) or Disqualify (deletes the request
        and any provisional contact). Clear just removes a request from this inbox
        without judging it — the lead is kept and marketing data is unaffected.
      </p>

      {requests.length === 0 ? (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 40, textAlign: 'center', color: BRAND.muted }}>
          {filter === 'new' ? 'No new quote requests.' : `No ${filter} requests.`}
        </div>
      ) : (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
          {requests.map((r, i) => (
            <RequestRow
              key={r.id}
              request={r}
              first={i === 0}
              busy={busyId === r.id}
              onOpen={() => openDetail(r)}
              onQualify={() => handleQualify(r)}
              onDisqualify={() => handleDisqualify(r)}
              onClear={() => handleClear(r)}
              canClear={isAdmin}
              onOpenDeal={onOpenDeal}
            />
          ))}
        </div>
      )}

      {active && (
        <DetailModal
          request={active}
          reviewedContact={reviewedContact}
          reviewedIsExisting={reviewedIsExisting}
          busy={busyId === active.id}
          onClose={() => setActive(null)}
          onQualify={() => handleQualify(active)}
          onDisqualify={() => handleDisqualify(active)}
          onClear={() => handleClear(active)}
          canClear={isAdmin}
          onOpenContact={onOpenContact}
          onOpenDeal={onOpenDeal}
        />
      )}
    </div>
  );
}

function RequestRow({ request, first, busy, onOpen, onQualify, onDisqualify, onClear, canClear, onOpenDeal }) {
  const isQualified = request.status === 'qualified';
  const isCleared = request.status === 'cleared';
  const isDisqualified = request.status === 'disqualified';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '14px 16px',
        borderTop: first ? 'none' : '1px solid ' + BRAND.border,
        background: isQualified ? '#F8FAFB' : 'white',
      }}
    >
      <button
        onClick={onOpen}
        style={{
          flex: 1, minWidth: 0, textAlign: 'left',
          background: 'transparent', border: 'none', padding: 0,
          cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {request.name || <span style={{ color: BRAND.muted, fontStyle: 'italic' }}>(no name)</span>}
          {isQualified && (
            <span style={{ background: '#16A34A22', color: '#16A34A', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Qualified
            </span>
          )}
          {isCleared && (
            <span style={{ background: '#94A3B822', color: '#64748B', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Cleared
            </span>
          )}
          {isDisqualified && (
            <span style={{ background: '#DC262622', color: '#DC2626', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Disqualified
            </span>
          )}
        </div>
        {request.email && (
          <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 3, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Mail size={11} /> {request.email}
            {request.company && <span> · {request.company}</span>}
          </div>
        )}
        <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span>{formatRelativeTime(request.createdAt)}</span>
          {request.timeline && <span>· {request.timeline}</span>}
          {request.budget && <span>· {request.budget}</span>}
          {request.files?.length > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Paperclip size={11} /> {request.files.length}
            </span>
          )}
        </div>
      </button>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {isQualified ? (
          request.dealId && (
            <button onClick={() => onOpenDeal?.(request.dealId)} className="btn">Open deal</button>
          )
        ) : (
          <>
            <button onClick={onQualify} disabled={busy} className="btn">
              <Check size={14} /> Qualify
            </button>
            {canClear && !isCleared && (
              <button onClick={onClear} disabled={busy} className="btn-ghost" title="Clear from inbox (keeps the lead; not marked disqualified)">
                Clear
              </button>
            )}
            {!isDisqualified && (
              <button onClick={onDisqualify} disabled={busy} className="btn-ghost" title="Disqualify — logs a non-qualified lead for marketing and deletes the request + any provisional contact">
                <X size={14} /> Disqualify
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DetailModal({ request, reviewedContact, reviewedIsExisting, busy, onClose, onQualify, onDisqualify, onClear, canClear, onOpenContact, onOpenDeal }) {
  const isQualified = request.status === 'qualified';
  const isCleared = request.status === 'cleared';
  const fullPhone = request.phone
    ? `${request.countryCode ? request.countryCode + ' ' : ''}${request.phone}`
    : null;
  return (
    <Modal onClose={onClose} showClose={false}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
          {request.name || request.email || 'Quote request'}
        </h2>
        <button onClick={onClose} className="btn-ghost" style={{ padding: 4 }}><X size={14} /></button>
      </div>
      <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 16 }}>
        Submitted {formatRelativeTime(request.createdAt)}
        {request.sourceUrl && <> · {new URL(request.sourceUrl).hostname}</>}
      </div>

      <FieldGrid>
        {request.email && <Field label="Email"><a href={`mailto:${request.email}`} style={{ color: BRAND.blue }}>{request.email}</a></Field>}
        {fullPhone && <Field label="Phone"><a href={`tel:${fullPhone.replace(/[^+\d]/g, '')}`} style={{ color: BRAND.blue }}>{fullPhone}</a></Field>}
        {request.company && <Field label="Company">{request.company}</Field>}
        {request.countryName && <Field label="Country">{request.countryName}</Field>}
        {request.timeline && <Field label="Timeline">{request.timeline}</Field>}
        {request.budget && <Field label="Budget">{request.budget}</Field>}
        <Field label="Marketing opt-in">{request.optIn ? 'Yes' : 'No'}</Field>
      </FieldGrid>

      {request.projectDetails && (
        <>
          <h3 style={{ margin: '16px 0 6px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Project details</h3>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.55, background: '#FAFBFC', border: '1px solid ' + BRAND.border, borderRadius: 8, padding: '10px 12px' }}>
            {request.projectDetails}
          </div>
        </>
      )}

      {request.files?.length > 0 && (
        <>
          <h3 style={{ margin: '16px 0 6px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Attachments ({request.files.length})
          </h3>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 13 }}>
            {request.files.map((f) => (
              <li key={f.id} style={{ padding: '6px 0', borderTop: '1px solid ' + BRAND.border, display: 'flex', alignItems: 'center', gap: 6 }}>
                <FileText size={13} color={BRAND.muted} />
                <a href={f.blobUrl} target="_blank" rel="noopener noreferrer" style={{ color: BRAND.blue }}>{f.filename}</a>
                {Number.isFinite(f.sizeBytes) && (
                  <span style={{ color: BRAND.muted, fontSize: 11 }}>· {Math.round(f.sizeBytes / 1024)} KB</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {!isQualified && reviewedContact && (
        reviewedIsExisting ? (
          <div style={{ marginTop: 16, padding: 10, border: '1px solid #16A34A44', borderRadius: 8, fontSize: 12, background: '#F0FDF4', color: '#15803D', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Check size={13} />
            Matched existing contact: <strong>{reviewedContact.name || reviewedContact.email || reviewedContact.id}</strong>.
            Qualifying will create a deal linked to this contact.
          </div>
        ) : (
          <div style={{ marginTop: 16, padding: 10, border: '1px dashed ' + BRAND.border, borderRadius: 8, fontSize: 12, color: BRAND.muted }}>
            Provisional contact created: <strong style={{ color: BRAND.ink }}>{reviewedContact.name || reviewedContact.email || reviewedContact.id}</strong>.
            Qualifying will keep this contact and create a deal. Disqualifying will delete it.
          </div>
        )
      )}

      {isQualified && request.contactId && (
        <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {request.dealId && <button onClick={() => onOpenDeal?.(request.dealId)} className="btn">Open deal</button>}
          <button onClick={() => onOpenContact?.(request.contactId)} className="btn-ghost">Open contact</button>
        </div>
      )}

      {!isQualified && (
        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {canClear && !isCleared && (
            <button onClick={onClear} disabled={busy} className="btn-ghost" title="Remove from inbox without disqualifying — keeps the lead">
              Clear
            </button>
          )}
          <button onClick={onDisqualify} disabled={busy} className="btn-ghost">
            <X size={14} /> Disqualify
          </button>
          <button onClick={onQualify} disabled={busy} className="btn">
            <Check size={14} /> Qualify
          </button>
        </div>
      )}
    </Modal>
  );
}

function FieldGrid({ children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>{children}</div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, color: BRAND.ink, wordBreak: 'break-word' }}>{children}</div>
    </div>
  );
}
