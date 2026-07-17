import React, { useEffect, useMemo, useState } from 'react';
import { Plane, CalendarDays } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { ResponsiveTable } from '../ui.jsx';
import { AllowanceModal } from '../crm/ScheduleView.jsx';

const CARD = { background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 18, marginBottom: 16 };

// Admin → Holiday. A staff-wide view of annual-leave allowances: how much each
// person is entitled to, how much they've taken this leave year and what's left.
// Reuses the producer-schedule payload (`allowances[]`) and the same
// PATCH /api/crm/schedule/allowance/:email editor as the Staff Production Rota,
// so the two views always agree. Editing is gated on `schedule.manage_allowance`
// (surfaced by the server as `canManageAllowance`).
export function HolidayTab() {
  const { state, actions } = useStore();
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    setLoading(true);
    actions.loadSchedule().finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sched = state.schedule || {};
  const canEdit = !!sched.canManageAllowance;
  const all = sched.allowances || [];

  const tracked = all.filter(a => a.onRoster && a.trackAllowance);
  const untracked = all.filter(a => a.onRoster && !a.trackAllowance);
  const removed = all.filter(a => !a.onRoster);

  const columns = useMemo(() => [
    { key: 'name', label: 'Team member', render: r => r.name },
    { key: 'annualAllowance', label: 'Allowance', align: 'right', render: r => r.annualAllowance },
    { key: 'compulsoryDays', label: 'Compulsory', align: 'right', render: r => r.compulsoryDays },
    { key: 'taken', label: 'Taken', align: 'right', render: r => r.taken },
    { key: 'remaining', label: 'Days left', align: 'right', render: r => (
      <span style={{ fontWeight: 700, color: r.remaining <= 0 ? '#DC2626' : r.remaining <= 3 ? '#D97706' : '#16A34A' }}>{r.remaining}</span>
    ) },
    { key: 'renewal', label: 'Renews', align: 'right', render: r => r.renewal },
  ], []);

  const save = (fields) =>
    actions.updateAllowance(editing.userEmail, fields).then(() => setEditing(null));

  // Leave bookings for the person being edited, scoped to their current leave
  // year (the window that feeds "Taken") so a manager can spot and delete stray
  // or test entries — e.g. the bogus approved requests that pushed someone
  // negative. `renewal` is the next renewal date; the window is the year before.
  const leaveForEditing = useMemo(() => {
    if (!editing) return [];
    const next = editing.renewal || null;
    let start = null;
    if (next) { const d = new Date(next); d.setFullYear(d.getFullYear() - 1); start = d.toISOString().slice(0, 10); }
    return (sched.leave || [])
      .filter(l => l.userEmail === editing.userEmail && l.status !== 'denied')
      .filter(l => !start || (l.startDate >= start && l.startDate < next))
      .sort((a, b) => b.startDate.localeCompare(a.startDate));
  }, [editing, sched.leave]);

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Plane size={18} color="#D97706" /> Holiday
        </h2>
        <span style={{ fontSize: 12, color: BRAND.muted, marginLeft: 'auto' }}>Default 20 days · 6 compulsory (Christmas)</span>
      </div>
      <p style={{ margin: '0 0 18px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
        Annual-leave allowance for every team member — total entitlement, compulsory Christmas days,
        how much they've taken this leave year and what's left. Figures renew each year on the person's
        renewal date. Booked and approved leave in the <strong>Staff Production Rota</strong> feeds
        "Taken" automatically.{canEdit ? ' Tap a row to change someone’s allowance.' : ''}
      </p>

      {loading && !all.length ? (
        <div style={{ ...CARD, color: BRAND.muted, fontSize: 14 }}>Loading…</div>
      ) : (
        <>
          <div style={CARD}>
            <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
              <CalendarDays size={14} /> Tracked
            </div>
            <ResponsiveTable columns={columns} rows={tracked} keyField="userEmail"
              onRowClick={canEdit ? setEditing : undefined} empty="No one is tracked yet." />
          </div>

          {canEdit && untracked.length > 0 && (
            <div style={CARD}>
              <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>On the rota · allowance not tracked</div>
              <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 10 }}>Directors and anyone with separate holiday arrangements. Tap to start tracking.</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {untracked.map(h => (
                  <button key={h.userEmail} className="btn-ghost" onClick={() => setEditing(h)} style={{ fontSize: 12 }}>{h.name} · edit</button>
                ))}
              </div>
            </div>
          )}

          {canEdit && removed.length > 0 && (
            <div style={CARD}>
              <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>Off the rota</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {removed.map(h => (
                  <button key={h.userEmail} className="btn-ghost" onClick={() => setEditing(h)} style={{ fontSize: 12 }}>{h.name} · add</button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {editing && (
        <AllowanceModal
          row={editing}
          onClose={() => setEditing(null)}
          onSave={save}
          leaveEntries={editing.trackAllowance ? leaveForEditing : null}
          onDeleteLeave={(id) => actions.cancelLeave(id)}
        />
      )}
    </div>
  );
}
