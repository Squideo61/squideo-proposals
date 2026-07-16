import React from 'react';
import { FileText, Pencil } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';

// Admin → Default proposal. The stored default (settings.default_proposal) is
// the base every new proposal is cloned from. Editing happens in the full
// proposal builder (BuilderView mode="default"), launched via onEditDefault —
// this tab is just the entry point plus a summary of the current defaults.
export function DefaultProposalTab({ onEditDefault }) {
  const { state } = useStore();
  const d = state.defaultProposal || {};

  const gbp = (n) => '£' + (Number(n) || 0).toLocaleString('en-GB', { maximumFractionDigits: 0 });
  const summary = [
    { label: 'Base price', value: gbp(d.basePrice) },
    { label: 'Included items', value: (d.baseInclusions || []).length },
    { label: 'Optional extras', value: (d.optionalExtras || []).length },
    { label: 'Delivery team', value: (d.team || []).length + ' member' + ((d.team || []).length === 1 ? '' : 's') },
    { label: 'Partner Programme', value: d.partnerProgramme?.enabled ? 'On' : 'Off' },
    { label: 'Validity', value: (d.validityDays || 0) + ' days' },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20 }}>
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
        marginBottom: 20,
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
    </div>
  );
}
