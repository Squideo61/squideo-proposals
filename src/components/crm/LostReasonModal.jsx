import React, { useState } from 'react';
import { BRAND } from '../../theme.js';
import { Modal } from '../ui.jsx';

// The reasons offered when a deal is marked lost. Single source of truth so the
// deal page and the email-thread stage dropdown stay in sync.
export const LOST_REASONS = ['Price', 'Timing', 'Competitor', 'Disengaged', 'Funding not obtained', 'Indefinite hold', 'Other'];

// Shared "why was this lost?" prompt. onSubmit(reason) is called with the chosen
// reason string; the caller is responsible for moving the stage.
export function LostReasonModal({ onClose, onSubmit }) {
  const [reason, setReason] = useState('Price');
  return (
    <Modal onClose={onClose}>
      <h2 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700 }}>Mark deal as lost</h2>
      <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 16px' }}>What's the main reason?</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
        {LOST_REASONS.map(r => (
          <label key={r} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', cursor: 'pointer', fontSize: 14 }}>
            <input type="radio" name="lost" checked={reason === r} onChange={() => setReason(r)} />
            <span>{r}</span>
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} className="btn-ghost">Cancel</button>
        <button onClick={() => onSubmit(reason)} className="btn">Confirm lost</button>
      </div>
    </Modal>
  );
}
