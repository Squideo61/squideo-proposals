import React, { useMemo, useState } from 'react';
import { ArrowLeft, Plus, KanbanSquare } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, useIsMobile } from '../../utils.js';
import { Modal } from '../ui.jsx';
import { PIPELINE_STAGES } from '../../lib/stages.js';

export { PIPELINE_STAGES };

const STAGE_BY_ID = Object.fromEntries(PIPELINE_STAGES.map(s => [s.id, s]));

export function PipelineView({ onBack, onOpenDeal }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [creating, setCreating] = useState(false);

  const deals = useMemo(() => Object.values(state.deals || {}), [state.deals]);
  const grouped = useMemo(() => {
    const out = Object.fromEntries(PIPELINE_STAGES.map(s => [s.id, []]));
    for (const d of deals) {
      const stage = STAGE_BY_ID[d.stage] ? d.stage : 'lead';
      out[stage].push(d);
    }
    return out;
  }, [deals]);

  const handleDrop = (deal, toStage) => {
    if (!deal || deal.stage === toStage) return;
    actions.moveDealStage(deal.id, toStage);
    showMsg(`Moved to ${STAGE_BY_ID[toStage]?.label || toStage}`);
  };

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <KanbanSquare size={22} color={BRAND.blue} />
            Pipeline
          </h1>
          <span style={{ fontSize: 13, color: BRAND.muted }}>{deals.length} deals</span>
        </div>
        <button onClick={() => setCreating(true)} className="btn"><Plus size={16} /> New deal</button>
      </header>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}>
        {PIPELINE_STAGES.map((s, i) => {
          const isFirstExit = s.defaultCollapsed && !PIPELINE_STAGES[i - 1]?.defaultCollapsed;
          return (
            <React.Fragment key={s.id}>
              {isFirstExit && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0' }}>
                  <div style={{ flex: 1, height: 1, background: BRAND.border }} />
                  <span style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>Parked &amp; closed</span>
                  <div style={{ flex: 1, height: 1, background: BRAND.border }} />
                </div>
              )}
              <StageRow
                stage={s}
                deals={grouped[s.id] || []}
                onDrop={(deal) => handleDrop(deal, s.id)}
                onOpenDeal={onOpenDeal}
              />
            </React.Fragment>
          );
        })}
      </div>

      {creating && <NewDealModal onClose={() => setCreating(false)} onCreated={(d) => { setCreating(false); if (d) onOpenDeal(d.id); }} />}
    </div>
  );
}

function StageRow({ stage, deals, onDrop, onOpenDeal }) {
  const [hover, setHover] = useState(false);
  const [collapsed, setCollapsed] = useState(stage.defaultCollapsed ?? false);
  const total = deals.reduce((s, d) => s + (Number(d.value) || 0), 0);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setHover(true); }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        try {
          const data = JSON.parse(e.dataTransfer.getData('application/json'));
          onDrop(data);
        } catch {}
      }}
      style={{
        background: hover ? '#F0F9FF' : '#F8FAFC',
        border: hover ? '1px dashed ' + BRAND.blue : '1px solid ' + BRAND.border,
        borderLeft: '4px solid ' + stage.color,
        borderRadius: 10,
        padding: 12,
        transition: 'background 100ms, border-color 100ms',
      }}
    >
      <button
        onClick={() => setCollapsed(c => !c)}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
          width: '100%',
          padding: '0 2px',
          marginBottom: collapsed ? 0 : 10,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
        aria-expanded={!collapsed}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: stage.color, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            {stage.label}
          </span>
          <span style={{ fontSize: 12, color: BRAND.muted }}>· {deals.length}</span>
          {total > 0 && (
            <span style={{ fontSize: 12, color: BRAND.muted, fontVariantNumeric: 'tabular-nums' }}>· {formatGBP(total)}</span>
          )}
        </div>
        <span style={{ fontSize: 11, color: BRAND.muted }}>{collapsed ? 'Show' : 'Hide'}</span>
      </button>
      {!collapsed && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 8,
        }}>
          {deals.map(d => <DealCard key={d.id} deal={d} onOpen={() => onOpenDeal(d.id)} />)}
          {deals.length === 0 && (
            <div style={{ padding: '16px 8px', color: BRAND.muted, fontSize: 12, fontStyle: 'italic' }}>
              No deals
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DealCard({ deal, onOpen }) {
  const { state } = useStore();
  const owner = deal.ownerEmail ? state.users[deal.ownerEmail] : null;
  const company = deal.companyId ? state.companies[deal.companyId] : null;
  const ageDays = daysSince(deal.stageChangedAt);
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/json', JSON.stringify(deal))}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      style={{
        background: 'white',
        border: '1px solid ' + BRAND.border,
        borderRadius: 8,
        padding: 10,
        cursor: 'grab',
        boxShadow: '0 1px 2px rgba(15,42,61,0.04)',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, lineHeight: 1.3 }}>{deal.title}</div>
      {company && <div style={{ fontSize: 11, color: BRAND.muted, marginBottom: 6 }}>{company.name}</div>}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: BRAND.ink, fontVariantNumeric: 'tabular-nums' }}>
          {deal.value != null ? formatGBP(deal.value) : <span style={{ color: BRAND.muted, fontWeight: 400 }}>—</span>}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {ageDays != null && (
            <span style={{ fontSize: 10, color: ageDays > 14 ? '#92400E' : BRAND.muted }} title={`${ageDays} days in stage`}>
              {ageDays}d
            </span>
          )}
          <Avatar user={owner} fallback={deal.ownerEmail} />
        </div>
      </div>
    </div>
  );
}

function Avatar({ user, fallback, size = 18 }) {
  const name = user?.name || fallback || '?';
  const initial = (name[0] || '?').toUpperCase();
  return (
    <div title={name} style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', background: BRAND.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: Math.round(size * 0.5), flexShrink: 0 }}>
      {user?.avatar
        ? <img src={user.avatar} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : initial}
    </div>
  );
}

function daysSince(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function NewDealModal({ onClose, onCreated }) {
  const { state, actions } = useStore();
  const [title, setTitle] = useState('');
  const [stage, setStage] = useState('lead');
  const [value, setValue] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [primaryContactId, setPrimaryContactId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const companies = Object.values(state.companies || {});
  const contacts = Object.values(state.contacts || {});

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      const deal = await actions.createDeal({
        title: title.trim(),
        stage,
        value: value === '' ? null : Number(value),
        companyId: companyId || null,
        primaryContactId: primaryContactId || null,
      });
      onCreated?.(deal);
    } catch (err) {
      console.error('createDeal failed', err);
      window.alert('Failed to create deal: ' + (err?.message || 'unknown error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>New deal</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Title
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Acme Corp — Q2 explainer" autoFocus style={{ marginTop: 4 }} required />
        </label>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Stage
          <select className="input" value={stage} onChange={(e) => setStage(e.target.value)} style={{ marginTop: 4 }}>
            {PIPELINE_STAGES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Value (£, ex VAT, optional)
          <input className="input" type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Company (optional)
          <select className="input" value={companyId} onChange={(e) => setCompanyId(e.target.value)} style={{ marginTop: 4 }}>
            <option value="">—</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Primary contact (optional)
          <select className="input" value={primaryContactId} onChange={(e) => setPrimaryContactId(e.target.value)} style={{ marginTop: 4 }}>
            <option value="">—</option>
            {contacts.map(c => <option key={c.id} value={c.id}>{c.name || c.email}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={!title.trim() || submitting}>
            {submitting ? 'Creating…' : 'Create deal'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
