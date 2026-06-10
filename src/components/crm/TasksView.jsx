import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckSquare, Pencil, Plus, Square, Trash2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { AvatarGroup } from '../Avatar.jsx';
import { TaskFormModal } from './TaskFormModal.jsx';

export function TasksView({ onBack, onOpenDeal }) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();
  const [creating, setCreating] = useState(false);
  const [editingTask, setEditingTask] = useState(null);

  useEffect(() => { actions.refreshTasks('all'); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tasks = state.tasks || [];
  const buckets = useMemo(() => bucketTasks(tasks), [tasks]);

  return (
    <div style={{ padding: isMobile ? '16px 12px' : '32px 24px' }}>
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
          <Bucket title="Overdue" tasks={buckets.overdue} accent="#D32F2F" actions={actions} state={state} onOpenDeal={onOpenDeal} onEdit={setEditingTask} />
          <Bucket title="To-do" tasks={buckets.todo} accent={BRAND.blue} actions={actions} state={state} onOpenDeal={onOpenDeal} onEdit={setEditingTask} />
          <Bucket title="Completed" tasks={buckets.done} accent="#16A34A" actions={actions} state={state} onOpenDeal={onOpenDeal} onEdit={setEditingTask} collapsed />
        </>
      )}

      {creating && (
        <TaskFormModal
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); actions.refreshTasks('all'); }}
        />
      )}
      {editingTask && (
        <TaskFormModal
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSaved={() => { setEditingTask(null); actions.refreshTasks('all'); }}
        />
      )}
    </div>
  );
}

function Bucket({ title, tasks, accent, actions, state, onOpenDeal, onEdit, collapsed: collapsedDefault }) {
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
      {!collapsed && tasks.map(t => <TaskRow key={t.id} task={t} actions={actions} state={state} onOpenDeal={onOpenDeal} onEdit={onEdit} />)}
    </div>
  );
}

function TaskRow({ task, actions, state, onOpenDeal, onEdit }) {
  const done = !!task.doneAt;
  const Icon = done ? CheckSquare : Square;
  const deal = task.dealId ? state.deals[task.dealId] : null;
  const stop = (e) => e.stopPropagation();
  const overdue = !done && task.dueAt && new Date(task.dueAt).getTime() < Date.now();
  const assignees = Array.isArray(task.assigneeEmails) && task.assigneeEmails.length
    ? task.assigneeEmails
    : (task.assigneeEmail ? [task.assigneeEmail] : []);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 16px', borderTop: '1px solid ' + BRAND.border }}>
      <button onClick={() => actions.toggleTask(task.id)} className="btn-icon" style={{ padding: 4, border: 'none', background: 'transparent' }} aria-label={done ? 'Mark not done' : 'Mark done'}>
        <Icon size={16} color={done ? '#16A34A' : BRAND.muted} />
      </button>
      <button
        onClick={() => (deal ? onOpenDeal?.(deal.id) : onEdit?.(task))}
        title={deal ? `Open ${deal.title}` : 'Edit task'}
        style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit' }}
      >
        <div style={{ fontSize: 14, fontWeight: 500, textDecoration: done ? 'line-through' : 'none', color: done ? BRAND.muted : BRAND.ink, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span>{task.title}</span>
          {overdue && (
            <span style={{
              display: 'inline-block', padding: '1px 6px', borderRadius: 3,
              background: '#FEE2E2', color: '#DC2626',
              fontSize: 10, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase',
            }}>Overdue</span>
          )}
        </div>
        <div style={{ fontSize: 12, marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap', color: BRAND.muted }}>
          {task.dueAt && (
            <span style={{ color: overdue ? '#DC2626' : BRAND.muted, fontWeight: overdue ? 600 : 400 }}>
              Due {new Date(task.dueAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
          )}
          {deal && (
            <span
              role="link"
              onClick={(e) => { stop(e); onOpenDeal?.(deal.id); }}
              style={{ color: BRAND.blue, cursor: 'pointer' }}
            >
              · {deal.title}
            </span>
          )}
        </div>
        {task.notes && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>{task.notes}</div>}
      </button>
      {assignees.length > 0 && (
        <div style={{ flexShrink: 0, alignSelf: 'center' }}>
          <AvatarGroup emails={assignees} max={3} size={24} />
        </div>
      )}
      <button
        onClick={(e) => { stop(e); onEdit?.(task); }}
        className="btn-icon"
        aria-label="Edit task"
        title="Edit task"
        style={{ padding: 6 }}
      >
        <Pencil size={14} />
      </button>
      <button
        onClick={(e) => { stop(e); if (window.confirm('Delete this task?')) actions.deleteTask(task.id); }}
        className="btn-icon is-danger"
        aria-label="Delete task"
        style={{ padding: 6 }}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function bucketTasks(tasks) {
  const now = Date.now();

  // Three buckets: everything still open is either Overdue (due time passed) or
  // To-do; finished tasks go to Completed.
  const out = { overdue: [], todo: [], done: [] };
  for (const t of tasks) {
    if (t.doneAt) { out.done.push(t); continue; }
    if (t.dueAt && new Date(t.dueAt).getTime() < now) out.overdue.push(t);
    else out.todo.push(t);
  }
  // Overdue oldest-first; to-do soonest-first (undated tasks sink to the bottom).
  out.overdue.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  out.todo.sort((a, b) => {
    if (!a.dueAt) return b.dueAt ? 1 : 0;
    if (!b.dueAt) return -1;
    return new Date(a.dueAt) - new Date(b.dueAt);
  });
  out.done.sort((a, b) => new Date(b.doneAt) - new Date(a.doneAt));
  return out;
}
