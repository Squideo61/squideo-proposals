import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { ClientView } from '../ClientView.jsx';

// "Record signed proposal" — the staff flow for a client who accepted away from
// the link (a signed PDF returned by email or post, or a confirmation in
// writing). Without it those deals stay Unsigned forever: the CRM only ever
// creates a signature from the client's own click, so a deal closed on paper
// could never advance to Signed, sync its value, or reach production.
//
// It deliberately hosts the REAL ClientView rather than a bespoke form. Which
// recommendations were taken, how they're priced against the proposal's minutes,
// the partner/monthly routes, the discounts locked in at signing — all of that
// lives in ClientView and its pricing helpers, and a second implementation of it
// here would drift the moment either side changed. The team member ticks what
// the client ticked, on the same page the client saw.
//
// Not the shared <Modal>: its close button is absolutely positioned top-right,
// where it would land on top of ClientView's own sticky toolbar. This keeps that
// toolbar usable and puts the X in a header of its own. Backdrop clicks don't
// dismiss (same rule as Modal) so a stray click can't discard a part-filled
// acceptance; Escape and the X do.
export function RecordSignedModal({ proposalId, label, onClose, onRecorded }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15, 42, 61, 0.5)', display: 'flex', alignItems: 'stretch', justifyContent: 'center', zIndex: 2000, padding: 0 }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Record signed proposal"
        style={{
          position: 'relative', background: 'white', width: '100%', maxWidth: 1040,
          display: 'flex', flexDirection: 'column', maxHeight: '100vh', height: '100vh',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', paddingTop: 'calc(12px + env(safe-area-inset-top))', borderBottom: '1px solid ' + BRAND.border, background: 'white' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.ink }}>Record signed proposal</div>
            {label && (
              <div style={{ fontSize: 12, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, border: '1px solid ' + BRAND.border, background: 'white', cursor: 'pointer', color: BRAND.muted }}
          ><X size={16} /></button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <ClientView
            id={proposalId}
            recordMode
            onBack={null}
            onSigned={() => { onRecorded?.(); onClose?.(); }}
          />
        </div>
      </div>
    </div>
  );
}
