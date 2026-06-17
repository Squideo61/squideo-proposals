import React, { useState } from 'react';
import { X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { api } from '../../api.js';
import { Modal } from '../ui.jsx';

// Record an ad-hoc "extra" charge against a deal (extra video, human VO, extra
// revisions…). Stage 1 is record-only: the extra is saved and shows as its own
// pending line in Pending Payments, to be invoiced later.
export function AddExtraModal({ dealId, deals, onClose, onCreated }) {
  const { showMsg } = useStore();
  const dealOptions = (deals || []).filter((d) => d && d.id);
  const [selectedDealId, setSelectedDealId] = useState(dealId || (dealOptions[0]?.id ?? ''));
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);

  const effectiveDealId = dealId || selectedDealId;
  const amountNum = Number(amount);
  const canSubmit = !!effectiveDealId && description.trim() && amountNum > 0 && !saving;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    try {
      const row = await api.post('/api/crm/extras', {
        dealId: effectiveDealId,
        description: description.trim(),
        amount: amountNum,
      });
      showMsg?.('Extra added', 'success');
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
          An extra charge added during production (e.g. an extra video or human VO). It sits on top of the signed total and shows as its own line in Pending Payments, ready to invoice later.
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

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={!canSubmit}>
            {saving ? 'Adding…' : 'Add extra'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
