import React from 'react';
import { FileText, Pencil, Plus, Trash2, Sparkles } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, makeId } from '../../utils.js';
import { makeContentCreditTemplate, CONTENT_CREDIT_TEMPLATE_NAME } from '../../defaults.js';

// Admin → Proposals. One place to manage what new proposals are built from:
//   • the workspace Default proposal (the base every new proposal clones), and
//   • named Templates that appear in the "start from a template" picker when a
//     proposal is created.
// Editing a template opens the full proposal builder (via onEditTemplate);
// creating one is delegated to App (onCreateTemplate) so it uses the same
// new-template flow as the standalone Templates view.
export function DefaultProposalTab({ onEditDefault, onCreateTemplate, onEditTemplate }) {
  const { state, actions, showMsg } = useStore();
  const d = state.defaultProposal || {};

  const templates = Object.entries(state.templates)
    .map(([id, t]) => ({ id, ...t }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const hasContentCredit = templates.some(t => (t.name || '') === CONTENT_CREDIT_TEMPLATE_NAME);

  const gbp = (n) => '£' + (Number(n) || 0).toLocaleString('en-GB', { maximumFractionDigits: 0 });
  const summary = [
    { label: 'Base price', value: gbp(d.basePrice) },
    { label: 'Included items', value: (d.baseInclusions || []).length },
    { label: 'Optional extras', value: (d.optionalExtras || []).length },
    { label: 'Delivery team', value: (d.team || []).length + ' member' + ((d.team || []).length === 1 ? '' : 's') },
    { label: 'Partner Programme', value: d.partnerProgramme?.enabled ? 'On' : 'Off' },
    { label: 'Validity', value: (d.validityDays || 0) + ' days' },
  ];

  const seedContentCredit = () => {
    const tpl = makeContentCreditTemplate(state.defaultProposal);
    tpl.createdAt = Date.now();
    actions.saveTemplate(makeId(), tpl);
    showMsg('Added template: ' + CONTENT_CREDIT_TEMPLATE_NAME);
  };

  const removeTemplate = (id, name) => {
    if (!confirm('Delete the "' + (name || 'Untitled') + '" template?')) return;
    actions.deleteTemplate(id);
  };

  return (
    <div>
      {/* ── Default proposal ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: '#EFF6FF', color: BRAND.blue, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <FileText size={20} />
        </div>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700 }}>Default proposal</h2>
          <p style={{ margin: 0, fontSize: 13.5, color: BRAND.muted, lineHeight: 1.5, maxWidth: 620 }}>
            The starting point for every new proposal. Set the intro, delivery
            team, requirement, pricing, inclusions, extras and payment options
            here, and each new proposal opens pre-filled with them. Client-specific
            details are still entered per proposal.
          </p>
        </div>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
        gap: 10,
        marginBottom: 16,
      }}>
        {summary.map((s) => (
          <div key={s.label} style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 11.5, color: BRAND.muted, fontWeight: 600, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{s.value}</div>
          </div>
        ))}
      </div>

      <button onClick={onEditDefault} className="btn">
        <Pencil size={14} /> Edit default proposal
      </button>

      {/* ── Templates ── */}
      <div style={{ marginTop: 36, borderTop: '1px solid ' + BRAND.border, paddingTop: 28 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: '#FEF3C7', color: '#92400E', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Sparkles size={20} />
            </div>
            <div>
              <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700 }}>Templates</h2>
              <p style={{ margin: 0, fontSize: 13.5, color: BRAND.muted, lineHeight: 1.5, maxWidth: 620 }}>
                Named variations on the default. When someone starts a new proposal
                they can pick one of these instead of the default.
              </p>
            </div>
          </div>
          {onCreateTemplate && (
            <button onClick={onCreateTemplate} className="btn"><Plus size={14} /> New template</button>
          )}
        </div>

        {!hasContentCredit && (
          <div style={{ background: '#FFFAEB', border: '1px solid #FDE68A', borderRadius: 10, padding: '14px 16px', marginBottom: 14, display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
            <Sparkles size={18} color="#B45309" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#92400E', marginBottom: 2 }}>Content Credit template</div>
              <div style={{ fontSize: 13, color: '#78350F', lineHeight: 1.5 }}>
                A ready-made proposal with the one-off Content Credit programme —
                clients buy a block of production minutes upfront at a bulk discount
                (Purchase Order recommended). Built from your current default.
              </div>
            </div>
            <button onClick={seedContentCredit} className="btn"><Plus size={14} /> Add this template</button>
          </div>
        )}

        {templates.length === 0 ? (
          <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 28, textAlign: 'center', color: BRAND.muted, fontSize: 13.5 }}>
            No templates yet. Add the Content Credit starter above, or create your own.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {templates.map((t) => {
              const total = (t.basePrice || 0) * (1 + (t.vatRate || 0));
              const oneoff = t.partnerProgramme?.mode === 'oneoff';
              return (
                <div key={t.id} style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                      <FileText size={16} color={BRAND.blue} />
                      <span style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name || 'Untitled template'}</span>
                      {oneoff && <span style={{ fontSize: 11, fontWeight: 700, color: '#92400E', background: '#FEF3C7', border: '1px solid #FDE68A', padding: '1px 8px', borderRadius: 10 }}>Content Credit</span>}
                    </div>
                    <div style={{ fontSize: 12.5, color: BRAND.muted, marginLeft: 24 }}>
                      {formatGBP(total)} inc. VAT · {(t.baseInclusions || []).length} inclusions · {(t.optionalExtras || []).length} extras
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {onEditTemplate && (
                      <button onClick={() => onEditTemplate(t.id)} className="btn-ghost"><Pencil size={14} /> Edit</button>
                    )}
                    <button onClick={() => removeTemplate(t.id, t.name)} className="btn-icon is-danger" title="Delete template" aria-label={'Delete template ' + (t.name || '')}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
