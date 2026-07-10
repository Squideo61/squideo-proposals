import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, ChevronDown, Plus, KanbanSquare, Eye, Mail, FileText, CheckSquare, Flame } from 'lucide-react';
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

  // "Hot only" filter — show just the deals flagged warm/keen, regardless of
  // which stage they're in (the flag is orthogonal to the funnel position).
  const [hotOnly, setHotOnly] = useState(false);
  const allDeals = useMemo(() => Object.values(state.deals || {}), [state.deals]);
  const hotCount = useMemo(() => allDeals.filter(d => d.hot).length, [allDeals]);
  const deals = useMemo(() => {
    let list = ownerFilter ? allDeals.filter(d => d.ownerEmail === ownerFilter) : allDeals;
    if (hotOnly) list = list.filter(d => d.hot);
    return list;
  }, [allDeals, ownerFilter, hotOnly]);

  // Who can the pipeline be filtered by: anyone who can own a deal (sales,
  // directors, admins, members) — i.e. everyone except the production-only
  // roles (producers/copywriters), who never own deals. Plus anyone who
  // actually owns a deal, regardless of role, so no owner is ever hidden.
  const memberOptions = useMemo(() => {
    // Roles that never own deals — producers/copywriters/freelancers, and
    // marketers (they live in the marketing-only shell and can't own deals), so
    // they don't clutter the owner filter.
    const NON_OWNER_ROLES = new Set(['producer', 'copywriter', 'freelancer', 'marketing']);
    const map = new Map();
    for (const [email, u] of Object.entries(state.users || {})) {
      if (!NON_OWNER_ROLES.has(u.role)) map.set(email, u.name || email);
    }
    for (const d of allDeals) {
      const email = d.ownerEmail;
      if (email && !map.has(email)) map.set(email, state.users?.[email]?.name || email);
    }
    return Array.from(map, ([email, name]) => ({ email, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allDeals, state.users]);

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
          <button
            type="button"
            onClick={() => setHotOnly(v => !v)}
            className="btn-ghost"
            aria-pressed={hotOnly}
            title="Show only deals flagged hot"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13,
              color: hotOnly ? '#EA580C' : undefined, borderColor: hotOnly ? '#EA580C' : undefined,
              fontWeight: hotOnly ? 600 : undefined }}
          >
            <Flame size={14} fill={hotOnly ? '#EA580C' : 'none'} /> Hot{hotCount > 0 ? ` · ${hotCount}` : ''}
          </button>
          <span style={{ fontSize: 13, color: BRAND.muted }}>{deals.length} deals · all amounts ex-VAT (net)</span>
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
  // Column total mirrors the cards: prefer the proposal-derived (signed/proposed)
  // value, falling back to a manual deal value.
  const total = deals.reduce((s, d) => s + (Number(d.effectiveValue ?? d.value) || 0), 0);
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
  // A 50/50 deal with the deposit in but the balance outstanding reads clearer as
  // "Deposit paid" than the invoiced state (which looks fully settled).
  if (s.depositPaid) return <PipelinePill label="Deposit paid" tone="teal" />;
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

// Combined email pill: the last-email date and the open tracking in one chip
// (merges what used to be a separate "Last email" chip + email eye). Shows the
// envelope + date, and a green eye + last-open time once a tracked email's been
// opened. Click toggles a details popover (portal so the row can't clip it).
function EmailMetaPill({ lastEmailAt, opens, lastOpenedAt }) {
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
  if (!lastEmailAt) return null;
  const opened = (opens || 0) > 0;
  const eyeColour = opened ? '#16A34A' : BRAND.muted;
  const dt = new Date(lastEmailAt);
  const toggle = (e) => {
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    const r = btnRef.current.getBoundingClientRect();
    const W = 200;
    setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) });
    setOpen(true);
  };
  return (
    <span style={{ display: 'inline-flex', flexShrink: 0 }}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title={`Last email ${shortDate(dt)}${opened && lastOpenedAt ? ' · opened ' + formatRelativeTime(lastOpenedAt) : ''}`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap', flexShrink: 0, color: '#475569', background: '#F1F5F9', border: '1px solid ' + BRAND.border, cursor: 'pointer' }}
      >
        <Mail size={12} style={{ flexShrink: 0 }} />
        <span style={{ color: BRAND.muted, fontWeight: 500 }}>Last email</span>
        {shortDate(dt)}
        {opened && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 2, color: eyeColour, fontWeight: 700 }}>
            <Eye size={12} color={eyeColour} fill={eyeColour + '22'} />
            {lastOpenedAt ? formatRelativeTime(lastOpenedAt).replace(' ago', '') : ''}
          </span>
        )}
      </button>
      {open && pos && createPortal(
        <div ref={popRef} style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 1000, width: 200, padding: '10px 12px', background: 'white', textAlign: 'left', border: '1px solid ' + BRAND.border, borderRadius: 8, boxShadow: '0 8px 24px rgba(15,42,61,0.18)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 12.5, color: BRAND.ink }}>
            <Mail size={13} /> Emails
          </div>
          <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 3 }}>Last email {shortDate(dt)}</div>
          {opened ? (
            <>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: '#16A34A', marginTop: 4 }}>{opens} open{opens === 1 ? '' : 's'}</div>
              {lastOpenedAt && <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 2 }}>Last opened {formatRelativeTime(lastOpenedAt)}</div>}
            </>
          ) : (
            <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 4 }}>Not opened yet</div>
          )}
        </div>,
        document.body,
      )}
    </span>
  );
}

function DealRow({ deal, onOpen }) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();
  const owner = deal.ownerEmail ? state.users[deal.ownerEmail] : null;
  const company = deal.companyId ? state.companies[deal.companyId] : null;
  const name = company?.name || deal.title || 'Untitled deal';
  const ageDays = daysSince(deal.stageChangedAt);
  // Value shown: signed/proposed value derived by the backend, else the manual
  // value. So a deal with a proposal shows a figure even before it's signed.
  const shownValue = deal.effectiveValue != null ? deal.effectiveValue : deal.value;
  // Next task derived live from the loaded task list (which holds every open
  // task across deals), so a just-created follow-up shows immediately without a
  // deals reload. Falls back to the backend snapshot if tasks aren't loaded.
  const nextTask = useMemo(() => {
    const open = (state.tasks || []).filter(t => t.dealId === deal.id && !t.doneAt);
    if (!open.length) return deal.nextTask || null;
    const dueMs = (t) => (t.dueAt ? new Date(t.dueAt).getTime() : Infinity);
    const best = open.reduce((b, t) => (b && dueMs(b) <= dueMs(t) ? b : t), null);
    return best ? { title: best.title, dueAt: best.dueAt || null } : (deal.nextTask || null);
  }, [state.tasks, deal.id, deal.nextTask]);

  const t = deal.tracking || {};
  const proposalSent = (deal.proposalCount || 0) > 0;
  const spent = formatDuration(t.totalSeconds);
  const propLines = [
    t.proposalOpens > 0 ? `${t.proposalOpens} view${t.proposalOpens === 1 ? '' : 's'}` : null,
    t.lastProposalOpenAt ? `Last opened ${formatRelativeTime(t.lastProposalOpenAt)}` : null,
    (t.locations || []).length ? t.locations.slice(0, 3).join(', ') : null,
    spent ? `Time spent ${spent}` : null,
  ].filter(Boolean);

  const due = nextTask?.dueAt ? new Date(nextTask.dueAt) : null;
  // Compare on calendar day, so a task dated today never counts as overdue and
  // gets its own "due today" highlight instead.
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dueToday = due && due.getFullYear() === now.getFullYear() && due.getMonth() === now.getMonth() && due.getDate() === now.getDate();
  const overdue = due && due.getTime() < startOfToday;
  // Pill colours: overdue = red, due today = amber (stands out), else neutral.
  const taskColor = overdue ? '#B91C1C' : dueToday ? '#B45309' : '#475569';
  const taskBg = overdue ? '#FEF2F2' : dueToday ? '#FFFBEB' : '#F1F5F9';
  const taskBorder = overdue ? '#FECACA' : dueToday ? '#FDE68A' : BRAND.border;
  const lastEmail = deal.lastEmailAt ? new Date(deal.lastEmailAt) : null;

  const hotBtn = (
    <button
      type="button"
      draggable={false}
      onClick={(e) => { e.stopPropagation(); actions.toggleDealHot(deal.id, !deal.hot); }}
      title={deal.hot ? 'Flagged hot — click to unflag' : 'Flag as hot'}
      aria-pressed={!!deal.hot}
      style={{ display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none',
        cursor: 'pointer', padding: 0, flexShrink: 0,
        color: deal.hot ? '#EA580C' : BRAND.muted, opacity: deal.hot ? 1 : 0.4 }}
    >
      <Flame size={15} fill={deal.hot ? '#EA580C' : 'none'} />
    </button>
  );

  // On a phone the desktop's single dense line (name + pills + eye + value + age
  // + avatar) collides into an unreadable smear. Mobile stacks it: title + value
  // on top, the meta chips (status, next task, last email, proposal eye) wrap on
  // a second line with the age + owner pinned to the right.
  if (isMobile) {
    return (
      <div
        draggable
        onDragStart={(e) => e.dataTransfer.setData('application/json', JSON.stringify(deal))}
        onClick={onOpen}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
        style={{ borderTop: '1px solid ' + BRAND.border, background: 'white', cursor: 'pointer', padding: '11px 12px' }}
      >
        {/* Row 1 keeps the owner avatar + age pinned top-right on every card, so
            they never drop onto their own line when the pills below wrap — that
            floating was what made cards look randomly different heights. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {hotBtn}
          <span style={{ fontSize: 14, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>
            {name}
          </span>
          <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            {shownValue != null ? formatGBP(shownValue) : <span style={{ color: BRAND.muted, fontWeight: 400 }}>—</span>}
          </span>
          {ageDays != null && (
            <span style={{ fontSize: 10, color: ageDays > 14 ? '#92400E' : BRAND.muted, flexShrink: 0 }} title={`${ageDays} days in stage`}>{ageDays}d</span>
          )}
          <Avatar user={owner} fallback={deal.ownerEmail} />
        </div>
        {/* Row 2: meta chips. Only rendered when there's at least one, so cards
            with no chips stay short instead of carrying an empty gap. */}
        {((deal.saleStatus && ['signed', 'paid'].includes(deal.stage)) || nextTask || deal.lastEmailAt || proposalSent) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <SaleStatusPills deal={deal} />
            {nextTask && (
              <span
                title={`Next due task: ${nextTask.title}${due ? ' · ' + shortDate(due) : ''}${dueToday ? ' (today)' : ''}`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
                  color: taskColor,
                  background: taskBg,
                  border: '1px solid ' + taskBorder }}
              >
                <CheckSquare size={12} style={{ flexShrink: 0 }} />
                <span style={{ color: BRAND.muted, fontWeight: 500 }}>Next task</span>
                {due && <span>· {shortDate(due)}</span>}
              </span>
            )}
            <EmailMetaPill lastEmailAt={deal.lastEmailAt} opens={t.emailOpens || 0} lastOpenedAt={t.lastEmailOpenAt} />
            <TrackingEyeChip icon={FileText} channel="Proposal" sent={proposalSent} opened={t.proposalOpens > 0} lastOpenedAt={t.lastProposalOpenAt} lines={propLines} />
          </div>
        )}
      </div>
    );
  }

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
          <button
            type="button"
            draggable={false}
            onClick={(e) => { e.stopPropagation(); actions.toggleDealHot(deal.id, !deal.hot); }}
            title={deal.hot ? 'Flagged hot — click to unflag' : 'Flag as hot'}
            aria-pressed={!!deal.hot}
            style={{ display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none',
              cursor: 'pointer', padding: 0, flexShrink: 0,
              color: deal.hot ? '#EA580C' : BRAND.muted, opacity: deal.hot ? 1 : 0.4 }}
          >
            <Flame size={14} fill={deal.hot ? '#EA580C' : 'none'} />
          </button>
          <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 }}>
            {name}
          </span>
          <SaleStatusPills deal={deal} />
          {/* Next due task + last-email date inline with the title, each as its own
              distinct chip so it's obvious what they are and where one ends. */}
          {(nextTask || lastEmail) && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 2, minWidth: 0 }}>
              {nextTask && (
                <span
                  title={`Next due task: ${nextTask.title}${due ? ' · ' + shortDate(due) : ''}${dueToday ? ' (today)' : ''}`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap', flexShrink: 0,
                    color: taskColor,
                    background: taskBg,
                    border: '1px solid ' + taskBorder }}
                >
                  <CheckSquare size={12} style={{ flexShrink: 0 }} />
                  <span style={{ color: BRAND.muted, fontWeight: 500, flexShrink: 0 }}>Next task</span>
                  {due && <span style={{ flexShrink: 0 }}>· {shortDate(due)}</span>}
                </span>
              )}
              {/* Single combined email pill (last email date + open tracking). */}
              <EmailMetaPill lastEmailAt={deal.lastEmailAt} opens={t.emailOpens || 0} lastOpenedAt={t.lastEmailOpenAt} />
            </span>
          )}
        </div>
        {/* Proposal engagement eye sits on the right, next to the figure. */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <TrackingEyeChip icon={FileText} channel="Proposal" sent={proposalSent} opened={t.proposalOpens > 0} lastOpenedAt={t.lastProposalOpenAt} lines={propLines} />
        </span>
        <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink, fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 64, textAlign: 'right' }}>
          {shownValue != null ? formatGBP(shownValue) : <span style={{ color: BRAND.muted, fontWeight: 400 }}>—</span>}
        </span>
        {ageDays != null && (
          <span style={{ fontSize: 10, color: ageDays > 14 ? '#92400E' : BRAND.muted, flexShrink: 0, minWidth: 22, textAlign: 'right' }} title={`${ageDays} days in stage`}>
            {ageDays}d
          </span>
        )}
        <Avatar user={owner} fallback={deal.ownerEmail} />
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

export function NewDealModal({ onClose, onCreated, initialTitle = '' }) {
  const { state, actions, showMsg } = useStore();
  const [title, setTitle] = useState(initialTitle);
  const [stage, setStage] = useState('lead');
  const [value, setValue] = useState('');
  const [vatPct, setVatPct] = useState('20');
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
        vatRate: vatPct === '' ? null : Number(vatPct) / 100,
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
    <Modal onClose={onClose} fullScreenOnMobile>
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
        <div style={{ display: 'flex', gap: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 500, flex: 2 }}>
            Value (£, ex VAT, optional)
            <input className="input" type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} style={{ marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>
            VAT rate (%)
            <input className="input" type="number" min="0" max="100" step="0.1" value={vatPct} onChange={(e) => setVatPct(e.target.value)} style={{ marginTop: 4 }} />
          </label>
        </div>
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
