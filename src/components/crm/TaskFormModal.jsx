import React, { useMemo, useState, useRef, useEffect } from 'react';
import { Trash2, X, Plus } from 'lucide-react';
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
export function TaskFormModal({ task, defaults, onClose, onSaved, submitLabel }) {
  const { state, actions } = useStore();
  const editing = !!task;
  const [title, setTitle] = useState(task?.title || defaults?.title || '');
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

  const allUsers = Object.values(state.users || {});
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
    <Modal onClose={onClose}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>{editing ? 'Edit task' : 'New task'}</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Row label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Call Sarah" autoFocus required />
        </Row>
        <Row label="Due">
          <input className="input" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
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
