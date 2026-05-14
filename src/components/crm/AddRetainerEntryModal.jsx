import React, { useState } from 'react';
import { X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { api } from '../../api.js';
import { Modal } from '../ui.jsx';

export function AddRetainerEntryModal({ retainer, onClose, onSaved }) {
  const { showMsg } = useStore();
  const isMoney = retainer.allocationType === 'money';

  const [description, setDescription] = useState('');
  const [value, setValue] = useState('');
  const [workedAt, setWorkedAt] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!description.trim()) { showMsg?.('Description is required', 'error'); return; }
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) { showMsg?.('Value must be a positive number', 'error'); return; }
    setSaving(true);
    try {
      await api.post('/api/crm/retainers/' + retainer.id + '/entries', {
        description: description.trim(),
        value: v,
        workedAt,
      });
      showMsg?.('Work logged', 'success');
      onSaved?.();
    } catch (err) {
      showMsg?.(err.message || 'Failed to save', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Log work</h2>
          <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>{retainer.title}</div>
        </div>
        <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="input"
            rows={3}
            placeholder="What work was done?"
            style={{ fontFamily: 'inherit', resize: 'vertical' }}
            required
            autoFocus
          />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label={isMoney ? 'Value (£)' : 'Credits used'}>
            <input
              type="number"
              step={isMoney ? '0.01' : '1'}
              min="0"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="input"
              placeholder={isMoney ? '0.00' : '0'}
              required
            />
          </Field>
          <Field label="Date">
            <input
              type="date"
              value={workedAt}
              onChange={(e) => setWorkedAt(e.target.value)}
              className="input"
              required
            />
          </Field>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={saving}>{saving ? 'Saving…' : 'Log work'}</button>
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
