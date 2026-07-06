import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Trash2, Check, X, AlertTriangle, Plane, LayoutGrid } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { Modal, ResponsiveTable, Badge, Section, Field } from '../ui.jsx';
import {
  weekStart, addDays, addWorkingDays, workingDaysBetween, fmtDayLabel,
  todayStr, blockColors, parseDate, fmtDate, isWeekend,
} from '../../lib/scheduleCalendar.js';

const KIND_LABEL = { storyboard: 'Storyboard / Visuals', production: 'Production' };

function initials(name, email) {
  const src = (name || email || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}
function addMonths(dateStr, n) {
  const d = parseDate(dateStr);
  return fmtDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)));
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

  useEffect(() => { actions.loadSchedule(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const canManage = !!sched.canManage;
  const canApprove = !!sched.canApproveLeave;
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
            <button className="btn" onClick={() => setNewBlock(true)} style={{ fontWeight: 600 }}>
              <Plus size={14} /> Add block
            </button>
          )}
          <button className="btn-ghost" onClick={() => setLeaveModal(true)} style={{ fontWeight: 600 }}>
            <Plane size={14} /> Book leave
          </button>
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

      {/* Calendar */}
      {viewMode === 'month'
        ? (isMobile
            ? <AgendaList days={cells.filter(c => c.inMonth && !isWeekend(c.day)).map(c => c.day)} producers={visibleProducers} asgByCell={asgByCell} leaveByCell={leaveByCell} today={today} onBlock={setBlockModal} />
            : <MonthGrid cells={cells} producers={visibleProducers} single={single} asgByCell={asgByCell} leaveByCell={leaveByCell} today={today} canManage={canManage} me={me} onBlock={setBlockModal} onDropCell={onDropCell} />)
        : (isMobile
            ? <AgendaList days={weekDays} producers={visibleProducers} asgByCell={asgByCell} leaveByCell={leaveByCell} today={today} onBlock={setBlockModal} />
            : <CalendarGrid weekDays={weekDays} producers={visibleProducers} asgByCell={asgByCell} leaveByCell={leaveByCell}
                today={today} canManage={canManage} me={me} onBlock={setBlockModal} onDropCell={onDropCell} />)}

      {/* Leave requests + allowances + amends */}
      <div style={{ marginTop: 28 }}>
        <LeavePanel sched={sched} canManage={canManage} canApprove={canApprove} me={me} actions={actions} />
        <AllowancePanel sched={sched} canManage={canManage} canApprove={canApprove} me={me} onEdit={setAllowanceModal} />
        <AmendsPanel sched={sched} onOpenVideo={onOpenVideo} />
      </div>

      {newBlock && <NewBlockModal producers={allProducers} onClose={() => setNewBlock(false)}
        onSubmit={(f) => actions.createBlock(f).then(() => setNewBlock(false))} />}
      {leaveModal && <LeaveModal producers={allProducers} canManage={canManage} onClose={() => setLeaveModal(false)}
        onSubmit={(f) => actions.requestLeave(f).then(() => setLeaveModal(false))} />}
      {blockModal && <BlockModal assignment={blockModal} producers={allProducers} canManage={canManage} me={me}
        onOpenProject={onOpenProject} onOpenVideo={onOpenVideo}
        onClose={() => setBlockModal(null)} actions={actions} />}
      {allowanceModal && <AllowanceModal row={allowanceModal} onClose={() => setAllowanceModal(null)}
        onSave={(f) => actions.updateAllowance(allowanceModal.userEmail, f).then(() => setAllowanceModal(null))} />}
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
                    {leave && <MiniChip label={prefix + 'Leave'} leave />}
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
function CalendarGrid({ weekDays, producers, asgByCell, leaveByCell, today, canManage, me, onBlock, onDropCell }) {
  const colW = `minmax(150px, 1fr)`;
  return (
    <div style={{ overflowX: 'auto', border: '1px solid ' + BRAND.border, borderRadius: 12, background: 'white' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `110px repeat(${producers.length}, ${colW})`, minWidth: 110 + producers.length * 150 }}>
        {/* header */}
        <div style={{ borderBottom: '1px solid ' + BRAND.border, background: BRAND.paper }} />
        {producers.map(p => (
          <div key={p.email} style={{ padding: '10px 12px', borderBottom: '1px solid ' + BRAND.border, borderLeft: '1px solid ' + BRAND.paper, background: BRAND.paper, display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13 }}>
            <span style={{ width: 26, height: 26, borderRadius: '50%', background: BRAND.blue, color: 'white', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{initials(p.name, p.email)}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name || p.email}</span>
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
      title={`${asg.projectTitle} — ${asg.videoTitle} (${KIND_LABEL[asg.kind] || asg.kind})`}
      style={{ background: c.bg, color: c.fg, border: '1px solid ' + c.border, borderRadius: 8, padding: '6px 8px', cursor: 'pointer', fontSize: 12, lineHeight: 1.3 }}>
      <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asg.projectTitle}</div>
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.9 }}>
        {asg.videoTitle}{asg.videoLength ? ' · ' + asg.videoLength : ''}
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 2, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3 }}>
        <span>{asg.kind === 'storyboard' ? 'Visuals' : 'Production'} · {dur}d</span>
        {(asg.conflict || asg.leaveConflict) && <AlertTriangle size={11} />}
      </div>
    </div>
  );
}

function LeaveChip({ leave }) {
  const approved = leave.status === 'approved';
  return (
    <div style={{ background: approved ? '#FEF3C7' : '#FDF2F8', color: approved ? '#92400E' : '#9D174D', border: '1px dashed ' + (approved ? '#FCD34D' : '#F9A8D4'), borderRadius: 8, padding: '4px 8px', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
      <Plane size={11} /> {approved ? 'Annual leave' : 'Leave (pending)'}
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
  const nameFor = (email) => (sched.producers || []).find(p => p.email === email)?.name || email;
  const upcoming = leave.filter(l => l.status !== 'denied' && l.endDate >= todayStr())
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  return (
    <Section title="Annual leave" icon={Plane} color="#D97706">
      {canApprove && (
        <>
          <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>Awaiting approval</div>
          {pending.length === 0 && <div style={{ color: BRAND.muted, fontSize: 13, marginBottom: 12 }}>No requests to approve.</div>}
          {pending.map(l => (
            <div key={l.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderBottom: '1px solid ' + BRAND.paper, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 14 }}>
                <strong>{nameFor(l.userEmail)}</strong> · {l.startDate} → {l.endDate} · {l.days}d{l.note ? ' · ' + l.note : ''}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn" onClick={() => actions.decideLeave(l.id, 'approved')} style={{ background: '#16A34A' }}><Check size={14} /> Approve</button>
                <button className="btn-ghost" onClick={() => actions.decideLeave(l.id, 'denied')}><X size={14} /> Deny</button>
              </div>
            </div>
          ))}
        </>
      )}
      <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, margin: '14px 0 8px' }}>Upcoming leave</div>
      {upcoming.length === 0 && <div style={{ color: BRAND.muted, fontSize: 13 }}>No upcoming leave booked.</div>}
      {upcoming.map(l => (
        <div key={l.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: '1px solid ' + BRAND.paper }}>
          <div style={{ fontSize: 14 }}>
            {canManage && <strong>{nameFor(l.userEmail)} · </strong>}{l.startDate} → {l.endDate} · {l.days}d{' '}
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
function AllowancePanel({ sched, canManage, canApprove, me, onEdit }) {
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
        onRowClick={canApprove ? onEdit : undefined} empty="No one is tracked yet." />
      {canApprove && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 8 }}>Tap a row to edit allowance, compulsory days or the renewal anniversary. Use it to remove someone, or to keep them on the schedule without tracking an allowance. Admins are hidden by default.</div>}
      {canApprove && untracked.length > 0 && (
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
      {canApprove && removed.length > 0 && (
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
function AmendsPanel({ sched, onOpenVideo }) {
  const amends = sched.amends || [];
  return (
    <Section title="Amends to do" icon={AlertTriangle} color="#DC2626"
      badge={<span style={{ fontSize: 12, color: BRAND.muted }}>{amends.length} outstanding</span>}>
      {amends.length === 0 && <div style={{ color: BRAND.muted, fontSize: 13 }}>No amends outstanding — nice.</div>}
      {amends.map(a => (
        <div key={a.videoId} onClick={() => onOpenVideo && onOpenVideo(a.videoId)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 0', borderBottom: '1px solid ' + BRAND.paper, cursor: onOpenVideo ? 'pointer' : 'default' }}>
          <div style={{ fontSize: 14 }}>
            <strong>{a.projectTitle}</strong> — {a.videoTitle}
          </div>
          <Badge color={a.kind === 'storyboard' ? 'orange' : 'blue'}>{a.kind === 'storyboard' ? 'Storyboard revisions' : 'Revisions'}</Badge>
        </div>
      ))}
    </Section>
  );
}

// ── Modals ──
function LeaveModal({ producers, canManage, onClose, onSubmit }) {
  const [start, setStart] = useState(todayStr());
  const [end, setEnd] = useState(todayStr());
  const [note, setNote] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = () => {
    if (!start) return;
    setBusy(true);
    onSubmit({ startDate: start, endDate: end || start, note, ...(canManage && target ? { userEmail: target } : {}) })
      .catch(() => setBusy(false));
  };
  return (
    <Modal onClose={onClose} dismissible={false} maxWidth={420}>
      <h3 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>Book annual leave</h3>
      {canManage && (
        <Field label="Team member (leave blank for yourself)">
          <select className="input" value={target} onChange={e => setTarget(e.target.value)} style={selStyle}>
            <option value="">Me</option>
            {producers.map(p => <option key={p.email} value={p.email}>{p.name || p.email}</option>)}
          </select>
        </Field>
      )}
      <Field label="From"><input type="date" className="input" value={start} onChange={e => setStart(e.target.value)} style={selStyle} /></Field>
      <Field label="To"><input type="date" className="input" value={end} min={start} onChange={e => setEnd(e.target.value)} style={selStyle} /></Field>
      <Field label="Note (optional)"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. family holiday" style={selStyle} /></Field>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={submit} disabled={busy}>{busy ? 'Submitting…' : 'Submit request'}</button>
      </div>
    </Modal>
  );
}

function BlockModal({ assignment, producers, canManage, me, onClose, onOpenProject, onOpenVideo, actions }) {
  const manual = assignment.manual;
  const [start, setStart] = useState(assignment.startDate);
  const [end, setEnd] = useState(assignment.endDate);
  const [title, setTitle] = useState(assignment.title || '');
  const [extra, setExtra] = useState(assignment.extendedDays || 0);
  const [producer, setProducer] = useState(assignment.userEmail);
  const [busy, setBusy] = useState(false);
  const canEdit = canManage || assignment.userEmail === me;
  const totalDays = assignment.durationDays + Math.max(0, extra);
  const save = () => {
    setBusy(true);
    const fields = manual
      ? { startDate: start, endDate: end, title, ...(canManage ? { userEmail: producer } : {}) }
      : { startDate: start, extendedDays: Math.max(0, extra), ...(canManage ? { userEmail: producer } : {}) };
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
          <Field label="Start date"><input type="date" className="input" value={start} onChange={e => setStart(e.target.value)} style={selStyle} /></Field>
          {manual ? (
            <Field label="End date"><input type="date" className="input" value={end} min={start} onChange={e => setEnd(e.target.value)} style={selStyle} /></Field>
          ) : (
            <Field label={`Extra days (complexity buffer) — total ${totalDays} day${totalDays === 1 ? '' : 's'}`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button className="btn-ghost" onClick={() => setExtra(x => Math.max(0, x - 1))}>−</button>
                <span style={{ fontWeight: 700, minWidth: 24, textAlign: 'center' }}>{extra}</span>
                <button className="btn-ghost" onClick={() => setExtra(x => x + 1)}><Plus size={14} /></button>
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
  const [anniversary, setAnniversary] = useState(row.anniversary || '');
  const [onRoster, setOnRoster] = useState(row.onRoster !== false);
  const [track, setTrack] = useState(row.trackAllowance !== false);
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    onSave({ annualAllowance: Number(allowance), compulsoryDays: Number(compulsory), anniversary: anniversary || null, active: onRoster, trackAllowance: track })
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
        <Field label="Renewal anniversary (join date)"><input type="date" className="input" value={anniversary} onChange={e => setAnniversary(e.target.value)} style={selStyle} /></Field>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

const selStyle = { width: '100%', padding: '9px 11px', border: '1px solid ' + BRAND.border, borderRadius: 8, fontSize: 14, boxSizing: 'border-box' };
