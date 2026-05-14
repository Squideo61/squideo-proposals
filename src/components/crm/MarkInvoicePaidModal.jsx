import React, { useState } from 'react';
import { X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { api } from '../../api.js';
import { Modal } from '../ui.jsx';
import { formatGBP } from '../../utils.js';

const METHODS = [
  { value: 'bacs',   label: 'BACS / Bank Transfer' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'cash',   label: 'Cash' },
];

export function MarkInvoicePaidModal({ invoiceId, invoiceNumber, amount, onClose, onMarked }) {
  const { showMsg } = useStore();
  const [method, setMethod] = useState('bacs');
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const rawId = invoiceId.replace('manual:', '');
      await api.patch('/api/crm/invoices/' + encodeURIComponent(rawId), {
        status: 'paid',
        paymentMethod: method,
        paidAt: new Date(paidAt).toISOString(),
        notes: notes.trim() || undefined,
      });
      showMsg?.('Invoice marked as paid', 'success');
      onMarked?.();
    } catch (err) {
      showMsg?.(err.message || 'Failed to mark paid', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Mark invoice as paid</h2>
        <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
      </div>

      {(invoiceNumber || amount != null) && (
        <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted }}>
          {invoiceNumber && <strong>{invoiceNumber}</strong>}
          {invoiceNumber && amount != null && ' — '}
          {amount != null && formatGBP(amount)}
        </p>
      )}

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Payment method">
          <select value={method} onChange={(e) => setMethod(e.target.value)} className="input">
            {METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>

        <Field label="Payment date">
          <input
            type="date"
            value={paidAt}
            onChange={(e) => setPaidAt(e.target.value)}
            className="input"
            required
          />
        </Field>

        <Field label="Notes (optional — e.g. BACS reference)">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="input"
            rows={2}
            placeholder="e.g. BACS ref 12345"
          />
        </Field>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={saving}>
            {saving ? 'Saving…' : 'Mark as paid'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 11, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  );
}
