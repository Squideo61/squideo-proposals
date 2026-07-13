import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Trash2, Check, X, AlertTriangle, Plane, LayoutGrid, CheckCircle2, Gauge, RefreshCw, Undo2, Clock } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { Modal, ResponsiveTable, Badge, Section, Field } from '../ui.jsx';
import {
  weekStart, addDays, addWorkingDays, workingDaysBetween, countWorkingDays, fmtDayLabel,
  todayStr, blockColors, parseDate, fmtDate, isWeekend,
} from '../../lib/scheduleCalendar.js';

const KIND_LABEL = { storyboard: 'Storyboard / Visuals', production: 'Production' };

// Small square icon button used in the rota column headers (↻ update, ↺ undo).
const iconBtn = (busy) => ({
  flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 24, height: 24, padding: 0, border: '1px solid ' + BRAND.border, borderRadius: 6,
  background: 'white', color: BRAND.muted, cursor: busy ? 'default' : 'pointer',
});

// ── Half-day leave ──
// A half day is a single date taken as a morning or an afternoon; it counts 0.5
// against the allowance and leaves the producer on the rota for the other half.
const HALF_LABEL = { am: 'Morning', pm: 'Afternoon' };
const HALF_SHORT = { am: 'AM', pm: 'PM' };
// "0.5d (AM)" / "3d" — for the leave lists.
function leaveDaysLabel(l) {
  return l.halfDay ? `½ day · ${HALF_SHORT[l.halfPeriod] || 'AM'}` : `${l.days}d`;
}

function initials(name, email) {
  const src = (name || email || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}
// Producer's profile picture, falling back to their initials in a coloured disc.
function ProducerAvatar({ producer, size = 26 }) {
  const label = producer.name || producer.email;
  const common = {
    width: size, height: size, borderRadius: '50%', flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  };
  if (producer.avatar) {
    return <img src={producer.avatar} alt={label} title={label}
      style={{ ...common, objectFit: 'cover' }} />;
  }
  return (
    <span title={label} style={{ ...common, background: BRAND.blue, color: 'white', fontSize: Math.round(size * 0.42), fontWeight: 700 }}>
      {initials(producer.name, producer.email)}
    </span>
  );
}
function addMonths(dateStr, n) {
  const d = parseDate(dateStr);
  return fmtDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)));
}
// Same calendar day, n months on (used for rolling capacity windows). JS rolls
// day overflow forward (e.g. 31 Jan +1mo → 3 Mar), which is fine for a window edge.
function addMonthsSameDay(dateStr, n) {
  const d = parseDate(dateStr);
  return fmtDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate())));
}
// Full month grid (Mon-start weeks) covering the month of `cursor`.
function monthCells(cursor) {
  const d = parseDate(cursor);
  const mon = d.getUTCMonth();
  const first = fmtDate(new Date(Date.UTC(d.getUTCFullYear(), mon, 1)));
  const last = fmtDate(new Date(Date.UTC(d.getUTCFullYear(), mon + 1, 0)));
  const stop = addDays(weekStart(last), 7);
  const cells = [];
  let cur = weekStart(first);
  while (cur < stop) {
    cells.push({ day: cur, inMonth: parseDate(cur).getUTCMonth() === mon });
    cur = addDays(cur, 1);
  }
  return cells;
}

export function ScheduleView({ onOpenProject, onOpenVideo }) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();
  const sched = state.schedule || {};
  const [cursor, setCursor] = useState(() => todayStr());
  const [viewMode, setViewMode] = useState('week'); // 'week' | 'month'
  const [selected, setSelected] = useState('master'); // 'master' | producer email
  const [leaveModal, setLeaveModal] = useState(false);
  const [blockModal, setBlockModal] = useState(null);
  const [newBlock, setNewBlock] = useState(false);
  const [allowanceModal, setAllowanceModal] = useState(null);
  const [reflowing, setReflowing] = useState(null); // null | 'all' | producer email

  useEffect(() => { actions.loadSchedule(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Freelancers are external contractors — annual leave / allowance don't apply
  // to them, so hide the whole leave apparatus on their own view.
  const isFreelancer = state.session?.role === 'freelancer';
  const canManage = !!sched.canManage;
  // Anyone who can manage the rota can review + approve leave (matches the
  // server rule). Deriving it from canManage too means the Review button can't
  // be hidden by an older payload that only sends canApproveLeave.
  const canApprove = !!sched.canApproveLeave || canManage;
  const canManageAllowance = !!sched.canManageAllowance;
  const me = sched.me || (state.session?.email || '').toLowerCase();
  const allProducers = sched.producers && sched.producers.length
    ? sched.producers
    : [{ email: me, name: state.session?.name || me, avatar: null }];
  // Non-managers only ever see themselves; managers switch between staff + Master.
  const effectiveSelected = canManage ? selected : me;
  let visibleProducers = effectiveSelected === 'master'
    ? allProducers
    : allProducers.filter(p => p.email === effectiveSelected);
  if (!visibleProducers.length) visibleProducers = allProducers;
  const single = visibleProducers.length === 1;

  const weekMonday = weekStart(cursor);
  const weekDays = [0, 1, 2, 3, 4].map(i => addWorkingDays(weekMonday, i));
  const cells = viewMode === 'month' ? monthCells(cursor) : [];
  const today = todayStr();

  const { asgByCell, leaveByCell } = useMemo(() => {
    const a = new Map(), l = new Map();
    for (const as of sched.assignments || []) {
      for (const d of workingDaysBetween(as.startDate, as.endDate)) a.set(as.userEmail + '|' + d, as);
    }
    for (const lv of sched.leave || []) {
      if (lv.status === 'denied') continue;
      for (const d of workingDaysBetween(lv.startDate, lv.endDate)) l.set(lv.userEmail + '|' + d, lv);
    }
    return { asgByCell: a, leaveByCell: l };
  }, [sched.assignments, sched.leave]);

  const conflicts = (sched.assignments || []).filter(a =>
    (canManage || a.userEmail === me) && (a.conflict || a.leaveConflict));

  const periodLabel = viewMode === 'week'
    ? `${fmtDayLabel(weekDays[0], { weekday: undefined })} – ${fmtDayLabel(weekDays[4], { weekday: undefined })}`
    : parseDate(cursor).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shift = (dir) => setCursor(c => viewMode === 'week' ? addDays(c, dir * 7) : addMonths(c, dir));

  // Left/right arrow keys page the calendar back/forward a week (or month in
  // month view) — ignored while typing in a field or when a modal is open.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (leaveModal || blockModal || newBlock || allowanceModal) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      shift(e.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewMode, leaveModal, blockModal, newBlock, allowanceModal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reflow one producer's rota, or the whole roster when `userEmail` is null.
  const runReflow = async (userEmail) => {
    const who = userEmail
      ? (allProducers.find(p => p.email === userEmail)?.name || userEmail)
      : null;
    const msg = userEmail
      ? `Update ${who}’s rota?\n\nProjects the client hasn’t come back on (due within 24 hours but not ready) will be pushed back — visuals and their production together — and the next ready job brought forward to fill the slot.`
      : 'Update the whole rota?\n\nFor every producer, projects the client hasn’t come back on (due within 24 hours but not ready) will be pushed back — visuals and their production together — and the next ready job brought forward to fill the slot.';
    if (!window.confirm(msg)) return;
    setReflowing(userEmail || 'all');
    try { await actions.reflowSchedule(userEmail); } finally { setReflowing(null); }
  };
  // Put the rota back exactly as it was before the last Update rota press.
  const undoPoint = sched.undo || null;
  const runUndo = async () => {
    if (!window.confirm('Undo the last rota update?\n\nEvery block it moved goes back to where it was.')) return;
    setReflowing('undo');
    try { await actions.undoReflow(); } finally { setReflowing(null); }
  };

  const onDropCell = (producerEmail, day, e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    if (!id) return;
    actions.moveAssignment(id, { startDate: day, userEmail: producerEmail });
  };

  const tabBtn = (key, label) => (
    <button key={key} onClick={() => setSelected(key)} className="btn-ghost"
      style={{ borderRadius: 999, fontWeight: 600, whiteSpace: 'nowrap',
        background: effectiveSelected === key ? BRAND.blue : 'white',
        color: effectiveSelected === key ? 'white' : BRAND.ink,
        border: '1px solid ' + (effectiveSelected === key ? BRAND.blue : BRAND.border) }}>
      {label}
    </button>
  );

  return (
    <div style={{ padding: isMobile ? '14px 12px 40px' : '20px 24px 60px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: isMobile ? 20 : 26, fontWeight: 800, margin: 0 }}>
          <CalendarDays size={isMobile ? 22 : 28} color={BRAND.blue} /> Staff Production Rota
        </h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden' }}>
            {['week', 'month'].map(m => (
              <button key={m} onClick={() => setViewMode(m)} className="btn-ghost"
                style={{ border: 'none', borderRadius: 0, fontWeight: 600, textTransform: 'capitalize', background: viewMode === m ? BRAND.blue : 'white', color: viewMode === m ? 'white' : BRAND.ink }}>
                {m}
              </button>
            ))}
          </div>
          {canManage && (
            <button className="btn-ghost" disabled={!!reflowing}
              title="Push client-delayed work back and pull ready work forward across every producer's rota"
              onClick={() => runReflow(null)}
              style={{ fontWeight: 600 }}>
              <RefreshCw size={14} style={reflowing === 'all' ? { animation: 'spin 0.8s linear infinite' } : undefined} /> {reflowing === 'all' ? 'Updating…' : 'Update rota'}
            </button>
          )}
          {canManage && undoPoint && (
            <button className="btn-ghost" disabled={!!reflowing} onClick={runUndo}
              title={`Undo the last rota update (${undoPoint.scope === 'all' ? 'all producers' : (allProducers.find(p => p.email === undoPoint.scope)?.name || undoPoint.scope)}) — ${undoPoint.blocks} block${undoPoint.blocks === 1 ? '' : 's'}`}
              style={{ fontWeight: 600 }}>
              <Undo2 size={14} /> {reflowing === 'undo' ? 'Undoing…' : 'Undo'}
            </button>
          )}
          {canManage && (
            <button className="btn" onClick={() => setNewBlock(true)} style={{ fontWeight: 600 }}>
              <Plus size={14} /> Add block
            </button>
          )}
          {!isFreelancer && (
            <button className="btn-ghost" onClick={() => setLeaveModal(true)} style={{ fontWeight: 600 }}>
              <Plane size={14} /> Book leave
            </button>
          )}
        </div>
      </div>

      {/* Producer switcher (managers) */}
      {canManage && allProducers.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, overflowX: 'auto', paddingBottom: 4 }}>
          {allProducers.map(p => tabBtn(p.email, p.name || p.email))}
          <div style={{ width: 1, background: BRAND.border, margin: '2px 2px' }} />
          <button onClick={() => setSelected('master')} className="btn-ghost"
            style={{ borderRadius: 999, fontWeight: 700, whiteSpace: 'nowrap',
              background: effectiveSelected === 'master' ? BRAND.ink : 'white',
              color: effectiveSelected === 'master' ? 'white' : BRAND.ink,
              border: '1px solid ' + (effectiveSelected === 'master' ? BRAND.ink : BRAND.border) }}>
            <LayoutGrid size={14} /> Master
          </button>
        </div>
      )}

      {/* Period nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button className="btn-ghost" onClick={() => shift(-1)} aria-label="Previous"><ChevronLeft size={16} /></button>
        <button className="btn-ghost" onClick={() => setCursor(todayStr())} style={{ fontWeight: 600 }}>Today</button>
        <button className="btn-ghost" onClick={() => shift(1)} aria-label="Next"><ChevronRight size={16} /></button>
        <span style={{ fontWeight: 700, color: BRAND.ink }}>{periodLabel}</span>
      </div>

      {conflicts.length > 0 && (
        <div style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 10, padding: '12px 14px', marginBottom: 16, display: 'flex', gap: 10 }}>
          <AlertTriangle size={18} color="#DC2626" style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 13, color: '#7F1D1D' }}>
            <strong>{conflicts.length} scheduling clash{conflicts.length === 1 ? '' : 'es'} need review.</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {conflicts.slice(0, 6).map(c => (
                <li key={c.id}>{c.projectTitle} — {c.videoTitle} ({KIND_LABEL[c.kind] || c.kind}): {c.leaveConflict ? 'clashes with booked annual leave' : c.conflictReason}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {canManage && <CapacityBar sched={sched} />}

      {/* Calendar */}
      {viewMode === 'month'
        ? (isMobile
            ? <AgendaList days={cells.filter(c => c.inMonth && !isWeekend(c.day)).map(c => c.day)} producers={visibleProducers} asgByCell={asgByCell} leaveByCell={leaveByCell} today={today} onBlock={setBlockModal} />
            : <MonthGrid cells={cells} producers={visibleProducers} single={single} asgByCell={asgByCell} leaveByCell={leaveByCell} today={today} canManage={canManage} me={me} onBlock={setBlockModal} onDropCell={onDropCell} />)
        : (isMobile
            ? <AgendaList days={weekDays} producers={visibleProducers} asgByCell={asgByCell} leaveByCell={leaveByCell} today={today} onBlock={setBlockModal} />
            : <CalendarGrid weekDays={weekDays} producers={visibleProducers} asgByCell={asgByCell} leaveByCell={leaveByCell}
                today={today} canManage={canManage} me={me} onBlock={setBlockModal} onDropCell={onDropCell}
                onReflow={runReflow} onUndo={runUndo} undoPoint={undoPoint} reflowing={reflowing} />)}

      {/* Leave requests + allowances + amends. Annual leave / allowance don't
          apply to freelancers, so they only see their Amends to do. */}
      <div style={{ marginTop: 28 }}>
        {!isFreelancer && <LeavePanel sched={sched} canManage={canManage} canApprove={canApprove} me={me} actions={actions} />}
        {!isFreelancer && <AllowancePanel sched={sched} canManage={canManage} canManageAllowance={canManageAllowance} me={me} onEdit={setAllowanceModal} />}
        <AmendsPanel sched={sched} onOpenVideo={onOpenVideo} showProducer={canManage} selected={effectiveSelected} />
      </div>

      {newBlock && <NewBlockModal producers={allProducers} onClose={() => setNewBlock(false)}
        onSubmit={(f) => actions.createBlock(f).then(() => setNewBlock(false))} />}
      {leaveModal && <LeaveModal producers={allProducers} canManage={canManage} sched={sched} me={me} onClose={() => setLeaveModal(false)}
        onSubmit={(f) => actions.requestLeave(f).then(() => setLeaveModal(false))} />}
      {blockModal && <BlockModal assignment={blockModal} producers={allProducers} canManage={canManage} me={me}
        onOpenProject={onOpenProject} onOpenVideo={onOpenVideo}
        onClose={() => setBlockModal(null)} actions={actions} />}
      {allowanceModal && <AllowanceModal row={allowanceModal} onClose={() => setAllowanceModal(null)}
        onSave={(f) => actions.updateAllowance(allowanceModal.userEmail, f).then(() => setAllowanceModal(null))} />}
    </div>
  );
}

// ── Rota capacity summary ──
// A quick read on the whole rota: how many projects are ready to work on now,
// how many are delayed (schedule/leave clash), and how full every producer's
// diary is over the next month and next three months.
function CapacityBar({ sched }) {
  // Freelancers are additional, separately-sourced capacity — exclude them from
  // the rota's utilisation figures (both the denominator and their booked days).
  const rosterEmails = (sched.producers || []).filter(p => !p.isFreelancer).map(p => p.email);
  const assignments = sched.assignments || [];
  const stats = useMemo(() => {
    const today = todayStr();
    const roster = new Set(rosterEmails);
    const ready = new Set(), delayed = new Set();
    for (const a of assignments) {
      const key = a.dealId || a.id;
      if (a.conflict || a.leaveConflict) delayed.add(key);
      else if (!a.manual && a.ready && a.endDate >= today) ready.add(key);
    }
    const capacity = (months) => {
      const end = addDays(addMonthsSameDay(today, months), -1);
      const windowDays = new Set(workingDaysBetween(today, end));
      const denom = rosterEmails.length * windowDays.size;
      if (!denom) return { pct: 0, used: 0, capacity: denom };
      const perUser = new Map();
      for (const a of assignments) {
        if (!roster.has(a.userEmail)) continue;
        let s = perUser.get(a.userEmail);
        if (!s) { s = new Set(); perUser.set(a.userEmail, s); }
        for (const d of workingDaysBetween(a.startDate, a.endDate)) if (windowDays.has(d)) s.add(d);
      }
      let used = 0; for (const s of perUser.values()) used += s.size;
      return { pct: Math.round((used / denom) * 100), used, capacity: denom };
    };
    return { ready: ready.size, delayed: delayed.size, m1: capacity(1), m3: capacity(3) };
  }, [assignments, rosterEmails.join(','), sched.leave]);

  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 16 }}>
      <StatTile icon={CheckCircle2} color="#16A34A" label="Ready for work" value={stats.ready}
        sub={`project${stats.ready === 1 ? '' : 's'} ready to start`} />
      <StatTile icon={AlertTriangle} color="#DC2626" label="Delayed" value={stats.delayed}
        sub={`project${stats.delayed === 1 ? '' : 's'} with a clash`} />
      <MeterTile label="Capacity · next month" meter={stats.m1} />
      <MeterTile label="Capacity · next 3 months" meter={stats.m3} />
    </div>
  );
}

function StatTile({ icon: Icon, color, label, value, sub }) {
  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 12, background: 'white', padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        <Icon size={14} color={color} /> {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color: BRAND.ink, lineHeight: 1.1, marginTop: 6 }}>{value}</div>
      <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>{sub}</div>
    </div>
  );
}

// A utilisation meter. Green when there's slack, amber when busy, red when full.
function MeterTile({ label, meter }) {
  const pct = Math.min(100, meter.pct);
  const color = pct >= 95 ? '#DC2626' : pct >= 80 ? '#D97706' : '#16A34A';
  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 12, background: 'white', padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        <Gauge size={14} color={color} /> {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color: BRAND.ink, lineHeight: 1.1, marginTop: 6 }}>{meter.pct}%</div>
      <div style={{ height: 7, borderRadius: 999, background: '#EEF2F6', overflow: 'hidden', marginTop: 8 }}>
        <div style={{ width: pct + '%', height: '100%', background: color, borderRadius: 999 }} />
      </div>
      <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 6 }}>{meter.used} of {meter.capacity} producer-days booked</div>
    </div>
  );
}

// ── Month grid: 7-day weeks; each cell lists blocks for the visible producers ──
function MonthGrid({ cells, producers, single, asgByCell, leaveByCell, today, canManage, me, onBlock, onDropCell }) {
  const head = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 12, background: 'white', overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
        {head.map(w => (
          <div key={w} style={{ padding: '8px 10px', background: BRAND.paper, borderBottom: '1px solid ' + BRAND.border, fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>{w}</div>
        ))}
        {cells.map(({ day, inMonth }) => {
          const weekend = isWeekend(day);
          const dropOk = single && inMonth && !weekend;
          return (
            <div key={day}
              onDragOver={dropOk ? (e) => e.preventDefault() : undefined}
              onDrop={dropOk ? (e) => onDropCell(producers[0].email, day, e) : undefined}
              style={{ minHeight: 84, padding: 4, borderTop: '1px solid ' + BRAND.paper, borderLeft: '1px solid ' + BRAND.paper,
                background: day === today ? '#EFF6FF' : weekend ? '#FAFBFC' : 'white', opacity: inMonth ? 1 : 0.45 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: day === today ? BRAND.blue : BRAND.muted, marginBottom: 2 }}>{parseDate(day).getUTCDate()}</div>
              {producers.map(p => {
                const asg = asgByCell.get(p.email + '|' + day);
                const leave = leaveByCell.get(p.email + '|' + day);
                if (!asg && !leave) return null;
                const prefix = single ? '' : initials(p.name, p.email) + ' · ';
                return (
                  <React.Fragment key={p.email}>
                    {leave && <MiniChip label={prefix + (leave.halfDay ? `½ Leave · ${HALF_SHORT[leave.halfPeriod] || 'AM'}` : 'Leave')} leave />}
                    {asg && <MiniChip label={prefix + asg.projectTitle} asg={asg} onClick={() => onBlock(asg)} draggable={dropOk && (canManage || asg.userEmail === me)} />}
                  </React.Fragment>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MiniChip({ label, asg, leave, onClick, draggable }) {
  const c = asg ? blockColors(asg) : { bg: '#FEF3C7', fg: '#92400E', border: '#FCD34D' };
  return (
    <div draggable={draggable}
      onDragStart={draggable ? (e) => e.dataTransfer.setData('text/plain', asg.id) : undefined}
      onClick={onClick}
      title={label}
      style={{ background: c.bg, color: c.fg, border: '1px solid ' + c.border, borderRadius: 6, padding: '2px 5px', fontSize: 10, fontWeight: 600, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: onClick ? 'pointer' : 'default' }}>
      {label}{asg && (asg.conflict || asg.leaveConflict) ? ' ⚠' : ''}
    </div>
  );
}

// ── Desktop grid: rows = weekdays, columns = producers ──
function CalendarGrid({ weekDays, producers, asgByCell, leaveByCell, today, canManage, me, onBlock, onDropCell, onReflow, onUndo, undoPoint, reflowing }) {
  const colW = `minmax(150px, 1fr)`;
  return (
    <div style={{ overflowX: 'auto', border: '1px solid ' + BRAND.border, borderRadius: 12, background: 'white' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `110px repeat(${producers.length}, ${colW})`, minWidth: 110 + producers.length * 150 }}>
        {/* header */}
        <div style={{ borderBottom: '1px solid ' + BRAND.border, background: BRAND.paper }} />
        {producers.map(p => (
          <div key={p.email} style={{ padding: '10px 12px', borderBottom: '1px solid ' + BRAND.border, borderLeft: '1px solid ' + BRAND.paper, background: BRAND.paper, display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13 }}>
            <ProducerAvatar producer={p} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name || p.email}</span>
            {canManage && onReflow && (
              <span style={{ marginLeft: 'auto', flexShrink: 0, display: 'inline-flex', gap: 4 }}>
                {/* Undo only appears on the producer whose rota was last updated —
                    you can only ever revert the most recent press. */}
                {undoPoint && undoPoint.scope === p.email && (
                  <button onClick={onUndo} disabled={!!reflowing}
                    title={`Undo the last update to ${p.name || p.email}'s rota (${undoPoint.blocks} block${undoPoint.blocks === 1 ? '' : 's'})`}
                    style={iconBtn(reflowing)}>
                    <Undo2 size={13} />
                  </button>
                )}
                <button onClick={() => onReflow(p.email)} disabled={!!reflowing}
                  title={`Update ${p.name || p.email}'s rota — push client-delayed work back, pull ready work forward`}
                  style={iconBtn(reflowing)}>
                  <RefreshCw size={13} style={reflowing === p.email ? { animation: 'spin 0.8s linear infinite' } : undefined} />
                </button>
              </span>
            )}
          </div>
        ))}
        {/* rows */}
        {weekDays.map(day => (
          <React.Fragment key={day}>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid ' + BRAND.paper, fontWeight: 600, fontSize: 12, color: day === today ? BRAND.blue : BRAND.muted, background: day === today ? '#EFF6FF' : 'white' }}>
              {fmtDayLabel(day)}
            </div>
            {producers.map(p => {
              const key = p.email + '|' + day;
              const asg = asgByCell.get(key);
              const leave = leaveByCell.get(key);
              const canDrag = asg && (canManage || asg.userEmail === me);
              return (
                <div key={key}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => onDropCell(p.email, day, e)}
                  style={{ minHeight: 54, padding: 6, borderBottom: '1px solid ' + BRAND.paper, borderLeft: '1px solid ' + BRAND.paper, background: day === today ? '#F8FBFF' : 'white' }}>
                  {leave && <LeaveChip leave={leave} />}
                  {asg && <BlockChip asg={asg} draggable={canDrag} onClick={() => onBlock(asg)} />}
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function BlockChip({ asg, draggable, onClick }) {
  const c = blockColors(asg);
  const dur = asg.durationDays + (asg.extendedDays || 0);
  return (
    <div
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData('text/plain', asg.id)}
      onClick={onClick}
      title={(asg.manual ? asg.projectTitle : `${asg.projectTitle} — ${asg.videoTitle} (${KIND_LABEL[asg.kind] || asg.kind})`)
        + (asg.clientDelayed ? '\nPushed back — the client wasn’t ready. Delivery dates aren’t flagged as a clash.' : '')}
      style={{ background: c.bg, color: c.fg, border: '1px solid ' + c.border, borderRadius: 8, padding: '6px 8px', cursor: 'pointer', fontSize: 12, lineHeight: 1.3 }}>
      <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asg.projectTitle}</div>
      {!asg.manual && (
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.9 }}>
          {asg.videoTitle}{asg.videoLength ? ' · ' + asg.videoLength : ''}
        </div>
      )}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 2, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3 }}>
        <span>{asg.manual ? `${dur}d` : `${asg.kind === 'storyboard' ? 'Visuals' : 'Production'} · ${dur}d`}</span>
        {/* Pushed back because the client wasn't ready — a delay, not a clash. */}
        {asg.clientDelayed && <Clock size={11} />}
        {(asg.conflict || asg.leaveConflict) && <AlertTriangle size={11} />}
      </div>
    </div>
  );
}

function LeaveChip({ leave }) {
  const approved = leave.status === 'approved';
  const base = approved ? 'Annual Leave' : 'Leave (pending)';
  // Half days sit on a day the producer still works, so they're drawn narrower
  // and tagged AM/PM to read differently from a whole day off.
  const label = leave.halfDay ? `½ ${base} · ${HALF_SHORT[leave.halfPeriod] || 'AM'}` : base;
  return (
    <div title={label} style={{ background: approved ? '#FEF3C7' : '#FDF2F8', color: approved ? '#92400E' : '#9D174D', border: '1px dashed ' + (approved ? '#FCD34D' : '#F9A8D4'), borderRadius: 8, padding: '4px 8px', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4, width: leave.halfDay ? '65%' : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      <Plane size={11} style={{ flexShrink: 0 }} /> {label}
    </div>
  );
}

// ── Mobile agenda ──
function AgendaList({ days, producers, asgByCell, leaveByCell, today, onBlock }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {days.map(day => {
        const items = producers.map(p => ({ p, asg: asgByCell.get(p.email + '|' + day), leave: leaveByCell.get(p.email + '|' + day) }))
          .filter(x => x.asg || x.leave);
        return (
          <div key={day} style={{ border: '1px solid ' + BRAND.border, borderRadius: 12, background: 'white', overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', background: day === today ? '#EFF6FF' : BRAND.paper, fontWeight: 700, fontSize: 13, color: day === today ? BRAND.blue : BRAND.ink }}>{fmtDayLabel(day, { weekday: 'long' })}</div>
            <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {items.length === 0 && <div style={{ color: BRAND.muted, fontSize: 13 }}>Nothing scheduled.</div>}
              {items.map(({ p, asg, leave }) => (
                <div key={p.email} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, width: 64, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name || p.email}</span>
                  <div style={{ flex: 1 }}>
                    {leave && <LeaveChip leave={leave} />}
                    {asg && <BlockChip asg={asg} draggable={false} onClick={() => onBlock(asg)} />}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Leave requests / bookings ──
function LeavePanel({ sched, canManage, canApprove, me, actions }) {
  const leave = sched.leave || [];
  const pending = leave.filter(l => l.status === 'pending');
  const [review, setReview] = useState(null);
  const nameFor = (email) => (sched.producers || []).find(p => p.email === email)?.name || email;
  // Approvers see pending requests in "Awaiting approval" above, so keep them out
  // of "Upcoming leave" to avoid showing each pending request twice.
  const upcoming = leave.filter(l => l.status !== 'denied' && l.endDate >= todayStr() && !(canApprove && l.status === 'pending'))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  return (
    <Section title="Annual leave" icon={Plane} color="#D97706">
      {!canApprove && pending.length > 0 && (
        <div style={{ background: '#FFFBEB', border: '1px solid #FCD34D', color: '#92400E', borderRadius: 10, padding: '10px 12px', fontSize: 13, marginBottom: 12, display: 'flex', gap: 8 }}>
          <Plane size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{pending.length} leave request{pending.length === 1 ? '' : 's'} awaiting approval — annual leave is reviewed and approved by an <strong>Admin or Director</strong>.</span>
        </div>
      )}
      {canApprove && (
        <>
          <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>Awaiting approval</div>
          {pending.length === 0 && <div style={{ color: BRAND.muted, fontSize: 13, marginBottom: 12 }}>No requests to approve.</div>}
          {pending.map(l => (
            <div key={l.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderBottom: '1px solid ' + BRAND.paper, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 14 }}>
                <strong>{nameFor(l.userEmail)}</strong> · {l.halfDay ? l.startDate : `${l.startDate} → ${l.endDate}`} · {leaveDaysLabel(l)}{l.note ? ' · ' + l.note : ''}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn" onClick={() => setReview(l)}><CalendarDays size={14} /> Review impact</button>
                <button className="btn-ghost" onClick={() => actions.decideLeave(l.id, 'denied')}><X size={14} /> Deny</button>
              </div>
            </div>
          ))}
        </>
      )}
      {review && <LeaveReviewModal leave={review} nameFor={nameFor} actions={actions} onClose={() => setReview(null)} />}
      <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, margin: '14px 0 8px' }}>Upcoming leave</div>
      {upcoming.length === 0 && <div style={{ color: BRAND.muted, fontSize: 13 }}>No upcoming leave booked.</div>}
      {upcoming.map(l => (
        <div key={l.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: '1px solid ' + BRAND.paper }}>
          <div style={{ fontSize: 14 }}>
            {canManage && <strong>{nameFor(l.userEmail)} · </strong>}{l.halfDay ? l.startDate : `${l.startDate} → ${l.endDate}`} · {leaveDaysLabel(l)}{' '}
            <Badge color={l.status === 'approved' ? 'green' : l.status === 'denied' ? 'grey' : 'yellow'}>{l.status}</Badge>
          </div>
          {(canManage || (l.userEmail === me && l.status === 'pending')) && (
            <button className="btn-ghost" onClick={() => actions.cancelLeave(l.id)} title="Cancel"><Trash2 size={14} /></button>
          )}
        </div>
      ))}
    </Section>
  );
}

// ── Allowance tracker ──
function AllowancePanel({ sched, canManage, canManageAllowance, me, onEdit }) {
  const all = (sched.allowances || []).filter(a => canManage || a.userEmail === me);
  const rows = all.filter(a => a.onRoster && a.trackAllowance);
  const untracked = all.filter(a => a.onRoster && !a.trackAllowance);
  const removed = all.filter(a => !a.onRoster);
  const columns = [
    { key: 'name', label: 'Team member', render: r => r.name },
    { key: 'annualAllowance', label: 'Allowance', align: 'right', render: r => r.annualAllowance },
    { key: 'compulsoryDays', label: 'Compulsory', align: 'right', render: r => r.compulsoryDays },
    { key: 'taken', label: 'Taken', align: 'right', render: r => r.taken },
    { key: 'remaining', label: 'Days left', align: 'right', render: r => (
      <span style={{ fontWeight: 700, color: r.remaining <= 0 ? '#DC2626' : r.remaining <= 3 ? '#D97706' : '#16A34A' }}>{r.remaining}</span>
    ) },
    { key: 'renewal', label: 'Renews', align: 'right', render: r => r.renewal },
  ];
  return (
    <Section title="Annual-leave allowance" icon={CalendarDays} color="#0EA5E9"
      badge={<span style={{ fontSize: 12, color: BRAND.muted }}>Default 20 days · 6 compulsory (Christmas)</span>}>
      <ResponsiveTable columns={columns} rows={rows} keyField="userEmail"
        onRowClick={canManageAllowance ? onEdit : undefined} empty="No one is tracked yet." />
      {canManageAllowance && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 8 }}>Tap a row to edit allowance, compulsory days, days used or the renewal date. Use it to remove someone, or to keep them on the schedule without tracking an allowance. Admins are hidden by default.</div>}
      {canManageAllowance && untracked.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed ' + BRAND.border }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>On the schedule · allowance not tracked</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {untracked.map(h => (
              <button key={h.userEmail} className="btn-ghost" onClick={() => onEdit(h)} style={{ fontSize: 12 }}>
                {h.name} · edit
              </button>
            ))}
          </div>
        </div>
      )}
      {canManageAllowance && removed.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed ' + BRAND.border }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Off the schedule</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {removed.map(h => (
              <button key={h.userEmail} className="btn-ghost" onClick={() => onEdit(h)} style={{ fontSize: 12 }}>
                {h.name} · add
              </button>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

// ── Amends to do ──
// Follows the producer switcher: on Master every row is prefixed with the
// assigned producer's profile picture; pick a producer and the list narrows to
// just the amends they're assigned to.
function AmendsPanel({ sched, onOpenVideo, showProducer, selected }) {
  const { state } = useStore();
  const all = sched.amends || [];
  // `selected` is 'master' (or falsy) for everyone, else a producer's email.
  const forProducer = selected && selected !== 'master' ? selected : null;
  const amends = forProducer
    ? all.filter(a => (a.producerEmails || []).includes(forProducer) || a.userEmail === forProducer)
    : all;
  // Prefer the rota roster (name + avatar), fall back to the user directory for
  // anyone off-roster.
  const lookup = (email) => {
    if (!email) return null;
    const fromRoster = (sched.producers || []).find(p => p.email === email);
    if (fromRoster) return fromRoster;
    const u = (state.users || {})[email];
    return { email, name: u?.name || email, avatar: u?.avatar || null };
  };
  const who = forProducer ? (lookup(forProducer)?.name || forProducer) : null;
  return (
    <Section title={who ? `Amends to do — ${who}` : 'Amends to do'} icon={AlertTriangle} color="#DC2626"
      badge={<span style={{ fontSize: 12, color: BRAND.muted }}>{amends.length} outstanding</span>}>
      {amends.length === 0 && (
        <div style={{ color: BRAND.muted, fontSize: 13 }}>
          {who ? `No amends outstanding for ${who}.` : 'No amends outstanding — nice.'}
        </div>
      )}
      {amends.map(a => {
        const producer = showProducer ? lookup(a.userEmail) : null;
        return (
          <div key={a.videoId} onClick={() => onOpenVideo && onOpenVideo(a.videoId)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 0', borderBottom: '1px solid ' + BRAND.paper, cursor: onOpenVideo ? 'pointer' : 'default' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 14 }}>
              {showProducer && (producer
                ? <ProducerAvatar producer={producer} size={22} />
                : <span title="No producer assigned" style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, background: BRAND.paper, border: '1px dashed ' + BRAND.border }} />)}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <strong>{a.projectTitle}</strong> — {a.videoTitle}
              </span>
            </div>
            <Badge color={a.kind === 'storyboard' ? 'orange' : 'blue'}>{a.kind === 'storyboard' ? 'Storyboard revisions' : 'Revisions'}</Badge>
          </div>
        );
      })}
    </Section>
  );
}

// ── Modals ──
function LeaveModal({ producers, canManage, sched, me, onClose, onSubmit }) {
  const [start, setStart] = useState(todayStr());
  const [end, setEnd] = useState(todayStr());
  const [halfDay, setHalfDay] = useState(false);
  const [halfPeriod, setHalfPeriod] = useState('am');
  const [note, setNote] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);

  // A half day is always a single date — the "To" field drops away.
  const effectiveEnd = halfDay ? start : (end || start);
  const daysRequested = halfDay ? 0.5 : countWorkingDays(start, effectiveEnd);

  // Warn the booker up-front if these dates land on work already booked for the
  // person taking leave. Computed from the loaded schedule — a producer sees
  // their own blocks, a manager sees whoever they're booking for.
  const forEmail = (canManage && target) ? target : me;
  const clashes = useMemo(() => {
    if (!start) return [];
    const days = new Set(workingDaysBetween(start, effectiveEnd));
    return (sched?.assignments || []).filter(a =>
      a.userEmail === forEmail &&
      workingDaysBetween(a.startDate, a.endDate).some(d => days.has(d)));
  }, [start, effectiveEnd, forEmail, sched?.assignments]);

  const submit = () => {
    if (!start) return;
    setBusy(true);
    onSubmit({
      startDate: start,
      endDate: effectiveEnd,
      halfDay,
      ...(halfDay ? { halfPeriod } : {}),
      note,
      ...(canManage && target ? { userEmail: target } : {}),
    }).catch(() => setBusy(false));
  };
  const modeBtn = (isHalf, label) => (
    <button key={label} onClick={() => setHalfDay(isHalf)} className="btn-ghost"
      style={{ flex: 1, border: 'none', borderRadius: 0, fontWeight: 600, justifyContent: 'center',
        background: halfDay === isHalf ? BRAND.blue : 'white', color: halfDay === isHalf ? 'white' : BRAND.ink }}>
      {label}
    </button>
  );
  const periodBtn = (id) => (
    <button key={id} onClick={() => setHalfPeriod(id)} className="btn-ghost"
      style={{ flex: 1, border: 'none', borderRadius: 0, fontWeight: 600, justifyContent: 'center',
        background: halfPeriod === id ? BRAND.blue : 'white', color: halfPeriod === id ? 'white' : BRAND.ink }}>
      {HALF_LABEL[id]}
    </button>
  );
  return (
    <Modal onClose={onClose} dismissible={false} maxWidth={440}>
      <h3 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>Book annual leave</h3>
      {canManage && (
        <Field label="Team member (leave blank for yourself)">
          <select className="input" value={target} onChange={e => setTarget(e.target.value)} style={selStyle}>
            <option value="">Me</option>
            {producers.map(p => <option key={p.email} value={p.email}>{p.name || p.email}</option>)}
          </select>
        </Field>
      )}
      <Field label="Length">
        <div style={{ display: 'flex', border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden' }}>
          {modeBtn(false, 'Full day(s)')}
          {modeBtn(true, 'Half day')}
        </div>
      </Field>
      <Field label={halfDay ? 'Date' : 'From'}>
        <input type="date" className="input" value={start} onChange={e => setStart(e.target.value)} style={selStyle} />
      </Field>
      {halfDay ? (
        <Field label="Which half">
          <div style={{ display: 'flex', border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden' }}>
            {periodBtn('am')}
            {periodBtn('pm')}
          </div>
        </Field>
      ) : (
        <Field label="To"><input type="date" className="input" value={end} min={start} onChange={e => setEnd(e.target.value)} style={selStyle} /></Field>
      )}
      <Field label="Note (optional)"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. family holiday" style={selStyle} /></Field>

      <div style={{ fontSize: 13, color: BRAND.muted, marginBottom: 4 }}>
        This will use <strong style={{ color: BRAND.ink }}>{daysRequested} day{daysRequested === 1 ? '' : 's'}</strong> of your allowance.
        {halfDay && ' You stay on the rota for the other half of the day.'}
      </div>

      {clashes.length > 0 && (
        <div style={{ background: '#FFFBEB', border: '1px solid #FCD34D', color: '#92400E', borderRadius: 10, padding: '10px 12px', fontSize: 13, marginTop: 4, marginBottom: 4, display: 'flex', gap: 10 }}>
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              This overlaps {clashes.length} scheduled job{clashes.length === 1 ? '' : 's'}.
            </div>
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {clashes.slice(0, 5).map(a => (
                <li key={a.id}>{a.manual ? (a.projectTitle || a.title || 'Booked block') : `${a.projectTitle} — ${a.videoTitle}`}{a.kind && !a.manual ? ` (${KIND_LABEL[a.kind] || a.kind})` : ''}</li>
              ))}
            </ul>
            <div style={{ marginTop: 5 }}>
              {halfDay
                ? 'A half day won’t move the work — you’ll just have less time on it that day.'
                : 'You can still request it — a manager will see the clash and re-plan the work when approving.'}
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={submit} disabled={busy}>{busy ? 'Submitting…' : (clashes.length && !halfDay ? 'Request anyway' : 'Submit request')}</button>
      </div>
    </Modal>
  );
}

// ── Review a pending leave request: what it clashes with + how to resolve ──
function LeaveReviewModal({ leave, nameFor, actions, onClose }) {
  const [impact, setImpact] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const load = () => {
    setLoading(true);
    actions.loadLeaveImpact(leave.id)
      .then(r => setImpact(r || { clashes: [] }))
      .catch(() => setImpact({ clashes: [] }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [leave.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const clashes = impact?.clashes || [];
  const fmt = (d) => (d ? fmtDayLabel(d, { weekday: 'short' }) : '—');

  const applyMove = (fields, assignmentId) => {
    setBusy(true);
    actions.moveAssignment(assignmentId, fields).then(load).finally(() => setBusy(false));
  };
  const decide = (status) => {
    setBusy(true);
    actions.decideLeave(leave.id, status).then(onClose).catch(() => setBusy(false));
  };

  return (
    <Modal onClose={onClose} dismissible={false} maxWidth={640}>
      <h3 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700 }}>Review leave — {nameFor(leave.userEmail)}</h3>
      <div style={{ color: BRAND.muted, fontSize: 14, marginBottom: 16 }}>
        {leave.halfDay
          ? `${leave.startDate} · half day (${HALF_LABEL[leave.halfPeriod] || 'Morning'}) · 0.5 days`
          : `${leave.startDate} → ${leave.endDate} · ${leave.days} day${leave.days === 1 ? '' : 's'}`}
        {leave.note ? ' · ' + leave.note : ''}
      </div>

      {loading ? (
        <div style={{ color: BRAND.muted, fontSize: 14, padding: '12px 0' }}>Checking production impact…</div>
      ) : leave.halfDay ? (
        <div style={{ background: '#ECFDF5', border: '1px solid #A7F3D0', color: '#065F46', borderRadius: 10, padding: '12px 14px', fontSize: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
          <Check size={18} /> A half day doesn’t take them off the rota — no work needs re-planning.
        </div>
      ) : clashes.length === 0 ? (
        <div style={{ background: '#ECFDF5', border: '1px solid #A7F3D0', color: '#065F46', borderRadius: 10, padding: '12px 14px', fontSize: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
          <Check size={18} /> No production work clashes with these dates — safe to approve.
        </div>
      ) : (
        <>
          <div style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#7F1D1D', borderRadius: 10, padding: '10px 14px', fontSize: 14, marginBottom: 14, display: 'flex', gap: 10 }}>
            <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>This leave overlaps <strong>{clashes.length}</strong> production block{clashes.length === 1 ? '' : 's'}. Resolve each below, then approve.</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {clashes.map(c => (
              <div key={c.assignmentId} style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{c.projectTitle || 'Project'}{c.videoTitle ? ' — ' + c.videoTitle : ''}</div>
                <div style={{ fontSize: 12.5, color: BRAND.muted, marginTop: 2 }}>
                  {KIND_LABEL[c.kind] || c.kind} · {c.duration}d · currently {fmt(c.currentStart)} → {fmt(c.currentEnd)}
                  {c.deadline ? ` · delivery ${fmt(c.deadline)}` : ''}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                  {c.sameProducer && (
                    <SuggestionRow color="#16A34A" bg="#ECFDF5" border="#A7F3D0"
                      label={<>Keep <strong>{c.producerName}</strong> — move to {fmt(c.sameProducer.start)} → {fmt(c.sameProducer.end)}</>}
                      cta="Reschedule" busy={busy}
                      onApply={() => applyMove({ startDate: c.sameProducer.start, endDate: c.sameProducer.end }, c.assignmentId)} />
                  )}
                  {c.altProducer && (
                    <SuggestionRow color="#0369A1" bg="#EFF6FF" border="#BFDBFE"
                      label={<>Reassign to <strong>{c.altProducer.name}</strong> — {fmt(c.altProducer.start)} → {fmt(c.altProducer.end)}</>}
                      cta="Reassign" busy={busy}
                      onApply={() => applyMove({ startDate: c.altProducer.start, endDate: c.altProducer.end, userEmail: c.altProducer.email }, c.assignmentId)} />
                  )}
                  {c.needsReview && (
                    <div style={{ background: '#FFFBEB', border: '1px solid #FCD34D', color: '#92400E', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}>
                      No producer has a free slot before the delivery date. Consider a <strong>freelancer</strong>, or <strong>push back the delivery date</strong> — this is project-dependent, so review it manually.
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18, paddingTop: 14, borderTop: '1px solid ' + BRAND.border }}>
        <button className="btn-ghost" onClick={onClose} disabled={busy}>Close</button>
        <button className="btn-ghost" onClick={() => decide('denied')} disabled={busy}><X size={14} /> Deny</button>
        <button className="btn" onClick={() => decide('approved')} disabled={busy || loading} style={{ background: '#16A34A' }}>
          <Check size={14} /> {clashes.length ? 'Approve anyway' : 'Approve'}
        </button>
      </div>
    </Modal>
  );
}

function SuggestionRow({ color, bg, border, label, cta, onApply, busy }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: bg, border: '1px solid ' + border, borderRadius: 8, padding: '8px 10px' }}>
      <span style={{ fontSize: 13, color }}>{label}</span>
      <button className="btn" onClick={onApply} disabled={busy} style={{ background: color, flexShrink: 0 }}>{cta}</button>
    </div>
  );
}

function BlockModal({ assignment, producers, canManage, me, onClose, onOpenProject, onOpenVideo, actions }) {
  const manual = assignment.manual;
  const [start, setStart] = useState(assignment.startDate);
  const [end, setEnd] = useState(assignment.endDate);
  const [title, setTitle] = useState(assignment.title || '');
  const [producer, setProducer] = useState(assignment.userEmail);
  const [busy, setBusy] = useState(false);
  const canEdit = canManage || assignment.userEmail === me;
  // The block spans exactly the chosen start→end days. `base` (from the video
  // length) is what the auto-scheduler allotted; "extra days" is anything the
  // producer added on top, kept in sync with the end date so the two controls
  // never disagree.
  const base = Math.max(1, assignment.durationDays || 1);
  const totalDays = Math.max(1, countWorkingDays(start, end));
  const extra = Math.max(0, totalDays - base);
  const setStartD = (v) => { setStart(v); if (v && end < v) setEnd(v); };
  const setEndD = (v) => setEnd(v && v < start ? start : v);
  const bumpExtra = (delta) => {
    const next = Math.max(0, extra + delta);
    setEnd(addWorkingDays(start, base + next - 1));
  };
  const save = () => {
    setBusy(true);
    // Both manual and production blocks now save an explicit span; the server
    // derives the duration and marks the block hand-edited so re-syncs respect it.
    const fields = { startDate: start, endDate: end, ...(manual ? { title } : {}), ...(canManage ? { userEmail: producer } : {}) };
    actions.moveAssignment(assignment.id, fields).then(onClose).catch(() => setBusy(false));
  };
  return (
    <Modal onClose={onClose} dismissible={false} maxWidth={440}>
      <h3 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700 }}>{manual ? (assignment.title || 'Manual block') : assignment.projectTitle}</h3>
      <div style={{ color: BRAND.muted, fontSize: 14, marginBottom: 14 }}>
        {manual ? 'Manual block' : `${assignment.videoTitle}${assignment.videoLength ? ' · ' + assignment.videoLength : ''} · ${KIND_LABEL[assignment.kind] || assignment.kind}`}
      </div>
      {(assignment.conflict || assignment.leaveConflict) && (
        <div style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#7F1D1D', borderRadius: 8, padding: '8px 10px', fontSize: 13, marginBottom: 14 }}>
          {assignment.leaveConflict ? 'This overlaps booked annual leave.' : assignment.conflictReason}
        </div>
      )}
      {canEdit ? (
        <>
          {manual && <Field label="Card name"><input className="input" value={title} onChange={e => setTitle(e.target.value)} style={selStyle} /></Field>}
          <Field label="Start date"><input type="date" className="input" value={start} onChange={e => setStartD(e.target.value)} style={selStyle} /></Field>
          <Field label={`End date — total ${totalDays} working day${totalDays === 1 ? '' : 's'}`}>
            <input type="date" className="input" value={end} min={start} onChange={e => setEndD(e.target.value)} style={selStyle} />
          </Field>
          {!manual && (
            <Field label="Extra days (complexity buffer)">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button className="btn-ghost" onClick={() => bumpExtra(-1)} disabled={extra <= 0}>−</button>
                <span style={{ fontWeight: 700, minWidth: 24, textAlign: 'center' }}>{extra}</span>
                <button className="btn-ghost" onClick={() => bumpExtra(1)}><Plus size={14} /></button>
                <span style={{ fontSize: 12, color: BRAND.muted }}>on top of the {base}-day base</span>
              </div>
            </Field>
          )}
          {canManage && (
            <Field label="Assigned producer">
              <select className="input" value={producer} onChange={e => setProducer(e.target.value)} style={selStyle}>
                {producers.map(p => <option key={p.email} value={p.email}>{p.name || p.email}</option>)}
              </select>
            </Field>
          )}
        </>
      ) : <div style={{ fontSize: 13, color: BRAND.muted }}>Scheduled {assignment.startDate} → {assignment.endDate}.</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 16 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {!manual && onOpenVideo && assignment.videoId && <button className="btn-ghost" onClick={() => { onOpenVideo(assignment.videoId); onClose(); }}>Open video</button>}
          {canEdit && <button className="btn-ghost" onClick={() => actions.deleteAssignment(assignment.id).then(onClose)} title="Remove from calendar" style={{ color: '#DC2626' }}><Trash2 size={14} /></button>}
        </div>
        {canEdit && <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>}
      </div>
    </Modal>
  );
}

function NewBlockModal({ producers, onClose, onSubmit }) {
  const [title, setTitle] = useState('');
  const [producer, setProducer] = useState(producers[0]?.email || '');
  const [start, setStart] = useState(todayStr());
  const [end, setEnd] = useState(todayStr());
  const [busy, setBusy] = useState(false);
  const submit = () => {
    if (!producer || !start) return;
    setBusy(true);
    onSubmit({ userEmail: producer, title: title.trim() || 'Manual block', startDate: start, endDate: end || start })
      .catch(() => setBusy(false));
  };
  return (
    <Modal onClose={onClose} dismissible={false} maxWidth={420}>
      <h3 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>Add a block to the rota</h3>
      <Field label="Card name"><input className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Ad-hoc edit, filming day" style={selStyle} /></Field>
      <Field label="Producer">
        <select className="input" value={producer} onChange={e => setProducer(e.target.value)} style={selStyle}>
          {producers.map(p => <option key={p.email} value={p.email}>{p.name || p.email}</option>)}
        </select>
      </Field>
      <Field label="From"><input type="date" className="input" value={start} onChange={e => setStart(e.target.value)} style={selStyle} /></Field>
      <Field label="To"><input type="date" className="input" value={end} min={start} onChange={e => setEnd(e.target.value)} style={selStyle} /></Field>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={submit} disabled={busy}>{busy ? 'Adding…' : 'Add block'}</button>
      </div>
    </Modal>
  );
}

function AllowanceModal({ row, onClose, onSave }) {
  const [allowance, setAllowance] = useState(row.annualAllowance ?? 20);
  const [compulsory, setCompulsory] = useState(row.compulsoryDays ?? 6);
  const [used, setUsed] = useState(row.takenAdjustment ?? 0);
  const [anniversary, setAnniversary] = useState(row.anniversary || '');
  const [onRoster, setOnRoster] = useState(row.onRoster !== false);
  const [track, setTrack] = useState(row.trackAllowance !== false);
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    onSave({ annualAllowance: Number(allowance), compulsoryDays: Number(compulsory), takenAdjustment: Number(used) || 0, anniversary: anniversary || null, active: onRoster, trackAllowance: track })
      .catch(() => setBusy(false));
  };
  return (
    <Modal onClose={onClose} dismissible={false} maxWidth={420}>
      <h3 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>{row.name}</h3>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 14, cursor: 'pointer' }}>
        <input type="checkbox" checked={onRoster} onChange={e => setOnRoster(e.target.checked)} />
        On the schedule <span style={{ color: BRAND.muted }}>— calendar column, assignable, can log days off</span>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 14, cursor: onRoster ? 'pointer' : 'not-allowed', opacity: onRoster ? 1 : 0.5 }}>
        <input type="checkbox" checked={track} disabled={!onRoster} onChange={e => setTrack(e.target.checked)} />
        Track annual-leave allowance <span style={{ color: BRAND.muted }}>— off for directors with separate holidays</span>
      </label>
      <div style={{ opacity: track ? 1 : 0.5, pointerEvents: track ? 'auto' : 'none' }}>
        <Field label="Annual allowance (days, incl. compulsory)"><input type="number" step="0.5" className="input" value={allowance} onChange={e => setAllowance(e.target.value)} style={selStyle} /></Field>
        <Field label="Compulsory days (Christmas)"><input type="number" step="0.5" className="input" value={compulsory} onChange={e => setCompulsory(e.target.value)} style={selStyle} /></Field>
        <Field label="Days already taken this leave year"><input type="number" step="0.5" className="input" value={used} onChange={e => setUsed(e.target.value)} style={selStyle} /></Field>
        <div style={{ fontSize: 12, color: BRAND.muted, margin: '-6px 0 12px' }}>Opening balance for leave taken before it was tracked here. Leave booked in the app is added on top.</div>
        <Field label="Renewal date (renews yearly on this day)"><input type="date" className="input" value={anniversary} onChange={e => setAnniversary(e.target.value)} style={selStyle} /></Field>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

const selStyle = { width: '100%', padding: '9px 11px', border: '1px solid ' + BRAND.border, borderRadius: 8, fontSize: 14, boxSizing: 'border-box' };
