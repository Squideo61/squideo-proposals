import React, { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { Modal } from './ui.jsx';

export function InclusionsBankManager({ onClose }) {
  const { state, actions, showMsg } = useStore();
  const [items, setItems] = useState(() => JSON.parse(JSON.stringify(state.inclusionsBank)));

  const update = (i, patch) => {
    setItems(prev => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  };

  const remove = (i) => setItems(prev => prev.filter((_, idx) => idx !== i));

  const add = () => setItems(prev => [
    ...prev,
    { id: 'incl_' + Date.now(), title: '', description: '' }
  ]);

  const save = () => {
    actions.saveInclusionsBank(items, { oldBank: state.inclusionsBank, proposals: state.proposals });
    showMsg('Inclusions bank saved');
    onClose();
  };

  return (
    <Modal onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Inclusions Bank</h3>
        <button onClick={onClose} aria-label="Close" className="btn-icon"><X size={14} /></button>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
        Manage the shared library of what's included items. Items can be added to any proposal from the builder.
      </p>

      <div style={{ display: 'grid', gap: 10, marginBottom: 12 }}>
        {items.map((item, i) => (
          <div key={item.id} style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 12 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <input
                className="input"
                style={{ flex: 1 }}
                value={item.title}
                onChange={(e) => update(i, { title: e.target.value })}
                placeholder="Inclusion title"
              />
              <button onClick={() => remove(i)} aria-label="Remove" className="btn-icon"><X size={14} /></button>
            </div>
            <textarea
              className="input"
              style={{ minHeight: 50, fontSize: 13 }}
              value={item.description || ''}
              onChange={(e) => update(i, { description: e.target.value })}
              placeholder="Description shown to client (optional)"
            />
          </div>
        ))}
      </div>

      <button onClick={add} className="btn-ghost" style={{ marginBottom: 20 }}>
        <Plus size={14} /> Add inclusion
      </button>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} className="btn-ghost">Cancel</button>
        <button onClick={save} className="btn">Save bank</button>
      </div>
    </Modal>
  );
}
