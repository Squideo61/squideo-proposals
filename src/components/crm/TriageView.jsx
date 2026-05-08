import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Inbox, Search, X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatRelativeTime, useIsMobile } from '../../utils.js';
import { Modal } from '../ui.jsx';

export function TriageView({ onBack, onOpenDeal }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [assigning, setAssigning] = useState(null); // the thread row being assigned

  useEffect(() => { actions.refreshTriage(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const messages = state.triage || [];

  const handleAssign = async (gmailThreadId, dealId) => {
    await actions.triageAssign(gmailThreadId, dealId);
    showMsg('Assigned to deal');
    setAssigning(null);
  };

  const handleDismiss = async (gmailThreadId) => {
    if (!window.confirm('Dismiss this thread? It will be removed from triage but the messages stay archived.')) return;
    await actions.triageDismiss(gmailThreadId);
    showMsg('Dismissed');
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Inbox size={22} color={BRAND.blue} />
          Triage
        </h1>
        <span style={{ fontSize: 13, color: BRAND.muted }}>{messages.length} unassigned</span>
      </header>

      <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 16px', maxWidth: 620 }}>
        Emails that didn't match any deal automatically. Assign them to the right deal,
        or dismiss if they're personal/spam. Once assigned, future replies in the same
        thread will auto-attach to that deal.
      </p>

      {messages.length === 0 ? (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 40, textAlign: 'center', color: BRAND.muted }}>
          Nothing to triage. New emails matched to a deal will skip this view.
        </div>
      ) : (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
          {messages.map((m, i) => (
            <ThreadRow
              key={m.gmailMessageId}
              message={m}
              first={i === 0}
              onAssign={() => setAssigning(m)}
              onDismiss={() => handleDismiss(m.gmailThreadId)}
            />
          ))}
        </div>
      )}

      {assigning && (
        <AssignModal
          message={assigning}
          onClose={() => setAssigning(null)}
          onAssign={handleAssign}
          onOpenDeal={onOpenDeal}
        />
      )}
    </div>
  );
}

function ThreadRow({ message, first, onAssign, onDismiss }) {
  const inbound = message.direction === 'inbound';
  const counterparty = inbound ? message.fromEmail : (message.toEmails?.[0] || '');
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      padding: '14px 16px',
      borderTop: first ? 'none' : '1px solid ' + BRAND.border,
    }}>
      <div
        style={{
          flexShrink: 0, width: 14, height: 14, marginTop: 3,
          background: (inbound ? '#16A34A' : '#2BB8E6') + '22',
          color: inbound ? '#16A34A' : '#2BB8E6',
          borderRadius: 3, fontSize: 10, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        title={inbound ? 'Inbound' : 'Outbound'}
      >
        {inbound ? '↓' : '↑'}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {message.subject || <span style={{ color: BRAND.muted, fontStyle: 'italic' }}>(no subject)</span>}
        </div>
        {message.snippet && (
          <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {message.snippet}
          </div>
        )}
        <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4 }}>
          {formatRelativeTime(message.sentAt)}{counterparty ? ` · ${inbound ? 'from' : 'to'} ${counterparty}` : ''}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button onClick={onAssign} className="btn">Assign to deal</button>
        <button onClick={onDismiss} className="btn-ghost" title="Dismiss">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function AssignModal({ message, onClose, onAssign, onOpenDeal }) {
  const { state } = useStore();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const deals = useMemo(() => Object.values(state.deals || {}).filter(d => d.stage !== 'lost'), [state.deals]);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? deals.filter(d => (d.title || '').toLowerCase().includes(q))
    : deals.slice(0, 50);

  const submit = async () => {
    if (!picked || submitting) return;
    setSubmitting(true);
    await onAssign(message.gmailThreadId, picked.id);
    setSubmitting(false);
  };

  return (
    <Modal onClose={onClose}>
      <h2 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700 }}>Assign to deal</h2>
      <div style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 16px' }}>
        <strong style={{ color: BRAND.ink }}>{message.subject || '(no subject)'}</strong>
        {message.fromEmail && <span> · from {message.fromEmail}</span>}
      </div>
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <Search size={14} color={BRAND.muted} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} />
        <input
          className="input"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search deals…"
          style={{ paddingLeft: 34 }}
        />
      </div>
      <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid ' + BRAND.border, borderRadius: 8, marginBottom: 16 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 16, textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>
            No matching deals
          </div>
        ) : filtered.map((d, i) => (
          <button
            key={d.id}
            onClick={() => setPicked(d)}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '10px 12px', borderTop: i ? '1px solid ' + BRAND.border : 'none',
              background: picked?.id === d.id ? '#F0F9FF' : 'white',
              cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
              border: 'none', borderLeft: picked?.id === d.id ? '3px solid ' + BRAND.blue : '3px solid transparent',
            }}
          >
            <div style={{ fontWeight: 600 }}>{d.title}</div>
            <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.4 }}>{d.stage}</div>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        {picked
          ? <button onClick={() => onOpenDeal?.(picked.id)} className="btn-ghost" type="button">Open deal first</button>
          : <span />}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <button onClick={submit} className="btn" disabled={!picked || submitting}>
            {submitting ? 'Assigning…' : 'Assign'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
