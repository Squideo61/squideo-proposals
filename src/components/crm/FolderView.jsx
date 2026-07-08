import React, { useEffect, useMemo, useState } from 'react';
import { FolderOpen, X, Mail, ChevronDown, Users, Pencil, Trash2, Check } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { Modal } from '../ui.jsx';
import { Avatar, AvatarGroup } from '../Avatar.jsx';
import { TaskFormModal, AssigneePicker } from './TaskFormModal.jsx';

// ── Shared: the folder's tasks (reused by the email side panel + FolderView) ──
// Reads folderDetail[folderId] from the store (loading it if absent) and renders
// the folder's open tasks with tick-to-complete + click-to-edit, a "+ Add task"
// button, and a collapsible completed list. Every mutation reloads the folder
// detail so counts + lists stay in step.
export function FolderTaskList({ folderId, seedTasks }) {
  const { state, actions } = useStore();
  const detail = state.folderDetail?.[folderId];
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    if (folderId && !detail) actions.loadFolderDetail(folderId).catch(() => {});
  }, [folderId]); // eslint-disable-line react-hooks/exhaustive-deps

  const tasks = detail?.tasks || seedTasks || [];
  const openTasks = tasks.filter(t => !t.doneAt);
  const doneTasks = tasks.filter(t => t.doneAt);
  const reload = () => actions.loadFolderDetail(folderId).catch(() => {});

  const toggle = (task) => { Promise.resolve(actions.toggleTask(task.id)).then(reload, reload); };

  return (
    <div>
      <Label>Tasks</Label>
      <div style={{ margin: '6px 0 6px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {openTasks.length === 0
          ? <Muted>No open tasks in this folder.</Muted>
          : openTasks.map(t => <FolderTaskRow key={t.id} task={t} onToggle={() => toggle(t)} onEdit={() => setEditing(t)} showAssignees />)}
      </div>
      <div style={{ marginBottom: doneTasks.length ? 8 : 4 }}>
        <button onClick={() => setCreating(true)} className="btn-ghost" style={{ fontSize: 12 }}>+ Add task</button>
      </div>

      {doneTasks.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          <button
            onClick={() => setShowDone(o => !o)}
            aria-expanded={showDone}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer', fontFamily: 'inherit' }}
          >
            <span style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Completed</span>
            <span style={{ fontSize: 10.5, fontWeight: 800, color: '#475569', background: '#EEF2F6', borderRadius: 999, padding: '1px 7px', lineHeight: 1.6 }}>{doneTasks.length}</span>
            <ChevronDown size={13} color={BRAND.muted} style={{ marginLeft: 'auto', transition: 'transform 150ms', transform: showDone ? 'none' : 'rotate(-90deg)' }} />
          </button>
          {showDone && (
            <div style={{ margin: '8px 0 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {doneTasks.map(t => <FolderTaskRow key={t.id} task={t} onToggle={() => toggle(t)} onEdit={() => setEditing(t)} done />)}
            </div>
          )}
        </div>
      )}

      {creating && (
        <TaskFormModal
          defaults={{ folderId }}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); reload(); }}
        />
      )}
      {editing && (
        <TaskFormModal
          task={editing}
          defaults={{ folderId }}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </div>
  );
}

function FolderTaskRow({ task, onToggle, onEdit, showAssignees, done }) {
  const assignees = Array.isArray(task.assigneeEmails) && task.assigneeEmails.length
    ? task.assigneeEmails
    : (task.assigneeEmail ? [task.assigneeEmail] : []);
  return (
    <div style={{ display: 'flex', gap: 6, fontSize: 12.5, alignItems: 'flex-start' }}>
      <button
        onClick={onToggle}
        title={done ? 'Mark not done' : 'Mark done'}
        aria-label={done ? 'Mark not done' : 'Mark done'}
        style={{
          flexShrink: 0, width: 14, height: 14, marginTop: 1, padding: 0,
          border: '1.5px solid ' + (done ? BRAND.blue : BRAND.muted), borderRadius: 3,
          background: done ? BRAND.blue : 'white', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {done && <Check size={10} color="white" />}
      </button>
      <button
        onClick={onEdit}
        title="Edit task"
        style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, color: BRAND.ink }}
      >
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: done ? 'line-through' : 'none', opacity: done ? 0.6 : 1 }}>{task.title}</div>
        {task.dueAt && !done && <div style={{ fontSize: 11, color: BRAND.muted }}>Due {new Date(task.dueAt).toLocaleDateString('en-GB')}</div>}
      </button>
      {showAssignees && assignees.length > 0 && (
        <div style={{ flexShrink: 0 }}><AvatarGroup emails={assignees} max={2} size={18} /></div>
      )}
    </div>
  );
}

// ── The full folder page (rendered in the Emails main pane) ──────────────────
export function FolderView({ folder, onOpenThread, onDeleted }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const detail = state.folderDetail?.[folder.id] || folder;
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(folder.name || '');
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    actions.loadFolderDetail(folder.id).catch(() => {});
  }, [folder.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const threads = detail.threads || [];
  // Default owner-only controls to HIDDEN until we positively know you own it
  // (both the list summary and the detail carry isOwner; a cold deep-link's
  // synthetic summary doesn't, so we wait for the load rather than flash them).
  const isOwner = detail.isOwner === true;
  const memberEmails = detail.memberEmails || folder.memberEmails || [];

  const saveName = async () => {
    const next = nameDraft.trim();
    setRenaming(false);
    if (!next || next === folder.name) return;
    try { await actions.updateEmailFolder(folder.id, { name: next }); }
    catch (e) { showMsg(e?.message || 'Could not rename folder'); }
  };

  const del = async () => {
    if (!window.confirm(`Delete the folder “${folder.name}”? Filed emails are just unfiled (not deleted); its tasks stay in your task list.`)) return;
    try { await actions.deleteEmailFolder(folder.id); showMsg('Folder deleted'); onDeleted?.(); }
    catch (e) { showMsg(e?.message || 'Could not delete folder'); }
  };

  const unfile = async (gmailThreadId) => {
    try { await actions.unfileThreadFromFolder({ folderId: folder.id, gmailThreadId }); }
    catch (e) { showMsg(e?.message || 'Could not remove email'); }
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <FolderOpen size={20} color={folder.color || BRAND.blue} />
        {renaming ? (
          <input
            autoFocus
            className="input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') { setRenaming(false); setNameDraft(folder.name); } }}
            onBlur={saveName}
            style={{ fontSize: 18, fontWeight: 700, width: 'auto', minWidth: 220 }}
          />
        ) : (
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{folder.name}</h1>
        )}
        {memberEmails.length > 0 && (
          <span title={'Shared with ' + memberEmails.join(', ')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <AvatarGroup emails={memberEmails} max={4} size={22} />
          </span>
        )}
        <div style={{ flex: 1 }} />
        {isOwner && (
          <>
            <button onClick={() => { setNameDraft(folder.name); setRenaming(true); }} className="btn-ghost" style={{ fontSize: 12 }} title="Rename folder"><Pencil size={13} /> Rename</button>
            <button onClick={() => setSharing(true)} className="btn-ghost" style={{ fontSize: 12 }} title="Share with teammates"><Users size={13} /> Share</button>
            <button onClick={del} className="btn-ghost is-danger" style={{ fontSize: 12 }} title="Delete folder"><Trash2 size={13} /> Delete</button>
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: 18, flexDirection: isMobile ? 'column' : 'row', alignItems: 'flex-start' }}>
        {/* Filed emails */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Label>Filed emails</Label>
          <div style={{ marginTop: 8 }}>
            {threads.length === 0 ? (
              <div style={{ color: BRAND.muted, fontSize: 13, padding: '18px 0', lineHeight: 1.5 }}>
                No emails filed here yet. Open an email, then use <strong style={{ color: BRAND.ink }}>“File in a folder”</strong> in the panel on the right to add it.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {threads.map(t => (
                  <FiledEmailRow key={t.gmailThreadId} thread={t} onOpen={() => onOpenThread?.(folder.id, t.gmailThreadId)} onUnfile={() => unfile(t.gmailThreadId)} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Tasks panel */}
        <div style={{
          width: isMobile ? '100%' : 320, flexShrink: 0,
          borderLeft: isMobile ? 'none' : '1px solid ' + BRAND.border,
          borderTop: isMobile ? '1px solid ' + BRAND.border : 'none',
          paddingLeft: isMobile ? 0 : 18, paddingTop: isMobile ? 14 : 0,
        }}>
          <FolderTaskList folderId={folder.id} seedTasks={detail.tasks} />
        </div>
      </div>

      {sharing && (
        <ShareFolderModal folder={detail} onClose={() => setSharing(false)} />
      )}
    </div>
  );
}

function FiledEmailRow({ thread, onOpen, onUnfile }) {
  const [hover, setHover] = useState(false);
  const who = (thread.participantEmails || [])[0] || '';
  const date = thread.lastMessageAt ? new Date(thread.lastMessageAt).toLocaleDateString('en-GB') : '';
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 8px', borderRadius: 8, background: hover ? BRAND.paper : 'transparent' }}
    >
      <Mail size={15} color={BRAND.muted} style={{ flexShrink: 0 }} />
      <button
        onClick={onOpen}
        style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {thread.subject || '(no subject)'}
        </div>
        {who && <div style={{ fontSize: 11.5, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{who}</div>}
      </button>
      {date && <span style={{ flexShrink: 0, fontSize: 11, color: BRAND.muted }}>{date}</span>}
      <button
        onClick={onUnfile}
        title="Remove from this folder"
        aria-label="Remove from this folder"
        style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: BRAND.muted, opacity: hover ? 1 : 0.35, display: 'flex' }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

// Owner-only share dialog: pick teammates to share the folder with.
function ShareFolderModal({ folder, onClose }) {
  const { state, actions, showMsg } = useStore();
  const [saving, setSaving] = useState(false);

  const me = (state.session?.email || '').toLowerCase();
  const users = useMemo(
    () => Object.values(state.users || {}).filter(u => u?.email && u.email.toLowerCase() !== me),
    [state.users, me],
  );
  // Members come back from the server lowercased; the picker keys off each
  // user's own (possibly mixed-case) email. Seed the selection from the user
  // records so an already-shared teammate matches and shows as selected.
  const [selected, setSelected] = useState(() => {
    const set = new Set((folder.memberEmails || []).map(e => String(e).toLowerCase()));
    return users.filter(u => set.has(u.email.toLowerCase())).map(u => u.email);
  });

  const toggle = (email) => setSelected(prev => prev.includes(email) ? prev.filter(e => e !== email) : [...prev, email]);

  const save = async () => {
    setSaving(true);
    try { await actions.updateEmailFolder(folder.id, { memberEmails: selected }); showMsg('Sharing updated'); onClose(); }
    catch (e) { showMsg(e?.message || 'Could not update sharing'); }
    finally { setSaving(false); }
  };

  return (
    <Modal onClose={onClose} fullScreenOnMobile>
      <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 700 }}>Share “{folder.name}”</h2>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
        This folder is private to you. Anyone you add can see the filed emails and set/complete tasks in it.
      </p>
      <AssigneePicker users={users} selected={selected} onToggle={toggle} emptyLabel="Not shared with anyone" />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
        <button onClick={onClose} className="btn-ghost">Cancel</button>
        <button onClick={save} className="btn" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

const Label = ({ children }) => <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{children}</div>;
const Muted = ({ children, style }) => <div style={{ fontSize: 12, color: BRAND.muted, lineHeight: 1.4, ...(style || {}) }}>{children}</div>;
