import React from 'react';
import { ArrowLeft, FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { formatGBP, useIsMobile } from '../utils.js';
import { Logo } from './ui.jsx';

export function TemplatesView({ onBack, onUse, onEdit, onCreate, onDelete }) {
  const { state } = useStore();
  const isMobile = useIsMobile();

  const templates = Object.entries(state.templates)
    .map(([id, d]) => ({ id, ...d }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? '20px 16px' : '40px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32, gap: 16, flexWrap: 'wrap' }}>
        <div>
          <button onClick={onBack} className="btn-ghost" style={{ marginBottom: 12 }}>
            <ArrowLeft size={14} /> Back to proposals
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
            <Logo size={36} />
            <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Templates</h1>
          </div>
          <p style={{ fontSize: 14, color: BRAND.muted, margin: 0, marginLeft: 48 }}>
            Reusable proposal blueprints. Use one to create a new proposal, or edit to update.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={onCreate} className="btn"><Plus size={16} /> New Template</button>
        </div>
      </header>

      {templates.length === 0 ? (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 60, textAlign: 'center' }}>
          <FileText size={40} color={BRAND.muted} style={{ marginBottom: 12 }} />
          <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>No templates yet</h3>
          <p style={{ color: BRAND.muted, fontSize: 14, margin: '0 0 20px' }}>
            Save a proposal as a template, or start one from scratch.
          </p>
          <button onClick={onCreate} className="btn"><Plus size={16} /> Create template</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {templates.map((t) => (
            <TemplateCard key={t.id} template={t} onUse={onUse} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({ template, onUse, onEdit, onDelete }) {
  const isMobile = useIsMobile();
  const total = (template.basePrice || 0) * (1 + (template.vatRate || 0));
  const extras = (template.optionalExtras || []).length;
  const inclusions = (template.baseInclusions || []).length;
  const created = template.createdAt
    ? new Date(template.createdAt).toLocaleDateString('en-GB')
    : '—';

  return (
    <div
      style={{
        background: 'white',
        border: '1px solid ' + BRAND.border,
        borderRadius: 10,
        padding: isMobile ? 12 : 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: isMobile ? 10 : 16,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <FileText size={16} color={BRAND.blue} />
          <h3 style={{ margin: 0, fontSize: isMobile ? 14 : 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {template.name || 'Untitled template'}
          </h3>
        </div>
        <div style={{ fontSize: isMobile ? 11 : 13, color: BRAND.muted, display: 'flex', gap: isMobile ? 10 : 16, flexWrap: 'wrap', marginLeft: 24 }}>
          <span>{formatGBP(total)} inc. VAT</span>
          <span>{inclusions} {inclusions === 1 ? 'inclusion' : 'inclusions'}</span>
          <span>{extras} {extras === 1 ? 'extra' : 'extras'}</span>
          <span>Saved {created}</span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 4 : 8, flexWrap: 'wrap' }}>
        <button onClick={() => onUse(template)} className="btn" title="Create new proposal from this template">
          <Plus size={14} /> Use
        </button>
        <button onClick={() => onEdit(template.id)} className="btn-icon" title="Edit template" aria-label={'Edit template ' + (template.name || '')}>
          <Pencil size={16} />
        </button>
        <button onClick={() => onDelete(template.id)} className="btn-icon is-danger" title="Delete template" aria-label={'Delete template ' + (template.name || '')}>
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
