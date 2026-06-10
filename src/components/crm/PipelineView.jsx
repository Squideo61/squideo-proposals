import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, ChevronDown, Plus, KanbanSquare, Eye, Mail, FileText, CheckSquare } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, formatRelativeTime, useIsMobile } from '../../utils.js';
import { Modal } from '../ui.jsx';
import { PIPELINE_STAGES } from '../../lib/stages.js';
import { XeroContactPicker } from './XeroContactPicker.jsx';
import { api } from '../../api.js';

export { PIPELINE_STAGES };

const STAGE_BY_ID = Object.fromEntries(PIPELINE_STAGES.map(s => [s.id, s]));

const OWNER_FILTER_STORAGE_KEY = 'squideo.pipeline.ownerFilter';

export function PipelineView({ onBack, onOpenDeal }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [creating, setCreating] = useState(false);

  // Owner filter — defaults to "All deals" (unlike the proposals list, which
  // defaults to the signed-in user). Persisted so it survives navigation.
  const sessionEmail = state.session?.email || '';
  const [ownerFilter, setOwnerFilter] = useState(() => {
    try { return localStorage.getItem(OWNER_FILTER_STORAGE_KEY) || ''; } catch { return ''; }
  });
  useEffect(() => {
    try { localStorage.setItem(OWNER_FILTER_STORAGE_KEY, ownerFilter); } catch {}
  }, [ownerFilter]);

  const allDeals = useMemo(() => Object.values(state.deals || {}), [state.deals]);
  const deals = useMemo(
    () => (ownerFilter ? allDeals.filter(d => d.ownerEmail === ownerFilter) : allDeals),
    [allDeals, ownerFilter],
  );

  const memberOptions = useMemo(() => Object.entries(state.users || {})
    .map(([email, u]) => ({ email, name: u.name || email }))
    .sort((a, b) => a.name.localeCompare(b.name)), [state.users]);

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
    <div style={{ padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <KanbanSquare size={22} color={BRAND.blue} />
            Sales Pipeline
          </h1>
          <OwnerFilter
            ownerFilter={ownerFilter}
            setOwnerFilter={setOwnerFilter}
            memberOptions={memberOptions}
            sessionEmail={sessionEmail}
          />
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

// Owner filter for the pipeline — "All deals" / "My deals" / "<Name>'s deals".
// Mirrors the proposals list's team-member filter for a consistent feel.
function OwnerFilter({ ownerFilter, setOwnerFilter, memberOptions, sessionEmail }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const selectedName = ownerFilter ? (memberOptions.find(m => m.email === ownerFilter)?.name || ownerFilter) : '';
  const label = !ownerFilter
    ? 'All deals'
    : ownerFilter === sessionEmail
    ? 'My deals'
    : `${selectedName.split(' ')[0]}'s deals`;

  const choose = (email) => { setOwnerFilter(email); setOpen(false); };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="btn-ghost"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}
      >
        {label}
        <ChevronDown size={14} style={{ opacity: 0.6 }} />
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0,
            background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8,
            boxShadow: '0 8px 24px rgba(15, 42, 61, 0.12)', minWidth: 220, padding: 4,
            zIndex: 50, maxHeight: 320, overflowY: 'auto',
          }}
        >
          <OwnerOption label="All team members" selected={!ownerFilter} onClick={() => choose('')} />
          {memberOptions.map((m) => (
            <OwnerOption
              key={m.email}
              label={m.email === sessionEmail ? `${m.name} (me)` : m.name}
              selected={ownerFilter === m.email}
              onClick={() => choose(m.email)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OwnerOption({ label, selected, onClick }) {
  return (
    <button
      role="option"
      aria-selected={selected}
      onClick={onClick}
      onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = selected ? '#EFF8FC' : 'transparent'; }}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%',
        padding: '8px 10px', border: 'none', background: selected ? '#EFF8FC' : 'transparent', borderRadius: 6,
        cursor: 'pointer', fontSize: 13, color: BRAND.ink, textAlign: 'left',
      }}
    >
      <span>{label}</span>
      {selected && <Check size={14} color={BRAND.blue} />}
    </button>
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
        deals.length === 0 ? (
          <div style={{ padding: '12px 8px', color: BRAND.muted, fontSize: 12, fontStyle: 'italic' }}>
            No deals
          </div>
        ) : (
          <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden' }}>
            {deals.map(d => <DealRow key={d.id} deal={d} onOpen={() => onOpenDeal(d.id)} />)}
          </div>
        )
      )}
    </div>
  );
}

// A small uppercase status pill mirroring the Pending-Payments pill language.
function PipelinePill({ label, tone }) {
  const c = tone === 'green' ? { color: '#15803D', bg: '#ECFDF3' }
    : tone === 'amber' ? { color: '#B45309', bg: '#FFFBEB' }
    : { color: '#0E7490', bg: '#ECFEFF' };
  return (
    <span style={{ fontSize: 9, fontWeight: 700, color: c.color, background: c.bg, padding: '1px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>
      {label}
    </span>
  );
}

// Sale-status pills for signed/paid deals: PO route (Pending PO → PO <number>),
// otherwise invoiced state.
function SaleStatusPills({ deal }) {
  const s = deal.saleStatus;
  if (!s || !['signed', 'paid'].includes(deal.stage)) return null;
  if (s.isPo) {
    return s.poReceivedAt
      ? <PipelinePill label={`PO ${s.poNumber || ''}`.trim()} tone="green" />
      : <PipelinePill label="Pending PO" tone="amber" />;
  }
  return s.invoiced ? <PipelinePill label="Invoiced" tone="green" /> : <PipelinePill label="Not invoiced" tone="amber" />;
}

function formatDuration(secs) {
  const s = Math.round(Number(secs) || 0);
  if (s <= 0) return null;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const shortDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// One channel's engagement eye (proposal OR email). Renders only when something
// was sent/linked on that channel: a green eye + last-opened time once opened, a
// faint eye while sent-but-unopened. Click toggles a details popover (portal so
// the row container's overflow:hidden can't clip it). `lines` are popover detail
// rows shown when opened.
function TrackingEyeChip({ icon: Icon, channel, sent, opened, lastOpenedAt, lines }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (btnRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return; setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    const close = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  if (!sent) return null;
  const colour = opened ? '#16A34A' : BRAND.muted;
  const toggle = (e) => {
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    const r = btnRef.current.getBoundingClientRect();
    const W = 220;
    setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8)) });
    setOpen(true);
  };
  return (
    <span style={{ display: 'inline-flex', flexShrink: 0 }}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title={`${channel} — ${opened && lastOpenedAt ? 'last opened ' + formatRelativeTime(lastOpenedAt) : 'not opened yet'}`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 2, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, color: colour }}
      >
        <Icon size={11} color={colour} />
        <Eye size={13} color={colour} fill={opened ? colour + '22' : 'none'} />
        {opened && lastOpenedAt && (
          <span style={{ fontSize: 10, fontWeight: 700, color: colour }}>{formatRelativeTime(lastOpenedAt).replace(' ago', '')}</span>
        )}
      </button>
      {open && pos && createPortal(
        <div ref={popRef} style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 1000, width: 220, padding: '10px 12px', background: 'white', textAlign: 'left', border: '1px solid ' + BRAND.border, borderRadius: 8, boxShadow: '0 8px 24px rgba(15,42,61,0.18)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 12.5, color: opened ? '#16A34A' : BRAND.ink }}>
            <Icon size={13} /> {channel}
          </div>
          {opened
            ? (lines || []).map((l, i) => <div key={i} style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 2 }}>{l}</div>)
            : <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 2 }}>Sent · not opened yet</div>}
        </div>,
        document.body,
      )}
    </span>
  );
}

function DealRow({ deal, onOpen }) {
  const { state } = useStore();
  const owner = deal.ownerEmail ? state.users[deal.ownerEmail] : null;
  const company = deal.companyId ? state.companies[deal.companyId] : null;
  const name = company?.name || deal.title || 'Untitled deal';
  const subtitle = company?.name && deal.title && deal.title !== company.name ? deal.title : null;
  const ageDays = daysSince(deal.stageChangedAt);

  const t = deal.tracking || {};
  const proposalSent = (deal.proposalCount || 0) > 0;
  const emailSent = !!deal.lastEmailAt;
  const spent = formatDuration(t.totalSeconds);
  const propLines = [
    t.proposalOpens > 0 ? `${t.proposalOpens} view${t.proposalOpens === 1 ? '' : 's'}` : null,
    t.lastProposalOpenAt ? `Last opened ${formatRelativeTime(t.lastProposalOpenAt)}` : null,
    (t.locations || []).length ? t.locations.slice(0, 3).join(', ') : null,
    spent ? `Time spent ${spent}` : null,
  ].filter(Boolean);
  const emailLines = [
    t.emailOpens > 0 ? `${t.emailOpens} open${t.emailOpens === 1 ? '' : 's'}` : null,
    t.lastEmailOpenAt ? `Last opened ${formatRelativeTime(t.lastEmailOpenAt)}` : null,
  ].filter(Boolean);

  const due = deal.nextTask?.dueAt ? new Date(deal.nextTask.dueAt) : null;
  const overdue = due && due.getTime() < Date.now();
  const lastEmail = deal.lastEmailAt ? new Date(deal.lastEmailAt) : null;
  const hasMeta = subtitle || deal.nextTask || lastEmail;

  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/json', JSON.stringify(deal))}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'white'; }}
      style={{ borderTop: '1px solid ' + BRAND.border, background: 'white', cursor: 'grab', padding: '8px 12px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {name}
          </span>
          <SaleStatusPills deal={deal} />
        </div>
        {/* Tracking eyes (proposal + email) sit on the right, next to the figure. */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <TrackingEyeChip icon={FileText} channel="Proposal" sent={proposalSent} opened={t.proposalOpens > 0} lastOpenedAt={t.lastProposalOpenAt} lines={propLines} />
          <TrackingEyeChip icon={Mail} channel="Emails" sent={emailSent} opened={t.emailOpens > 0} lastOpenedAt={t.lastEmailOpenAt} lines={emailLines} />
        </span>
        <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink, fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 64, textAlign: 'right' }}>
          {deal.value != null ? formatGBP(deal.value) : <span style={{ color: BRAND.muted, fontWeight: 400 }}>—</span>}
        </span>
        {ageDays != null && (
          <span style={{ fontSize: 10, color: ageDays > 14 ? '#92400E' : BRAND.muted, flexShrink: 0, minWidth: 22, textAlign: 'right' }} title={`${ageDays} days in stage`}>
            {ageDays}d
          </span>
        )}
        <Avatar user={owner} fallback={deal.ownerEmail} />
      </div>
      {hasMeta && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 3, fontSize: 11.5, color: BRAND.muted }}>
          {subtitle && <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}>{subtitle}</span>}
          {deal.nextTask && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: overdue ? '#B91C1C' : BRAND.muted, minWidth: 0 }} title="Next due task">
              <CheckSquare size={12} style={{ flexShrink: 0 }} />
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>
                {deal.nextTask.title}{due ? ` · ${shortDate(due)}` : ''}
              </span>
            </span>
          )}
          {lastEmail && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }} title="Date of last email">
              <Mail size={12} /> {shortDate(lastEmail)}
            </span>
          )}
        </div>
      )}
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

export function NewDealModal({ onClose, onCreated, initialTitle = '' }) {
  const { state, actions, showMsg } = useStore();
  const [title, setTitle] = useState(initialTitle);
  const [stage, setStage] = useState('lead');
  const [value, setValue] = useState('');
  const [xeroContact, setXeroContact] = useState(null);
  const [primaryContactId, setPrimaryContactId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const contacts = Object.values(state.contacts || {});

  // When a Xero contact is picked, auto-suggest the title if blank.
  function handleXeroPick(c) {
    setXeroContact(c);
    if (c && !title.trim()) setTitle(c.name);
  }

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      // Resolve picked Xero contact → local company (find or create + link).
      let companyId = null;
      if (xeroContact) {
        const company = await api.post('/api/crm/companies/from-xero-contact', {
          xeroContactId: xeroContact.id,
        });
        companyId = company.id;
      }
      const deal = await actions.createDeal({
        title: title.trim(),
        stage,
        value: value === '' ? null : Number(value),
        companyId,
        primaryContactId: primaryContactId || null,
      });
      onCreated?.(deal);
    } catch (err) {
      console.error('createDeal failed', err);
      showMsg?.('Failed to create deal: ' + (err?.message || 'unknown error'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>New deal</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Company (Xero contact, optional)
          <div style={{ marginTop: 4 }}>
            <XeroContactPicker value={xeroContact} onChange={handleXeroPick} placeholder="Search Xero contacts…" />
          </div>
        </label>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Title
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Acme Corp — Q2 explainer" style={{ marginTop: 4 }} required />
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
