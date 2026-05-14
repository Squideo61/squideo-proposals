import React, { useState } from 'react';
import { X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { api } from '../../api.js';
import { Modal } from '../ui.jsx';

export function AddRetainerModal({ dealId, retainer, contacts, onClose, onSaved, onDeleted }) {
  const { showMsg } = useStore();
  const editing = !!retainer;

  const [title, setTitle] = useState(retainer?.title || '');
  const [contactId, setContactId] = useState(retainer?.contactId || '');
  const [allocationType, setAllocationType] = useState(retainer?.allocationType || 'money');
  const [allocationAmount, setAllocationAmount] = useState(
    retainer?.allocationAmount != null ? String(retainer.allocationAmount) : ''
  );
  const [notes, setNotes] = useState(retainer?.notes || '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const sortedContacts = [...(contacts || [])].sort((a, b) =>
    (a.name || a.email || '').localeCompare(b.name || b.email || '')
  );

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) { showMsg?.('Title is required', 'error'); return; }
    const amt = Number(allocationAmount);
    if (!Number.isFinite(amt) || amt <= 0) { showMsg?.('Amount must be a positive number', 'error'); return; }
    setSaving(true);
    try {
      if (editing) {
        await api.patch('/api/crm/retainers/' + retainer.id, {
          contactId: contactId || null,
          title: title.trim(),
          allocationType,
          allocationAmount: amt,
          currency: 'GBP',
          notes: notes.trim() || null,
        });
        showMsg?.('Project updated', 'success');
      } else {
        await api.post('/api/crm/retainers', {
          dealId,
          contactId: contactId || null,
          title: title.trim(),
          allocationType,
          allocationAmount: amt,
          currency: 'GBP',
          notes: notes.trim() || null,
        });
        showMsg?.('Project created', 'success');
      }
      onSaved?.();
    } catch (err) {
      showMsg?.(err.message || 'Failed to save', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm('Delete this project and all its work entries? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await api.delete('/api/crm/retainers/' + retainer.id);
      showMsg?.('Project deleted', 'success');
      onDeleted?.();
    } catch (err) {
      showMsg?.(err.message || 'Failed to delete', 'error');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{editing ? 'Edit project' : 'New project'}</h2>
        <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Title">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="input"
            placeholder="e.g. Video retainer Q3 2026"
            required
            autoFocus
          />
        </Field>

        <Field label="Contact (optional)">
          <select value={contactId} onChange={(e) => setContactId(e.target.value)} className="input">
            <option value="">— None —</option>
            {sortedContacts.map(c => (
              <option key={c.id} value={c.id}>{c.name || c.email}{c.name && c.email ? ` (${c.email})` : ''}</option>
            ))}
          </select>
        </Field>

        <Field label="Allocation type">
          <div style={{ display: 'flex', gap: 8 }}>
            {[{ value: 'money', label: '£ Money' }, { value: 'credits', label: 'Credits' }].map(opt => (
              <label
                key={opt.value}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  gap: 6, padding: '8px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                  border: '1px solid ' + (allocationType === opt.value ? BRAND.blue : BRAND.border),
                  background: allocationType === opt.value ? BRAND.blue + '12' : 'white',
                  color: allocationType === opt.value ? BRAND.blue : BRAND.ink,
                  fontWeight: allocationType === opt.value ? 600 : 400,
                }}
              >
                <input
                  type="radio"
                  name="allocationType"
                  value={opt.value}
                  checked={allocationType === opt.value}
                  onChange={() => setAllocationType(opt.value)}
                  style={{ display: 'none' }}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </Field>

        <Field label={allocationType === 'money' ? 'Budget (£)' : 'Credits allocated'}>
          <input
            type="number"
            step={allocationType === 'money' ? '0.01' : '1'}
            min="0"
            value={allocationAmount}
            onChange={(e) => setAllocationAmount(e.target.value)}
            className="input"
            placeholder={allocationType === 'money' ? '10000.00' : '500'}
            required
          />
        </Field>

        <Field label="Notes (optional)">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="input"
            rows={2}
            placeholder="Any additional context…"
            style={{ fontFamily: 'inherit', resize: 'vertical' }}
          />
        </Field>

        <div style={{ display: 'flex', justifyContent: editing ? 'space-between' : 'flex-end', gap: 8, marginTop: 8 }}>
          {editing && (
            <button type="button" onClick={handleDelete} className="btn-ghost is-danger" disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete project'}
            </button>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" className="btn" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Create project'}</button>
          </div>
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
