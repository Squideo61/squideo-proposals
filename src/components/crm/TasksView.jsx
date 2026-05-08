import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckSquare, Plus, Square, Trash2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { Modal } from '../ui.jsx';

export function TasksView({ onBack, onOpenDeal }) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();
  const [creating, setCreating] = useState(false);

  useEffect(() => { actions.refreshTasks('all'); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tasks = state.tasks || [];
  const buckets = useMemo(() => bucketTasks(tasks), [tasks]);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <CheckSquare size={22} color={BRAND.blue} />
            Tasks
          </h1>
        </div>
        <button onClick={() => setCreating(true)} className="btn"><Plus size={16} /> New task</button>
      </header>

      {tasks.length === 0 ? (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 40, textAlign: 'center', color: BRAND.muted }}>
          No tasks yet. Create one to get reminders by email.
        </div>
      ) : (
        <>
          <Bucket title="Overdue" tasks={buckets.overdue} accent="#D32F2F" actions={actions} state={state} onOpenDeal={onOpenDeal} />
          <Bucket title="Today" tasks={buckets.today} accent={BRAND.blue} actions={actions} state={state} onOpenDeal={onOpenDeal} />
          <Bucket title="Upcoming (7 days)" tasks={buckets.soon} accent="#7C3AED" actions={actions} state={state} onOpenDeal={onOpenDeal} />
          <Bucket title="Later" tasks={buckets.later} accent="#94A3B8" actions={actions} state={state} onOpenDeal={onOpenDeal} />
          <Bucket title="No due date" tasks={buckets.someday} accent="#94A3B8" actions={actions} state={state} onOpenDeal={onOpenDeal} />
          <Bucket title="Done" tasks={buckets.done} accent="#16A34A" actions={actions} state={state} onOpenDeal={onOpenDeal} collapsed />
        </>
      )}

      {creating && <NewTaskModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function Bucket({ title, tasks, accent, actions, state, onOpenDeal, collapsed: collapsedDefault }) {
  const [collapsed, setCollapsed] = useState(!!collapsedDefault);
  if (!tasks.length) return null;
  return (
    <div style={{ marginBottom: 16, background: 'white', border: '1px solid ' + BRAND.border, borderLeft: '4px solid ' + accent, borderRadius: 10, overflow: 'hidden' }}>
      <button
        onClick={() => setCollapsed(c => !c)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '10px 16px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
      >
        <h3 style={{ margin: 0, fontSize: 12, fontWeight: 700, color: accent, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          {title} <span style={{ color: BRAND.muted, marginLeft: 6 }}>· {tasks.length}</span>
        </h3>
        <span style={{ fontSize: 12, color: BRAND.muted }}>{collapsed ? 'Show' : 'Hide'}</span>
      </button>
      {!collapsed && tasks.map(t => <TaskRow key={t.id} task={t} actions={actions} state={state} onOpenDeal={onOpenDeal} />)}
    </div>
  );
}

function TaskRow({ task, actions, state, onOpenDeal }) {
  const done = !!task.doneAt;
  const Icon = done ? CheckSquare : Square;
  const deal = task.dealId ? state.deals[task.dealId] : null;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 16px', borderTop: '1px solid ' + BRAND.border }}>
      <button onClick={() => actions.toggleTask(task.id)} className="btn-icon" style={{ padding: 4, border: 'none', background: 'transparent' }} aria-label={done ? 'Mark not done' : 'Mark done'}>
        <Icon size={16} color={done ? '#16A34A' : BRAND.muted} />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, textDecoration: done ? 'line-through' : 'none', color: done ? BRAND.muted : BRAND.ink }}>{task.title}</div>
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {task.dueAt && <span>Due {new Date(task.dueAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>}
          {deal && (
            <button onClick={() => onOpenDeal?.(deal.id)} style={{ background: 'transparent', border: 'none', color: BRAND.blue, cursor: 'pointer', padding: 0, fontFamily: 'inherit', fontSize: 12 }}>
              · {deal.title}
            </button>
          )}
          {task.assigneeEmail && <span>· {task.assigneeEmail}</span>}
        </div>
        {task.notes && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>{task.notes}</div>}
      </div>
      <button onClick={() => { if (window.confirm('Delete this task?')) actions.deleteTask(task.id); }} className="btn-icon is-danger" aria-label="Delete task" style={{ padding: 6 }}>
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function NewTaskModal({ onClose }) {
  const { state, actions } = useStore();
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState(localTomorrow());
  const [assigneeEmail, setAssigneeEmail] = useState(state.session?.email || '');
  const [dealId, setDealId] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const users = Object.values(state.users || {});
  const deals = Object.values(state.deals || {});

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    await actions.createTask({
      title: title.trim(),
      dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      assigneeEmail: assigneeEmail || null,
      dealId: dealId || null,
      notes: notes.trim() || null,
    });
    setSubmitting(false);
    onClose();
  };

  return (
    <Modal onClose={onClose}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>New task</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Row label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Follow up with Sarah" autoFocus required /></Row>
        <Row label="Due"><input className="input" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></Row>
        <Row label="Assignee">
          <select className="input" value={assigneeEmail} onChange={(e) => setAssigneeEmail(e.target.value)}>
            {users.map(u => <option key={u.email} value={u.email}>{u.name || u.email}</option>)}
          </select>
        </Row>
        <Row label="Deal (optional)">
          <select className="input" value={dealId} onChange={(e) => setDealId(e.target.value)}>
            <option value="">—</option>
            {deals.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
          </select>
        </Row>
        <Row label="Notes"><textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ fontFamily: 'inherit', resize: 'vertical' }} /></Row>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={!title.trim() || submitting}>{submitting ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </Modal>
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

function bucketTasks(tasks) {
  const now = Date.now();
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday); endOfToday.setDate(endOfToday.getDate() + 1);
  const sevenOut = new Date(startOfToday); sevenOut.setDate(sevenOut.getDate() + 7);

  const out = { overdue: [], today: [], soon: [], later: [], someday: [], done: [] };
  for (const t of tasks) {
    if (t.doneAt) { out.done.push(t); continue; }
    if (!t.dueAt) { out.someday.push(t); continue; }
    const due = new Date(t.dueAt).getTime();
    if (due < startOfToday.getTime()) out.overdue.push(t);
    else if (due < endOfToday.getTime()) out.today.push(t);
    else if (due < sevenOut.getTime()) out.soon.push(t);
    else out.later.push(t);
  }
  // Sort each non-done bucket by due ascending
  for (const k of ['overdue', 'today', 'soon', 'later']) out[k].sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  out.done.sort((a, b) => new Date(b.doneAt) - new Date(a.doneAt));
  return out;
}

function localTomorrow() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setHours(9, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
