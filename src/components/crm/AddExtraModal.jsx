import React, { useState } from 'react';
import { X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { api } from '../../api.js';
import { Modal } from '../ui.jsx';

// Record an ad-hoc "extra" charge against a deal (extra video, human VO, extra
// revisions…). Stage 1 is record-only: the extra is saved and shows as its own
// pending line in Pending Payments, to be invoiced later.
// How an extra is billed. Labels are the dropdown copy.
const PAYMENT_OPTIONS = [
  { value: 'final', label: 'Add to the final invoice', hint: 'Sits on the deal and rides the 50% final invoice for the project.' },
  { value: 'invoice_now', label: 'Create invoice now', hint: 'Raises a Xero invoice for this charge straight away.' },
  { value: 'po', label: 'Purchase order — generate a quote to raise a PO', hint: 'Raises a Xero quote (reference “Pending PO”); turn it into an invoice from the Purchase Orders section once the PO lands.' },
];

export function AddExtraModal({ dealId, deals, onClose, onCreated }) {
  const { showMsg } = useStore();
  const dealOptions = (deals || []).filter((d) => d && d.id);
  const [selectedDealId, setSelectedDealId] = useState(dealId || (dealOptions[0]?.id ?? ''));
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentType, setPaymentType] = useState('final');
  const [saving, setSaving] = useState(false);

  const effectiveDealId = dealId || selectedDealId;
  const amountNum = Number(amount);
  const canSubmit = !!effectiveDealId && description.trim() && amountNum > 0 && !saving;
  const option = PAYMENT_OPTIONS.find((o) => o.value === paymentType) || PAYMENT_OPTIONS[0];
  const submitLabel = paymentType === 'invoice_now' ? 'Create invoice'
    : paymentType === 'po' ? 'Generate PO quote'
    : 'Add extra';
  const savingLabel = paymentType === 'invoice_now' ? 'Creating invoice…'
    : paymentType === 'po' ? 'Generating quote…'
    : 'Adding…';

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    try {
      const row = await api.post('/api/crm/extras', {
        dealId: effectiveDealId,
        description: description.trim(),
        amount: amountNum,
        paymentType,
      });
      showMsg?.(paymentType === 'po' ? 'PO quote raised' : paymentType === 'invoice_now' ? 'Invoice created' : 'Extra added', 'success');
      onCreated?.(row);
    } catch (err) {
      showMsg?.(err.message || 'Failed to add extra', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} showClose={false}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Add extra charge</h2>
        <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
      </div>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 12, color: BRAND.muted }}>
          An extra charge added during production (e.g. an extra video or human VO) — on top of the signed total. Choose how it should be billed below.
        </p>

        {!dealId && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.muted }}>Project / deal</span>
            <select
              value={selectedDealId}
              onChange={(e) => setSelectedDealId(e.target.value)}
              className="input"
            >
              {dealOptions.length === 0 && <option value="">No deals available</option>}
              {dealOptions.map((d) => (
                <option key={d.id} value={d.id}>{d.title || d.id}</option>
              ))}
            </select>
          </label>
        )}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.muted }}>Description</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Human VO, additional revisions"
            className="input"
            autoFocus
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.muted }}>Amount (ex-VAT)</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="input"
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.muted }}>How will this be paid?</span>
          <select value={paymentType} onChange={(e) => setPaymentType(e.target.value)} className="input">
            {PAYMENT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <span style={{ fontSize: 11.5, color: BRAND.muted }}>{option.hint}</span>
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={!canSubmit}>
            {saving ? savingLabel : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
