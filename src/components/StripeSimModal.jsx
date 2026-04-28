import React from 'react';
import { BRAND } from '../theme.js';
import { formatGBP } from '../utils.js';
import { Modal } from './ui.jsx';

export function StripeSimModal({ amount, isDeposit, onConfirm, onClose }) {
  return (
    <Modal onClose={onClose}>
      <div style={{ background: '#FFF8E1', border: '1px solid #FFE082', color: '#8A6D00', padding: '10px 12px', borderRadius: 6, fontSize: 12, fontWeight: 700, textAlign: 'center', margin: '-8px -8px 16px', letterSpacing: 0.5 }}>
        PROTOTYPE — NO REAL PAYMENT WILL BE TAKEN
      </div>
      <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700 }}>Simulated Stripe checkout</h3>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
        This would normally redirect to Stripe's hosted checkout. In the prototype, confirming below marks the proposal as paid locally.
      </p>
      <div style={{ background: BRAND.paper, borderRadius: 8, padding: 14, marginBottom: 16, border: '1px solid ' + BRAND.border }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
          <span style={{ color: BRAND.muted }}>Amount</span>
          <strong>{formatGBP(amount)}</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
          <span style={{ color: BRAND.muted }}>Type</span>
          <span>{isDeposit ? '50% deposit' : 'Full payment'}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: BRAND.muted }}>
          <span>Mock session</span>
          <code style={{ fontSize: 11 }}>sim_{Date.now().toString(36)}</code>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} className="btn-ghost">Cancel</button>
        <button onClick={onConfirm} className="btn">Simulate successful payment</button>
      </div>
    </Modal>
  );
}
