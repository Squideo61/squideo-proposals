import React, { useMemo, useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, X, Plus, Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { Modal } from '../ui.jsx';
import { Avatar } from '../Avatar.jsx';
import { useStore } from '../../store.jsx';
import { BRAND } from '../../theme.js';

// Single modal used for both creating and editing a task.
//   - Pass `task` to edit (the form pre-fills from it).
//   - Pass `defaults={{ dealId }}` to create with a fixed deal (deal picker
//     is hidden because the caller has already chosen the deal).
//   - Pass nothing to create with a deal picker.
// Calls onSaved(task) after either path. The modal does NOT close itself —
// the caller decides (so it can also refresh related views).
//   - Pass `onSubmitValues` to take over creation: instead of writing the task
//     itself, the modal validates and hands the raw payload back, letting the
//     caller decide when (or whether) to create it — e.g. the email composer
//     defers the follow-up task until the send actually goes out, so undoing
//     the send also cancels the task.
export function TaskFormModal({ task, defaults, onClose, onSaved, onSubmitValues, submitLabel }) {
  const { state, actions } = useStore();
  const editing = !!task;
  // New tasks pre-fill "Follow up" (the common case) — overwrite it if the task
  // is something else. Editing keeps the task's own title; explicit defaults win.
  const [title, setTitle] = useState(task?.title || defaults?.title || (editing ? '' : 'Follow up'));
  const [notes, setNotes] = useState(task?.notes || '');
  const [dueAt, setDueAt] = useState(
    task?.dueAt ? isoToLocalInput(task.dueAt)
      : defaults?.dueAt ? isoToLocalInput(defaults.dueAt)
      : localTomorrow()
  );
  const initialAssignees = useMemo(() => {
    if (Array.isArray(task?.assigneeEmails) && task.assigneeEmails.length) return task.assigneeEmails;
    if (task?.assigneeEmail) return [task.assigneeEmail];
    if (!editing && state.session?.email) return [state.session.email];
    return [];
  }, [task, editing, state.session?.email]);
  const [assigneeEmails, setAssigneeEmails] = useState(initialAssignees);
  const [dealId, setDealId] = useState(task?.dealId || defaults?.dealId || '');
  const [submitting, setSubmitting] = useState(false);

  // Always include the signed-in user in the pickable list, so a new task that
  // defaults to "assigned to me" actually shows the chip even if the team
  // directory (state.users) hasn't loaded the current user's own record.
  const allUsers = useMemo(() => {
    const list = Object.values(state.users || {});
    const me = state.session;
    if (me?.email && !list.some(u => (u.email || '').toLowerCase() === me.email.toLowerCase())) {
      return [{ email: me.email, name: me.name, avatar: me.avatar }, ...list];
    }
    return list;
  }, [state.users, state.session]);
  const deals = Object.values(state.deals || {});
  const showDealPicker = !(defaults?.dealId);

  const toggleAssignee = (email) => {
    setAssigneeEmails(prev =>
      prev.includes(email) ? prev.filter(e => e !== email) : [...prev, email]
    );
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    const payload = {
      title: title.trim(),
      notes: notes.trim() || null,
      dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      assigneeEmails,
      dealId: dealId || null,
    };
    // Deferred-create mode: hand the values back and let the caller persist
    // them on its own schedule (no server write here).
    if (onSubmitValues) {
      setSubmitting(false);
      onSubmitValues(payload);
      return;
    }
    let result;
    if (editing) result = await actions.saveTask(task.id, payload);
    else result = await actions.createTask(payload);
    setSubmitting(false);
    onSaved?.(result);
  };

  const handleDelete = () => {
    if (!editing) return;
    if (!window.confirm('Delete this task?')) return;
    actions.deleteTask(task.id);
    onClose();
  };

  return (
    <Modal onClose={onClose} fullScreenOnMobile>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>{editing ? 'Edit task' : 'New task'}</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Row label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Call Sarah" autoFocus required />
        </Row>
        <Row label="Due">
          <DateTimePicker value={dueAt} onChange={setDueAt} />
        </Row>
        <Row label="Assignees">
          <AssigneePicker
            users={allUsers}
            selected={assigneeEmails}
            onToggle={toggleAssignee}
          />
        </Row>
        {showDealPicker && (
          <Row label="Deal (optional)">
            <select className="input" value={dealId} onChange={(e) => setDealId(e.target.value)}>
              <option value="">—</option>
              {deals.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
            </select>
          </Row>
        )}
        <Row label="Notes (optional)">
          <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ fontFamily: 'inherit', resize: 'vertical' }} />
        </Row>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          {editing
            ? <button type="button" onClick={handleDelete} className="btn-ghost is-danger"><Trash2 size={14} /> Delete</button>
            : <span />}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" className="btn" disabled={!title.trim() || submitting}>
              {submitting ? 'Saving…' : (submitLabel || (editing ? 'Save' : 'Create'))}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// Chip-style multi-select. Selected users are pills with an × to remove; the
// rest are tucked behind a compact "+ Add" button that opens a dropdown, so the
// control stays clean no matter how many teammates there are.
// Exported so the video/project "Producers" pickers reuse the exact same UI.
export function AssigneePicker({ users, selected, onToggle, emptyLabel = 'No one assigned' }) {
  const selectedSet = new Set(selected);
  const selectedUsers = users.filter(u => selectedSet.has(u.email));
  const remaining = users.filter(u => !selectedSet.has(u.email));
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

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 6, padding: 6,
        border: '1px solid ' + BRAND.border, borderRadius: 8, minHeight: 38,
        alignItems: 'center', background: 'white',
      }}>
        {selectedUsers.length === 0 && (
          <span style={{ fontSize: 12, color: BRAND.muted, padding: '2px 4px' }}>{emptyLabel}</span>
        )}
        {selectedUsers.map(u => (
          <span
            key={u.email}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '3px 4px 3px 3px', borderRadius: 999,
              background: '#F0F9FF', border: '1px solid #BAE6FD',
              fontSize: 12, fontWeight: 500, color: BRAND.ink,
            }}
          >
            <Avatar email={u.email} size={20} ring={false} />
            <span>{u.name || u.email}</span>
            <button type="button" onClick={() => onToggle(u.email)} title={`Remove ${u.name || u.email}`}
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'none',
                border: 'none', padding: 2, cursor: 'pointer', color: BRAND.muted, borderRadius: 999 }}>
              <X size={12} />
            </button>
          </span>
        ))}
        {remaining.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            title="Add a person"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', borderRadius: 999,
              background: 'white', border: '1px dashed ' + BRAND.border,
              fontSize: 12, fontWeight: 500, color: BRAND.muted, cursor: 'pointer',
            }}
          >
            <Plus size={13} /> Add
          </button>
        )}
      </div>

      {open && remaining.length > 0 && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 50,
            minWidth: 220, maxHeight: 240, overflowY: 'auto', padding: 4,
            background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10,
            boxShadow: '0 8px 24px rgba(15, 42, 61, 0.12)',
          }}
        >
          {remaining.map(u => (
            <button
              key={u.email}
              type="button"
              role="menuitem"
              onClick={() => { onToggle(u.email); if (remaining.length === 1) setOpen(false); }}
              onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '6px 8px', border: 'none', background: 'transparent', borderRadius: 8,
                cursor: 'pointer', fontSize: 13, color: BRAND.ink, textAlign: 'left',
              }}
            >
              <Avatar email={u.email} size={22} ring={false} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name || u.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Self-contained date + time picker with an explicit Done button, replacing the
// native <input type="datetime-local"> (whose popup the browser owns — no Done,
// fiddly to dismiss). Value/onChange use the same local "YYYY-MM-DDTHH:mm"
// string the rest of the form already speaks. New dates default to 08:00.
const DTP_WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DTP_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function parseLocalDT(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || '');
  if (!m) return null;
  return { y: +m[1], mo: +m[2] - 1, d: +m[3], h: +m[4], mi: +m[5] };
}
function fmtLocalDT({ y, mo, d, h, mi }) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(mo + 1)}-${pad(d)}T${pad(h)}:${pad(mi)}`;
}
function formatDTDisplay(value) {
  const p = parseLocalDT(value);
  if (!p) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(p.d)}/${pad(p.mo + 1)}/${p.y} ${pad(p.h)}:${pad(p.mi)}`;
}

function DateTimePicker({ value, onChange, defaultHour = 8 }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null); // { left, top } for the portalled popover
  const ref = useRef(null);     // the trigger (anchor)
  const popRef = useRef(null);  // the floating calendar
  const parsed = parseLocalDT(value);
  const now = new Date();
  const [viewY, setViewY] = useState(parsed ? parsed.y : now.getFullYear());
  const [viewMo, setViewMo] = useState(parsed ? parsed.mo : now.getMonth());
  const pad = (n) => String(n).padStart(2, '0');

  // Anchor the calendar to the field with fixed positioning so it floats above
  // the (scroll-clipped, max-height) modal instead of being cut off inside it.
  // Flip above when there isn't room below; clamp inside the viewport.
  const POP_W = 268, POP_H = 380;
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8));
    let top = r.bottom + 4;
    if (top + POP_H > window.innerHeight - 8) {
      const above = r.top - 4 - POP_H;
      top = above > 8 ? above : Math.max(8, window.innerHeight - POP_H - 8);
    }
    setPos({ left, top });
  };

  useEffect(() => {
    if (!open) return undefined;
    if (parsed) { setViewY(parsed.y); setViewMo(parsed.mo); }
    measure();
    const onDown = (e) => {
      if (ref.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    const reflow = () => measure();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, true); // capture: catch modal/ancestor scroll
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
      window.removeEventListener('resize', reflow);
      window.removeEventListener('scroll', reflow, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const time = parsed ? { h: parsed.h, mi: parsed.mi } : { h: defaultHour, mi: 0 };

  const pickDay = (day) => onChange(fmtLocalDT({ y: viewY, mo: viewMo, d: day, h: time.h, mi: time.mi }));
  const pickTime = (hhmm) => {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
    if (!m) return;
    const base = parsed || { y: viewY, mo: viewMo, d: now.getDate() };
    onChange(fmtLocalDT({ y: base.y, mo: base.mo, d: base.d, h: +m[1], mi: +m[2] }));
  };
  const goToday = () => {
    const t = new Date();
    setViewY(t.getFullYear()); setViewMo(t.getMonth());
    onChange(fmtLocalDT({ y: t.getFullYear(), mo: t.getMonth(), d: t.getDate(), h: time.h, mi: time.mi }));
  };
  const prevMonth = () => { const d = new Date(viewY, viewMo - 1, 1); setViewY(d.getFullYear()); setViewMo(d.getMonth()); };
  const nextMonth = () => { const d = new Date(viewY, viewMo + 1, 1); setViewY(d.getFullYear()); setViewMo(d.getMonth()); };

  // Quick presets. Commit the resulting datetime and move the calendar to it.
  const commit = (d) => {
    onChange(fmtLocalDT({ y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes() }));
    setViewY(d.getFullYear()); setViewMo(d.getMonth());
  };
  const inOneHour = () => commit(new Date(Date.now() + 60 * 60 * 1000));
  const inWorkingDays = (n) => {
    const d = new Date();
    d.setHours(time.h, time.mi, 0, 0);
    let added = 0;
    while (added < n) { d.setDate(d.getDate() + 1); const dow = d.getDay(); if (dow !== 0 && dow !== 6) added++; }
    commit(d);
  };
  const inDays = (n) => {
    const d = new Date();
    d.setHours(time.h, time.mi, 0, 0);
    d.setDate(d.getDate() + n);
    commit(d);
  };

  const firstWeekday = (new Date(viewY, viewMo, 1).getDay() + 6) % 7; // 0 = Monday
  const daysInMonth = new Date(viewY, viewMo + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const isSelected = (day) => parsed && parsed.y === viewY && parsed.mo === viewMo && parsed.d === day;
  const isToday = (day) => now.getFullYear() === viewY && now.getMonth() === viewMo && now.getDate() === day;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="input"
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
      >
        <Calendar size={15} color={BRAND.muted} />
        <span style={{ flex: 1, color: value ? BRAND.ink : BRAND.muted }}>{value ? formatDTDisplay(value) : 'No date set'}</span>
      </button>
      {open && pos && createPortal(
        <div ref={popRef} style={{
          position: 'fixed', top: pos.top, left: pos.left, zIndex: 4000, width: POP_W,
          maxHeight: 'calc(100vh - 16px)', overflowY: 'auto',
          background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10,
          boxShadow: '0 10px 30px rgba(15,42,61,0.18)', padding: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <button type="button" onClick={prevMonth} className="btn-icon" style={{ padding: 4 }} aria-label="Previous month"><ChevronLeft size={16} /></button>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{DTP_MONTHS[viewMo]} {viewY}</span>
            <button type="button" onClick={nextMonth} className="btn-icon" style={{ padding: 4 }} aria-label="Next month"><ChevronRight size={16} /></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 2 }}>
            {DTP_WEEKDAYS.map(w => <div key={w} style={{ textAlign: 'center', fontSize: 10, fontWeight: 700, color: BRAND.muted }}>{w}</div>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
            {cells.map((day, i) => day == null
              ? <div key={'b' + i} />
              : (
                <button
                  key={day}
                  type="button"
                  onClick={() => pickDay(day)}
                  style={{
                    height: 30, borderRadius: 6, cursor: 'pointer', fontSize: 12.5,
                    border: isToday(day) && !isSelected(day) ? '1px solid ' + BRAND.blue : '1px solid transparent',
                    background: isSelected(day) ? BRAND.blue : 'transparent',
                    color: isSelected(day) ? 'white' : BRAND.ink,
                    fontWeight: isSelected(day) ? 700 : 400,
                  }}
                >{day}</button>
              ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, paddingTop: 10, borderTop: '1px solid ' + BRAND.border }}>
            <span style={{ fontSize: 12, color: BRAND.muted }}>Time</span>
            <input
              type="time"
              value={`${pad(time.h)}:${pad(time.mi)}`}
              onChange={(e) => pickTime(e.target.value)}
              className="input"
              style={{ width: 'auto', flex: 1, padding: '6px 8px', fontSize: 13 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <QuickPreset label="1 hr" onClick={inOneHour} />
            <QuickPreset label="3 days" onClick={() => inWorkingDays(3)} />
            <QuickPreset label="1 week" onClick={() => inDays(7)} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" onClick={() => onChange('')} className="btn-ghost" style={{ fontSize: 12 }}>Clear</button>
              <button type="button" onClick={goToday} className="btn-ghost" style={{ fontSize: 12 }}>Today</button>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="btn" style={{ fontSize: 12 }}>Done</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// Compact quick-schedule chip for the date picker (1 hr / 3 days / 1 week).
function QuickPreset({ label, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 1, padding: '5px 4px', borderRadius: 999, cursor: 'pointer',
        fontFamily: 'inherit', fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap',
        border: '1px solid ' + (hover ? BRAND.blue : BRAND.border),
        background: hover ? BRAND.blue : BRAND.paper,
        color: hover ? 'white' : BRAND.ink,
        transition: 'background 100ms ease, border-color 100ms ease, color 100ms ease',
      }}
    >{label}</button>
  );
}

function Row({ label, children }) {
  return (
    <label style={{ fontSize: 13, fontWeight: 500, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span>{label}</span>
      {children}
    </label>
  );
}

// Convert an ISO timestamp into a value the <input type="datetime-local">
// accepts (YYYY-MM-DDTHH:mm in local time).
function isoToLocalInput(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localTomorrow() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setHours(8, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
