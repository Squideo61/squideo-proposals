import React, { useState } from 'react';
import { X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { api } from '../../api.js';
import { Modal } from '../ui.jsx';
import { AddInvoiceModal } from './AddInvoiceModal.jsx';

const PAYMENT_METHODS = [
  { value: 'bacs', label: 'BACS / bank transfer' },
];
const PAYMENT_TYPES = [
  { value: 'deposit', label: '50% deposit' },
  { value: 'full',    label: 'Full payment' },
  { value: 'partial', label: 'Partial' },
];

export function AddPaymentModal({ dealId, proposals = [], onClose, onCreated }) {
  const { showMsg } = useStore();
  const [proposalId, setProposalId] = useState(proposals[0]?.id || '');
  const [method, setMethod] = useState('bacs');
  const [amount, setAmount] = useState('');
  const [type, setType] = useState('full');
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [manualInvoiceId, setManualInvoiceId] = useState('');
  const [uploadingInvoice, setUploadingInvoice] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!proposalId) { showMsg?.('Pick a proposal', 'error'); return; }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) { showMsg?.('Amount must be a positive number', 'error'); return; }
    setSaving(true);
    try {
      await api.post('/api/crm/payments', {
        proposalId,
        amount: amt,
        paymentMethod: method,
        paymentType: type,
        paidAt: new Date(paidAt).toISOString(),
        notes: notes.trim() || null,
        manualInvoiceId: manualInvoiceId || null,
      });
      showMsg?.('Payment recorded', 'success');
      onCreated?.();
    } catch (err) {
      showMsg?.(err.message || 'Failed to save', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Record a payment</h2>
        <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
      </div>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Proposal">
          <select value={proposalId} onChange={(e) => setProposalId(e.target.value)} className="input" required>
            <option value="">— Pick a proposal —</option>
            {proposals.map(p => (
              <option key={p.id} value={p.id}>{p.clientName || p.contactBusinessName || p.id}</option>
            ))}
          </select>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Payment method">
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="input">
              {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select value={type} onChange={(e) => setType(e.target.value)} className="input">
              {PAYMENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Amount (£)">
            <input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="input" required />
          </Field>
          <Field label="Paid at">
            <input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className="input" required />
          </Field>
        </div>
        <Field label="Notes (optional)">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="input" rows={2} placeholder="BACS reference, cheque number, etc." />
        </Field>
        <Field label="Attach invoice (optional)">
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={manualInvoiceId}
              onChange={(e) => setManualInvoiceId(e.target.value)}
              className="input"
              placeholder="Manual invoice ID, if known"
              style={{ flex: 1 }}
            />
            <button type="button" onClick={() => setUploadingInvoice(true)} className="btn-ghost">Upload new…</button>
          </div>
        </Field>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={saving}>{saving ? 'Saving…' : 'Record payment'}</button>
        </div>
      </form>

      {uploadingInvoice && (
        <AddInvoiceModal
          dealId={dealId}
          proposals={proposals}
          defaultProposalId={proposalId}
          onClose={() => setUploadingInvoice(false)}
          onCreated={(created) => {
            setUploadingInvoice(false);
            if (created?.id) setManualInvoiceId(created.id.slice('manual:'.length));
          }}
        />
      )}
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
