import React from 'react';
import { FileText, Plus } from 'lucide-react';
import { BRAND } from '../theme.js';
import { formatGBP } from '../utils.js';
import { Modal } from './ui.jsx';

export function TemplatePicker({ templates, onPick, onClose }) {
  return (
    <Modal onClose={onClose}>
      <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700 }}>Start from a template</h3>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted }}>Pick a template or start blank.</p>
      <div style={{ display: 'grid', gap: 8, maxHeight: 360, overflowY: 'auto' }}>
        <button onClick={() => onPick(null)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'white', border: '2px dashed ' + BRAND.border, borderRadius: 8, cursor: 'pointer', width: '100%' }}>
          <Plus size={16} color={BRAND.muted} />
          <div style={{ flex: 1, textAlign: 'left' }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Blank proposal</div>
            <div style={{ fontSize: 12, color: BRAND.muted }}>Start from the default</div>
          </div>
        </button>
        {templates.map((t) => (
          <button key={t.id} onClick={() => onPick(t)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8, cursor: 'pointer', width: '100%' }}>
            <FileText size={16} color={BRAND.blue} />
            <div style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{t.name}</div>
              <div style={{ fontSize: 12, color: BRAND.muted }}>{formatGBP(t.basePrice * (1 + t.vatRate))}</div>
            </div>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={onClose} className="btn-ghost">Cancel</button>
      </div>
    </Modal>
  );
}
