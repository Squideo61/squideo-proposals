import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, Clapperboard, Film, Plus } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { Modal } from '../ui.jsx';
import { XeroContactPicker } from './XeroContactPicker.jsx';
import { api } from '../../api.js';
import {
  PRODUCTION_PHASES, PHASE_BY_ID, PAYMENT_TERMS_LABEL,
} from '../../lib/productionStages.js';

const PRODUCER_FILTER_STORAGE_KEY = 'squideo.production.producerFilter';
const PHASE_STORAGE_KEY = 'squideo.production.phase';

// Table columns, mirroring Monday's main table: Item | Payment | Length |
// Text direction | Delivery | Producer. Shared by the header and every row so
// columns line up across the stage groups.
const COLS = 'minmax(220px, 2.2fr) 110px 100px 120px 120px 170px';
const chip = { display: 'inline-block', fontSize: 11, color: BRAND.ink, background: '#F1F5F9', borderRadius: 999, padding: '2px 8px' };

// Production board: paid deals ("projects") moving through the video-production
// workflow, laid out like Monday's main table — stage groups of rows with
// Payment / Length / Producer columns. Phase tabs switch boards; dragging a row
// onto a stage group (or a phase tab) moves the project.
export function ProductionView({ onBack, onOpenDeal }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();

  useEffect(() => { actions.loadProduction(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [creating, setCreating] = useState(false);
  const [activePhase, setActivePhase] = useState(() => {
    try { return localStorage.getItem(PHASE_STORAGE_KEY) || PRODUCTION_PHASES[0].id; } catch { return PRODUCTION_PHASES[0].id; }
  });
  useEffect(() => { try { localStorage.setItem(PHASE_STORAGE_KEY, activePhase); } catch {} }, [activePhase]);

  const [producerFilter, setProducerFilter] = useState(() => {
    try { return localStorage.getItem(PRODUCER_FILTER_STORAGE_KEY) || ''; } catch { return ''; }
  });
  useEffect(() => { try { localStorage.setItem(PRODUCER_FILTER_STORAGE_KEY, producerFilter); } catch {} }, [producerFilter]);

  const projects = useMemo(
    () => Object.values(state.deals || {}).filter(d => d.productionPhase),
    [state.deals],
  );
  const filtered = useMemo(
    () => (producerFilter ? projects.filter(p => p.producerEmail === producerFilter) : projects),
    [projects, producerFilter],
  );

  const countByPhase = useMemo(() => {
    const out = Object.fromEntries(PRODUCTION_PHASES.map(p => [p.id, 0]));
    for (const p of filtered) if (out[p.productionPhase] != null) out[p.productionPhase] += 1;
    return out;
  }, [filtered]);

  const phase = PHASE_BY_ID[activePhase] || PRODUCTION_PHASES[0];
  const grouped = useMemo(() => {
    const out = Object.fromEntries(phase.stages.map(s => [s.id, []]));
    const fallback = phase.stages[0]?.id;
    for (const p of filtered) {
      if (p.productionPhase !== phase.id) continue;
      const stage = out[p.productionStage] ? p.productionStage : fallback;
      (out[stage] || out[fallback]).push(p);
    }
    return out;
  }, [filtered, phase]);

  const memberOptions = useMemo(() => Object.entries(state.users || {})
    .map(([email, u]) => ({ email, name: u.name || email }))
    .sort((a, b) => a.name.localeCompare(b.name)), [state.users]);

  const handleDropOnStage = (deal, stageId) => {
    if (!deal) return;
    if (deal.productionPhase === phase.id && deal.productionStage === stageId) return;
    actions.moveProjectStage(deal.id, phase.id, stageId);
    showMsg(`Moved to ${phase.stages.find(s => s.id === stageId)?.label || stageId}`);
  };

  const handleDropOnPhase = (deal, phaseId) => {
    if (!deal) return;
    const target = PHASE_BY_ID[phaseId];
    if (!target) return;
    const firstStage = target.stages[0]?.id;
    if (deal.productionPhase === phaseId && deal.productionStage === firstStage) return;
    actions.moveProjectStage(deal.id, phaseId, firstStage);
    setActivePhase(phaseId);
    showMsg(`Moved to ${target.label}`);
  };

  return (
    <div style={{ padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {onBack && <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>}
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Clapperboard size={22} color={BRAND.blue} /> Production
          </h1>
          <ProducerFilter
            producerFilter={producerFilter}
            setProducerFilter={setProducerFilter}
            memberOptions={memberOptions}
            sessionEmail={state.session?.email || ''}
          />
          <span style={{ fontSize: 13, color: BRAND.muted }}>{filtered.length} projects</span>
        </div>
        <button onClick={() => setCreating(true)} className="btn"><Plus size={16} /> New project</button>
      </header>

      {/* Phase tabs — also drop targets for cross-phase moves. */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid ' + BRAND.border, flexWrap: 'wrap' }}>
        {PRODUCTION_PHASES.map(p => (
          <PhaseTab
            key={p.id}
            phase={p}
            active={p.id === activePhase}
            count={countByPhase[p.id] || 0}
            onSelect={() => setActivePhase(p.id)}
            onDropDeal={(deal) => handleDropOnPhase(deal, p.id)}
          />
        ))}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 900 }}>
          <ColumnsHeader />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {phase.stages.map(s => (
              <StageGroup
                key={s.id}
                stage={s}
                color={phase.color}
                deals={grouped[s.id] || []}
                onDrop={(deal) => handleDropOnStage(deal, s.id)}
                onOpenDeal={onOpenDeal}
              />
            ))}
          </div>
        </div>
      </div>

      {creating && (
        <NewProjectModal
          onClose={() => setCreating(false)}
          onCreated={(deal) => { setCreating(false); if (deal) onOpenDeal(deal.id); }}
        />
      )}
    </div>
  );
}

function ColumnsHeader() {
  const cell = { fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, alignItems: 'center', padding: '0 13px 6px 16px' }}>
      <span style={cell}>Item</span>
      <span style={cell}>Payment</span>
      <span style={cell}>Length</span>
      <span style={cell}>Text direction</span>
      <span style={cell}>Delivery</span>
      <span style={cell}>Producer</span>
    </div>
  );
}

function PhaseTab({ phase, active, count, onSelect, onDropDeal }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onSelect}
      onDragOver={(e) => { e.preventDefault(); setHover(true); }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        try { onDropDeal(JSON.parse(e.dataTransfer.getData('application/json'))); } catch {}
      }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 14px',
        border: 'none', borderBottom: '2px solid ' + (active ? phase.color : 'transparent'),
        background: hover ? '#F0F9FF' : 'transparent', cursor: 'pointer',
        fontSize: 14, fontWeight: active ? 700 : 500, color: active ? BRAND.ink : BRAND.muted,
        marginBottom: -1,
      }}
    >
      <span style={{ width: 9, height: 9, borderRadius: '50%', background: phase.color, opacity: active ? 1 : 0.5 }} />
      {phase.label}
      <span style={{ fontSize: 12, color: BRAND.muted, fontWeight: 500 }}>· {count}</span>
    </button>
  );
}

// One stage = one Monday-style group: a coloured header line and its rows. The
// whole box is a drop target so a dragged row can land anywhere in the group.
function StageGroup({ stage, color, deals, onDrop, onOpenDeal }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setHover(true); }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        try { onDrop(JSON.parse(e.dataTransfer.getData('application/json'))); } catch {}
      }}
      style={{
        background: hover ? '#F0F9FF' : 'white',
        border: hover ? '1px dashed ' + BRAND.blue : '1px solid ' + BRAND.border,
        borderLeft: '4px solid ' + color,
        borderRadius: 10,
        padding: 12,
        transition: 'background 100ms, border-color 100ms',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: deals.length ? 6 : 0 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: 0.4 }}>{stage.label}</span>
        <span style={{ fontSize: 12, color: BRAND.muted }}>· {deals.length}</span>
      </div>
      {deals.length === 0
        ? <div style={{ padding: '6px 2px', color: BRAND.muted, fontSize: 12, fontStyle: 'italic' }}>No projects</div>
        : deals.map(d => <ProjectRow key={d.id} deal={d} onOpen={() => onOpenDeal(d.id)} />)}
    </div>
  );
}

function ProjectRow({ deal, onOpen }) {
  const { state } = useStore();
  const producer = deal.producerEmail ? state.users[deal.producerEmail] : null;
  const company = deal.companyId ? state.companies[deal.companyId] : null;
  const videoCount = deal.videoCount || 0;
  const credits = deal.productionCredits || 0;
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/json', JSON.stringify(deal))}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      style={{
        display: 'grid', gridTemplateColumns: COLS, gap: 12, alignItems: 'center',
        padding: '9px 0', borderTop: '1px solid ' + BRAND.border, cursor: 'grab', fontSize: 13,
      }}
    >
      {/* Item */}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{deal.title}</div>
        <div style={{ fontSize: 11, color: BRAND.muted, display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {company?.name ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{company.name}</span> : null}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}><Film size={10} /> {videoCount}</span>
          {credits > 0 && <span style={{ color: '#92400E', flexShrink: 0 }}>+{credits} cr</span>}
        </div>
      </div>
      {/* Payment */}
      <div>{deal.paymentTerms
        ? <span style={chip}>{PAYMENT_TERMS_LABEL[deal.paymentTerms] || deal.paymentTerms}</span>
        : <span style={{ color: BRAND.muted }}>—</span>}</div>
      {/* Length */}
      <div style={{ color: deal.videoLength ? BRAND.ink : BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{deal.videoLength || '—'}</div>
      {/* Text direction */}
      <div style={{ color: deal.textDirectionDeadline ? BRAND.ink : BRAND.muted }}>{deal.textDirectionDeadline ? formatDate(deal.textDirectionDeadline) : '—'}</div>
      {/* Delivery */}
      <div style={{ color: deal.deliveryDeadline ? BRAND.ink : BRAND.muted }}>{deal.deliveryDeadline ? formatDate(deal.deliveryDeadline) : '—'}</div>
      {/* Producer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {producer || deal.producerEmail
          ? <>
              <Avatar user={producer} fallback={deal.producerEmail} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{producer?.name || deal.producerEmail}</span>
            </>
          : <span style={{ color: BRAND.muted }}>Unassigned</span>}
      </div>
    </div>
  );
}

// Producer filter — "All producers" / "<Name>". Mirrors the pipeline owner filter.
function ProducerFilter({ producerFilter, setProducerFilter, memberOptions, sessionEmail }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  const selectedName = producerFilter ? (memberOptions.find(m => m.email === producerFilter)?.name || producerFilter) : '';
  const label = !producerFilter ? 'All producers' : `${selectedName.split(' ')[0]}'s projects`;
  const choose = (email) => { setProducerFilter(email); setOpen(false); };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}
        className="btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
        {label}<ChevronDown size={14} style={{ opacity: 0.6 }} />
      </button>
      {open && (
        <div role="listbox" style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, background: 'white',
          border: '1px solid ' + BRAND.border, borderRadius: 8, boxShadow: '0 8px 24px rgba(15, 42, 61, 0.12)',
          minWidth: 220, padding: 4, zIndex: 50, maxHeight: 320, overflowY: 'auto',
        }}>
          <FilterOption label="All producers" selected={!producerFilter} onClick={() => choose('')} />
          {memberOptions.map(m => (
            <FilterOption key={m.email}
              label={m.email === sessionEmail ? `${m.name} (me)` : m.name}
              selected={producerFilter === m.email}
              onClick={() => choose(m.email)} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterOption({ label, selected, onClick }) {
  return (
    <button role="option" aria-selected={selected} onClick={onClick}
      onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = selected ? '#EFF8FC' : 'transparent'; }}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%',
        padding: '8px 10px', border: 'none', background: selected ? '#EFF8FC' : 'transparent', borderRadius: 6,
        cursor: 'pointer', fontSize: 13, color: BRAND.ink, textAlign: 'left',
      }}>
      <span>{label}</span>{selected && <Check size={14} color={BRAND.blue} />}
    </button>
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

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Create a project from scratch and assign it to a customer. Mirrors the
// pipeline's "New deal" modal (Xero contact → company), but the result lands
// straight on the production board with one video.
function NewProjectModal({ onClose, onCreated }) {
  const { state, actions, showMsg } = useStore();
  const [title, setTitle] = useState('');
  const [xeroContact, setXeroContact] = useState(null);
  const [primaryContactId, setPrimaryContactId] = useState('');
  const [producerEmail, setProducerEmail] = useState('');
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const contacts = Object.values(state.contacts || {});
  const memberOptions = Object.entries(state.users || {})
    .map(([email, u]) => ({ email, name: u.name || email }))
    .sort((a, b) => a.name.localeCompare(b.name));

  function handleXeroPick(c) {
    setXeroContact(c);
    if (c && !title.trim()) setTitle(c.name);
  }

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      // Resolve the picked Xero contact → local company (find or create + link).
      let companyId = null;
      if (xeroContact) {
        const company = await api.post('/api/crm/companies/from-xero-contact', { xeroContactId: xeroContact.id });
        companyId = company.id;
      }
      const deal = await actions.createProject({
        title: title.trim(),
        companyId,
        primaryContactId: primaryContactId || null,
        producerEmail: producerEmail || null,
        value: value === '' ? null : Number(value),
      });
      onCreated?.(deal);
    } catch (err) {
      showMsg?.('Failed to create project: ' + (err?.message || 'unknown error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>New project</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Customer (Xero contact)
          <div style={{ marginTop: 4 }}>
            <XeroContactPicker value={xeroContact} onChange={handleXeroPick} placeholder="Search Xero contacts…" />
          </div>
        </label>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Project title
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Acme Corp — Brand explainer" style={{ marginTop: 4 }} required />
        </label>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Primary contact (optional)
          <select className="input" value={primaryContactId} onChange={(e) => setPrimaryContactId(e.target.value)} style={{ marginTop: 4 }}>
            <option value="">—</option>
            {contacts.map(c => <option key={c.id} value={c.id}>{c.name || c.email}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Producer (optional)
          <select className="input" value={producerEmail} onChange={(e) => setProducerEmail(e.target.value)} style={{ marginTop: 4 }}>
            <option value="">— Unassigned —</option>
            {memberOptions.map(m => <option key={m.email} value={m.email}>{m.name}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Value (£, ex VAT, optional)
          <input className="input" type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={!title.trim() || submitting}>
            {submitting ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
