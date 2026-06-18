import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { api } from '../../api.js';
import { Card, Empty } from './Card.jsx';
import { fmtValue, fmtCredits, fmtDate, creditBarMeta, CreditUsageBar } from './creditDisplay.jsx';

// Read-only mirror of every credit allocated against a company, from both
// sources: deal "Credit Based Projects" (project_retainers, across all the
// company's deals) and partner credits (partner_subscriptions / credit_
// allocations). Allocation/logging still happens on the deal page and the
// Partners & Credits page — this is a view only.
export function CompanyCreditsCard({ companyId }) {
  const { showMsg } = useStore();
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!companyId) return;
    api.get('/api/crm/companies/' + encodeURIComponent(companyId) + '/credits')
      .then(setData)
      .catch((err) => {
        showMsg?.(err.message || 'Failed to load credits', 'error');
        setData({ retainers: [], partnerCredits: [] });
      });
  }, [companyId, showMsg]);

  const retainers = data?.retainers || [];
  const partnerCredits = data?.partnerCredits || [];
  const count = data ? retainers.length + partnerCredits.length : null;

  return (
    <Card title="Current Projects" count={count}>
      {!data && <div style={{ padding: '12px 4px', fontSize: 13, color: BRAND.muted }}>Loading…</div>}
      {data && count === 0 && <Empty text="No credits allocated to this company yet" />}
      {data && count > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {retainers.map(r => <RetainerRow key={r.id} retainer={r} />)}
          {partnerCredits.map(p => <PartnerRow key={p.clientKey} partner={p} />)}
        </div>
      )}
    </Card>
  );
}

// A deal credit-based project — title + deal name, usage bar, work log.
function RetainerRow({ retainer }) {
  const status = retainer.status || 'active';
  const used = (retainer.entries || []).reduce((s, e) => s + Number(e.value || 0), 0);
  return (
    <ProjectRow
      title={retainer.title}
      subLabel={retainer.dealTitle}
      badge={status !== 'active' ? <Pill {...STATUS_PILL[status]} /> : null}
      dimmed={status !== 'active'}
      allocationType={retainer.allocationType}
      total={retainer.allocationAmount}
      used={used}
      valueHeader={retainer.allocationType === 'money' ? 'Value' : 'Credits'}
      rows={(retainer.entries || []).map(e => ({
        key: e.id,
        date: e.workedAt,
        description: e.description,
        value: fmtValue(retainer.allocationType, e.value),
      }))}
      emptyText="No work logged yet"
      notes={retainer.notes}
    />
  );
}

// A partner-credit balance — client name + status pill, usage bar, allocation
// ledger. Adjustments (+ added / − removed) and work (used) match the
// Partners & Credits detail view.
function PartnerRow({ partner }) {
  const pill = PARTNER_PILL[partner.status] || PARTNER_PILL.inactive;
  return (
    <ProjectRow
      title={partner.clientName || partner.clientKey}
      subLabel="Partner credits"
      badge={<Pill {...pill} />}
      allocationType="credits"
      total={partner.creditsIssued}
      used={partner.creditsUsed}
      valueHeader="Credits"
      rows={(partner.allocations || []).map(a => {
        const isAdj = a.kind === 'adjustment';
        const added = isAdj && a.creditCost > 0;
        return {
          key: a.id,
          date: a.allocatedAt,
          description: a.description,
          // Adjustments show a signed value (green when credits were added);
          // work is credits used.
          value: (added ? '+' : isAdj && a.creditCost < 0 ? '−' : '') + fmtCredits(Math.abs(a.creditCost)) + ' credits',
          valueColor: added ? '#16A34A' : undefined,
        };
      })}
      emptyText="No allocations yet"
    />
  );
}

// Shared collapsible, read-only project row (no Log work / menu / delete).
function ProjectRow({ title, subLabel, badge, dimmed, allocationType, total, used, valueHeader, rows, emptyText, notes }) {
  const [open, setOpen] = useState(!dimmed);
  const { remaining, remainingColor } = creditBarMeta(total, used);

  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden', opacity: dimmed ? 0.65 : 1 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 12px', background: BRAND.paper,
        borderBottom: open ? '1px solid ' + BRAND.border : 'none',
      }}>
        <button
          onClick={() => setOpen(v => !v)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', color: BRAND.muted }}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: BRAND.ink }}>{title}</span>
            {badge}
          </div>
          {subLabel && <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 1 }}>{subLabel}</div>}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: remainingColor }}>{fmtValue(allocationType, remaining)}</div>
          <div style={{ fontSize: 10, color: BRAND.muted }}>remaining</div>
        </div>
      </div>

      {open && (
        <div style={{ padding: 12 }}>
          <CreditUsageBar allocationType={allocationType} total={total} used={used} />

          {rows.length === 0 ? (
            <div style={{ fontSize: 12, color: BRAND.muted, fontStyle: 'italic', padding: '4px 0' }}>{emptyText}</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={TH}>Date</th>
                  <th style={TH}>Description</th>
                  <th style={{ ...TH, textAlign: 'right' }}>{valueHeader}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.key}>
                    <td style={{ ...TD, color: BRAND.muted, whiteSpace: 'nowrap' }}>{fmtDate(row.date)}</td>
                    <td style={{ ...TD, color: BRAND.ink }}>{row.description}</td>
                    <td style={{ ...TD, color: row.valueColor || BRAND.ink, fontWeight: 600, textAlign: 'right', whiteSpace: 'nowrap' }}>{row.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {notes && (
            <div style={{ marginTop: 10, fontSize: 12, color: BRAND.muted, fontStyle: 'italic' }}>{notes}</div>
          )}
        </div>
      )}
    </div>
  );
}

const TH = { textAlign: 'left', padding: '4px 6px', color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.4, borderBottom: '1px solid ' + BRAND.border };
const TD = { padding: '6px 6px', borderBottom: '1px solid ' + BRAND.border };

const STATUS_PILL = {
  completed: { label: 'Completed', bg: '#DCFCE7', fg: '#15803D' },
  archived:  { label: 'Archived',  bg: '#E5E7EB', fg: '#475569' },
};
const PARTNER_PILL = {
  active:       { label: 'Active',       bg: '#DCFCE7', fg: '#15803D' },
  credits_only: { label: 'Credits',      bg: '#DBEAFE', fg: '#1E40AF' },
  inactive:     { label: 'Inactive',     bg: '#E5E7EB', fg: '#475569' },
};

function Pill({ label, bg, fg }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
      padding: '2px 6px', borderRadius: 4, background: bg, color: fg,
    }}>{label}</span>
  );
}
