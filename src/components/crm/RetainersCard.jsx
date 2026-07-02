import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, CheckCircle2, ChevronDown, ChevronRight, Coins, Edit2, ExternalLink, MoreVertical, Plus, Printer, Trash2, Undo2, X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { api } from '../../api.js';
import { Card, Empty } from './Card.jsx';
import { Modal } from '../ui.jsx';
import { AddRetainerModal } from './AddRetainerModal.jsx';
import { AddRetainerEntryModal } from './AddRetainerEntryModal.jsx';
import { openRetainerPrintWindow } from '../../utils/printRetainer.js';
import { fmtValue, fmtDate, creditBarMeta, CreditUsageBar } from './creditDisplay.jsx';

export function RetainersCard({ dealId, contacts, refreshKey, onOpenVideo }) {
  const { showMsg, state } = useStore();
  const perms = state?.session?.permissions || [];
  const isAdmin = perms.includes('*') || perms.includes('invoices.manage');
  const [rows, setRows] = useState(null);
  const [addingCredits, setAddingCredits] = useState(false);
  const [editingRetainer, setEditingRetainer] = useState(null);
  const [loggingEntry, setLoggingEntry] = useState(null);
  const [deletingRetainer, setDeletingRetainer] = useState(null);

  const reload = useCallback(() => {
    api.get('/api/crm/retainers?dealId=' + encodeURIComponent(dealId))
      .then(setRows)
      .catch((err) => {
        showMsg?.(err.message || 'Failed to load projects', 'error');
        setRows([]);
      });
  }, [dealId, showMsg]);

  // Reload on mount and whenever a video is added/removed elsewhere on the page
  // (refreshKey changes) so the credit balance and line items stay in sync.
  useEffect(() => { reload(); }, [reload, refreshKey]);

  const setStatus = useCallback(async (retainer, status) => {
    try {
      await api.patch('/api/crm/retainers/' + retainer.id, { status });
      const labels = { active: 'Project reopened', completed: 'Project marked complete', archived: 'Project archived' };
      showMsg?.(labels[status] || 'Project updated', 'success');
      reload();
    } catch (err) {
      showMsg?.(err.message || 'Failed to update project', 'error');
    }
  }, [reload, showMsg]);

  const totalProjects = rows?.length ?? null;

  return (
    <Card
      title="Credit Based Projects"
      count={totalProjects}
      action={
        <button onClick={() => setAddingCredits(true)} className="btn-ghost">
          <Coins size={12} /> Add credits
        </button>
      }
    >
      {!rows && <div style={{ padding: '12px 4px', fontSize: 13, color: BRAND.muted }}>Loading…</div>}
      {rows && rows.length === 0 && <Empty text="No credits added yet — use “Add credits” to start a credit-based project" />}
      {rows && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map(r => (
            <RetainerSection
              key={r.id}
              retainer={r}
              isAdmin={isAdmin}
              onEdit={() => setEditingRetainer(r)}
              onLogWork={() => setLoggingEntry(r)}
              onPrint={() => openRetainerPrintWindow(r)}
              onSetStatus={(status) => setStatus(r, status)}
              onDelete={() => setDeletingRetainer(r)}
              onEntryDeleted={reload}
              onOpenVideo={onOpenVideo}
            />
          ))}
        </div>
      )}

      {addingCredits && (
        <AddCreditsModal
          dealId={dealId}
          onClose={() => setAddingCredits(false)}
          onSaved={() => { setAddingCredits(false); reload(); }}
        />
      )}
      {editingRetainer && (
        <AddRetainerModal
          dealId={dealId}
          retainer={editingRetainer}
          contacts={contacts}
          onClose={() => setEditingRetainer(null)}
          onSaved={() => { setEditingRetainer(null); reload(); }}
        />
      )}
      {loggingEntry && (
        <AddRetainerEntryModal
          retainer={loggingEntry}
          onClose={() => setLoggingEntry(null)}
          onSaved={() => { setLoggingEntry(null); reload(); }}
        />
      )}
      {deletingRetainer && (
        <DeleteProjectModal
          retainer={deletingRetainer}
          onClose={() => setDeletingRetainer(null)}
          onDeleted={() => { setDeletingRetainer(null); reload(); }}
        />
      )}
    </Card>
  );
}

function StatusBadge({ status }) {
  if (status === 'completed') {
    return (
      <span style={{
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
        padding: '2px 6px', borderRadius: 4, background: '#DCFCE7', color: '#15803D',
      }}>Completed</span>
    );
  }
  if (status === 'archived') {
    return (
      <span style={{
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
        padding: '2px 6px', borderRadius: 4, background: '#E5E7EB', color: '#475569',
      }}>Archived</span>
    );
  }
  return null;
}

// Active-until-Signed-Off badge for a video-linked work entry.
function VideoStatusBadge({ status }) {
  const done = status === 'signed_off';
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
      padding: '1px 5px', borderRadius: 4,
      background: done ? '#DCFCE7' : '#DBEAFE',
      color: done ? '#15803D' : '#1D4ED8',
    }}>{done ? 'Signed off' : 'Active'}</span>
  );
}

// "Add credits" — creates the deal's credit project on first use, then tops it up.
function AddCreditsModal({ dealId, onClose, onSaved }) {
  const { showMsg, actions } = useStore();
  const [credits, setCredits] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    const n = Number(credits);
    if (!Number.isFinite(n) || n <= 0) { showMsg?.('Enter a positive number of credits', 'error'); return; }
    setSaving(true);
    try {
      await actions.addCreditProjectCredits(dealId, n);
      showMsg?.(`Added ${n} credit${n === 1 ? '' : 's'}`, 'success');
      onSaved?.();
    } catch (err) {
      showMsg?.(err.message || 'Failed to add credits', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} showClose={false}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Add credits</h2>
        <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
      </div>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'block' }}>
          <div style={{ fontSize: 11, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>Credits to add</div>
          <input
            type="number"
            step="1"
            min="0"
            value={credits}
            onChange={(e) => setCredits(e.target.value)}
            className="input"
            placeholder="e.g. 40"
            required
            autoFocus
          />
        </label>
        <div style={{ fontSize: 12, color: BRAND.muted }}>
          These credits become available for videos on this project to draw against.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={onClose} className="btn-ghost" disabled={saving}>Cancel</button>
          <button type="submit" className="btn" disabled={saving}>{saving ? 'Adding…' : 'Add credits'}</button>
        </div>
      </form>
    </Modal>
  );
}

function RetainerSection({ retainer, isAdmin, onEdit, onLogWork, onPrint, onSetStatus, onDelete, onEntryDeleted, onOpenVideo }) {
  const { showMsg } = useStore();
  const status = retainer.status || 'active';
  const dimmed = status !== 'active';
  const [open, setOpen] = useState(!dimmed);
  const [menuOpen, setMenuOpen] = useState(false);

  const used = (retainer.entries || []).reduce((s, e) => s + Number(e.value || 0), 0);
  const { remaining, remainingColor } = creditBarMeta(retainer.allocationAmount, used);

  async function deleteEntry(entryId) {
    if (!window.confirm('Remove this work entry?')) return;
    try {
      await api.delete('/api/crm/retainers/entries/' + encodeURIComponent(entryId));
      onEntryDeleted?.();
    } catch (err) {
      showMsg?.(err.message || 'Failed to delete entry', 'error');
    }
  }

  const menuItems = [
    { label: 'Edit',        icon: Edit2,   onClick: onEdit },
    { label: 'Print / PDF', icon: Printer, onClick: onPrint },
  ];
  if (status === 'active') {
    menuItems.push({ label: 'Mark complete', icon: CheckCircle2,   onClick: () => onSetStatus('completed') });
    menuItems.push({ label: 'Archive',       icon: Archive,        onClick: () => onSetStatus('archived')  });
  } else if (status === 'completed') {
    menuItems.push({ label: 'Reopen',  icon: Undo2,    onClick: () => onSetStatus('active')   });
    menuItems.push({ label: 'Archive', icon: Archive,  onClick: () => onSetStatus('archived') });
  } else if (status === 'archived') {
    menuItems.push({ label: 'Unarchive', icon: ArchiveRestore, onClick: () => onSetStatus('active') });
  }
  if (isAdmin) {
    menuItems.push({ label: 'Delete', icon: Trash2, onClick: onDelete, danger: true });
  }

  return (
    <div style={{
      border: '1px solid ' + BRAND.border,
      borderRadius: 8,
      overflow: 'hidden',
      opacity: dimmed ? 0.65 : 1,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 12px', background: BRAND.paper,
        borderBottom: open ? '1px solid ' + BRAND.border : 'none',
      }}>
        <button
          onClick={() => setOpen(v => !v)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', color: BRAND.muted }}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: BRAND.ink }}>{retainer.title}</span>
            <StatusBadge status={status} />
          </div>
          {retainer.contactName && (
            <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 1 }}>{retainer.contactName}</div>
          )}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: remainingColor }}>{fmtValue(retainer.allocationType, remaining)}</div>
          <div style={{ fontSize: 10, color: BRAND.muted }}>remaining</div>
        </div>
        <button
          onClick={onLogWork}
          className="btn-ghost"
          style={{ fontSize: 12, padding: '4px 10px', whiteSpace: 'nowrap', background: '#16A34A', color: 'white', border: 'none' }}
        >
          <Plus size={12} /> Log work
        </button>
        <ProjectMenu items={menuItems} open={menuOpen} onOpenChange={setMenuOpen} />
      </div>

      {open && (
        <div style={{ padding: 12 }}>
          {/* Progress bar */}
          <CreditUsageBar allocationType={retainer.allocationType} total={retainer.allocationAmount} used={used} />

          {/* Work log */}
          {retainer.entries.length === 0 ? (
            <div style={{ fontSize: 12, color: BRAND.muted, fontStyle: 'italic', padding: '4px 0' }}>No work logged yet</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '4px 6px', color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.4, borderBottom: '1px solid ' + BRAND.border }}>Date</th>
                  <th style={{ textAlign: 'left', padding: '4px 6px', color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.4, borderBottom: '1px solid ' + BRAND.border }}>Description</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px', color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.4, borderBottom: '1px solid ' + BRAND.border }}>
                    {retainer.allocationType === 'money' ? 'Value' : 'Credits'}
                  </th>
                  <th style={{ width: 28, borderBottom: '1px solid ' + BRAND.border }} />
                </tr>
              </thead>
              <tbody>
                {retainer.entries.map(e => (
                  <tr key={e.id}>
                    <td style={{ padding: '6px 6px', color: BRAND.muted, whiteSpace: 'nowrap', borderBottom: '1px solid ' + BRAND.border }}>{fmtDate(e.workedAt)}</td>
                    <td style={{ padding: '6px 6px', color: BRAND.ink, borderBottom: '1px solid ' + BRAND.border }}>
                      {e.videoId ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <button
                            onClick={() => onOpenVideo?.(e.videoId)}
                            title="Open video"
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: BRAND.blue, fontWeight: 600, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'inherit' }}
                          >
                            {e.description} <ExternalLink size={11} />
                          </button>
                          <VideoStatusBadge status={e.status} />
                        </span>
                      ) : e.description}
                    </td>
                    <td style={{ padding: '6px 6px', color: BRAND.ink, fontWeight: 600, textAlign: 'right', whiteSpace: 'nowrap', borderBottom: '1px solid ' + BRAND.border }}>
                      {fmtValue(retainer.allocationType, e.value)}
                    </td>
                    <td style={{ padding: '6px 4px', borderBottom: '1px solid ' + BRAND.border }}>
                      {/* Video-linked entries are managed from the video (delete the
                          video to refund its credits), so no manual remove here. */}
                      {!e.videoId && (
                        <button
                          onClick={() => deleteEntry(e.id)}
                          className="btn-icon"
                          title="Remove entry"
                          style={{ padding: 4 }}
                        >
                          <Trash2 size={12} color={BRAND.muted} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {retainer.notes && (
            <div style={{ marginTop: 10, fontSize: 12, color: BRAND.muted, fontStyle: 'italic' }}>{retainer.notes}</div>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectMenu({ items, open, onOpenChange }) {
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const place = () => {
      const r = buttonRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (buttonRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      onOpenChange(false);
    };
    const closeOnEsc = (e) => { if (e.key === 'Escape') onOpenChange(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEsc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeOnEsc);
    };
  }, [open, onOpenChange]);

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => onOpenChange(!open)}
        className="btn-icon"
        title="More actions"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ padding: 6 }}
      >
        <MoreVertical size={14} color={BRAND.muted} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{
            position: 'fixed',
            top: pos.top,
            right: pos.right,
            background: 'white',
            border: '1px solid ' + BRAND.border,
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(15, 42, 61, 0.12)',
            minWidth: 180,
            padding: 4,
            zIndex: 2500,
          }}
        >
          {items.map((item, i) => (
            <button
              key={i}
              role="menuitem"
              onClick={() => { onOpenChange(false); item.onClick(); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '8px 10px',
                background: 'transparent',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 500,
                color: item.danger ? '#D32F2F' : BRAND.ink,
                textAlign: 'left',
                fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = item.danger ? '#FFEBEE' : '#F1F5F9'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <item.icon size={14} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

function DeleteProjectModal({ retainer, onClose, onDeleted }) {
  const { showMsg } = useStore();
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const matches = confirmText.trim() === retainer.title.trim();

  async function handleDelete() {
    if (!matches) return;
    setDeleting(true);
    try {
      await api.delete('/api/crm/retainers/' + retainer.id);
      showMsg?.('Project deleted', 'success');
      onDeleted?.();
    } catch (err) {
      showMsg?.(err.message || 'Failed to delete', 'error');
      setDeleting(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#D32F2F' }}>Delete project</h2>
      <p style={{ fontSize: 13, color: BRAND.ink, marginTop: 12, marginBottom: 4 }}>
        This will permanently delete <strong>{retainer.title}</strong> and all its work log entries. This cannot be undone.
      </p>
      <p style={{ fontSize: 12, color: BRAND.muted, marginTop: 12, marginBottom: 4 }}>
        Type the project name to confirm:
      </p>
      <input
        type="text"
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        className="input"
        placeholder={retainer.title}
        autoFocus
        style={{ marginTop: 4 }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button type="button" onClick={onClose} className="btn-ghost" disabled={deleting}>Cancel</button>
        <button
          type="button"
          onClick={handleDelete}
          className="btn-ghost is-danger"
          disabled={!matches || deleting}
        >
          {deleting ? 'Deleting…' : 'Delete project'}
        </button>
      </div>
    </Modal>
  );
}
