import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckSquare, ChevronDown, Pencil, Plus, Square, Trash2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { permissionsInclude } from '../../lib/permissions.js';
import { AvatarGroup } from '../Avatar.jsx';
import { TaskFormModal } from './TaskFormModal.jsx';

const TASK_FILTER_STORAGE_KEY = 'tasks_team_filter';

// A task's assignees — the multi-assignee array, falling back to the legacy
// single field.
function taskAssignees(t) {
  return Array.isArray(t.assigneeEmails) && t.assigneeEmails.length
    ? t.assigneeEmails
    : (t.assigneeEmail ? [t.assigneeEmail] : []);
}

export function TasksView({ onBack, onOpenDeal }) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();
  const [creating, setCreating] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  // Only users who can manage every task (Admin) may browse other people's
  // tasks; everyone else is server-scoped to their own and gets no team filter.
  const canSeeAllTasks = permissionsInclude(state.session?.permissions, 'tasks.manage_all');
  // Defaults to the current user ("My tasks"); '' = everyone. Persisted.
  const [memberFilter, setMemberFilter] = useState(() => {
    try {
      const stored = localStorage.getItem(TASK_FILTER_STORAGE_KEY);
      if (stored !== null) return stored;
    } catch {}
    return state.session?.email || '';
  });
  useEffect(() => {
    try { localStorage.setItem(TASK_FILTER_STORAGE_KEY, memberFilter); } catch {}
  }, [memberFilter]);

  useEffect(() => { actions.refreshTasks('all'); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tasks = state.tasks || [];
  const visibleTasks = useMemo(
    // Non-admins only have their own tasks loaded, so ignore the (hidden) member
    // filter entirely and show them all. Admins filter the workspace-wide list.
    () => (canSeeAllTasks && memberFilter ? tasks.filter((t) => taskAssignees(t).includes(memberFilter)) : tasks),
    [tasks, memberFilter, canSeeAllTasks],
  );
  const buckets = useMemo(() => bucketTasks(visibleTasks), [visibleTasks]);

  const memberOptions = Object.entries(state.users || {})
    .map(([email, u]) => ({ email, name: u.name || email }))
    .sort((a, b) => a.name.localeCompare(b.name));

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
          {canSeeAllTasks && (
            <div style={{ marginBottom: 12 }}>
              <TaskScopeFilter
                memberFilter={memberFilter}
                setMemberFilter={setMemberFilter}
                memberOptions={memberOptions}
                sessionEmail={state.session?.email}
                filteredCount={visibleTasks.length}
                totalCount={tasks.length}
              />
            </div>
          )}
          {visibleTasks.length === 0 ? (
            <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 32, textAlign: 'center', color: BRAND.muted }}>
              No tasks in this view.
            </div>
          ) : (
            <>
              <Bucket title="Overdue" tasks={buckets.overdue} accent="#D32F2F" actions={actions} state={state} onOpenDeal={onOpenDeal} onEdit={setEditingTask} />
              <Bucket title="To-do" tasks={buckets.todo} accent={BRAND.blue} actions={actions} state={state} onOpenDeal={onOpenDeal} onEdit={setEditingTask} />
              <Bucket title="Upcoming" tasks={buckets.upcoming} accent="#7C3AED" actions={actions} state={state} onOpenDeal={onOpenDeal} onEdit={setEditingTask} />
              <Bucket title="Completed" tasks={buckets.done} accent="#16A34A" actions={actions} state={state} onOpenDeal={onOpenDeal} onEdit={setEditingTask} collapsed />
            </>
          )}
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

// "My tasks" dropdown — defaults to the current user, opens a popover to pick
// another team member or all tasks. Mirrors the proposals list filter.
function TaskScopeFilter({ memberFilter, setMemberFilter, memberOptions, sessionEmail, filteredCount, totalCount }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  const selfName = memberOptions.find((m) => m.email === memberFilter)?.name || '';
  const heading = !memberFilter
    ? 'All tasks'
    : memberFilter === sessionEmail
    ? 'My tasks'
    : `${selfName.split(' ')[0] || 'Their'}'s tasks`;

  const choose = (email) => { setMemberFilter(email); setOpen(false); };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'transparent', border: 'none', padding: '4px 8px', margin: '-4px -8px',
          borderRadius: 6, cursor: 'pointer', font: 'inherit',
          fontSize: 13, fontWeight: 700, color: BRAND.ink, textTransform: 'uppercase', letterSpacing: 0.5,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = '#F1F5F9'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <span>{heading}</span>
        <ChevronDown size={14} style={{ opacity: 0.6 }} />
        {memberFilter && (
          <span style={{ color: BRAND.blue, textTransform: 'none', letterSpacing: 0, fontWeight: 500, marginLeft: 4 }}>
            · {filteredCount} of {totalCount}
          </span>
        )}
      </button>
      {open && (
        <div role="listbox" style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, background: 'white',
          border: '1px solid ' + BRAND.border, borderRadius: 8, boxShadow: '0 8px 24px rgba(15, 42, 61, 0.12)',
          minWidth: 220, padding: 4, zIndex: 50, maxHeight: 320, overflowY: 'auto',
        }}>
          <ScopeOption label="All tasks" selected={!memberFilter} onClick={() => choose('')} />
          {memberOptions.map((m) => (
            <ScopeOption
              key={m.email}
              label={m.email === sessionEmail ? `${m.name} (me)` : m.name}
              selected={memberFilter === m.email}
              onClick={() => choose(m.email)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ScopeOption({ label, selected, onClick }) {
  return (
    <button
      role="option"
      aria-selected={selected}
      onClick={onClick}
      style={{
        display: 'block', width: '100%', padding: '8px 10px',
        background: selected ? '#F1F5F9' : 'transparent', border: 'none', borderRadius: 6,
        cursor: 'pointer', font: 'inherit', fontSize: 13, color: BRAND.ink, textAlign: 'left',
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = '#F8FAFC'; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
    >
      {label}
    </button>
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
  // End of today (local) — tasks due after this are "Upcoming" rather than
  // due today.
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const endOfTodayMs = endOfToday.getTime();

  // Open tasks split three ways: Overdue (due time passed), To-do (due today or
  // undated) and Upcoming (due after today). Finished tasks go to Completed.
  const out = { overdue: [], todo: [], upcoming: [], done: [] };
  for (const t of tasks) {
    if (t.doneAt) { out.done.push(t); continue; }
    const dueMs = t.dueAt ? new Date(t.dueAt).getTime() : null;
    if (dueMs != null && dueMs < now) out.overdue.push(t);
    else if (dueMs != null && dueMs > endOfTodayMs) out.upcoming.push(t);
    else out.todo.push(t);
  }
  // Soonest-first for dated buckets; undated to-dos sink to the bottom.
  out.overdue.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  out.upcoming.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  out.todo.sort((a, b) => {
    if (!a.dueAt) return b.dueAt ? 1 : 0;
    if (!b.dueAt) return -1;
    return new Date(a.dueAt) - new Date(b.dueAt);
  });
  out.done.sort((a, b) => new Date(b.doneAt) - new Date(a.doneAt));
  return out;
}
