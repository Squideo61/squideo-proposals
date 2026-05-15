import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, CheckCircle2, ChevronDown, ChevronRight, Edit2, MoreVertical, Plus, Printer, Trash2, Undo2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { api } from '../../api.js';
import { Card, Empty } from './Card.jsx';
import { Modal } from '../ui.jsx';
import { AddRetainerModal } from './AddRetainerModal.jsx';
import { AddRetainerEntryModal } from './AddRetainerEntryModal.jsx';
import { openRetainerPrintWindow } from '../../utils/printRetainer.js';

function fmtMoney(n) {
  return '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtCredits(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

function fmtValue(retainer, n) {
  return retainer.allocationType === 'money'
    ? fmtMoney(n)
    : fmtCredits(n) + ' credits';
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function RetainersCard({ dealId, contacts }) {
  const { showMsg, state } = useStore();
  const perms = state?.session?.permissions || [];
  const isAdmin = perms.includes('*') || perms.includes('invoices.manage');
  const [rows, setRows] = useState(null);
  const [addingRetainer, setAddingRetainer] = useState(false);
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

  useEffect(() => { reload(); }, [reload]);

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
      title="Projects"
      count={totalProjects}
      action={
        <button onClick={() => setAddingRetainer(true)} className="btn-ghost">
          <Plus size={12} /> Add project
        </button>
      }
    >
      {!rows && <div style={{ padding: '12px 4px', fontSize: 13, color: BRAND.muted }}>Loading…</div>}
      {rows && rows.length === 0 && <Empty text="No projects yet — add one to start tracking work" />}
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
            />
          ))}
        </div>
      )}

      {addingRetainer && (
        <AddRetainerModal
          dealId={dealId}
          contacts={contacts}
          onClose={() => setAddingRetainer(false)}
          onSaved={() => { setAddingRetainer(false); reload(); }}
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

function RetainerSection({ retainer, isAdmin, onEdit, onLogWork, onPrint, onSetStatus, onDelete, onEntryDeleted }) {
  const { showMsg } = useStore();
  const status = retainer.status || 'active';
  const dimmed = status !== 'active';
  const [open, setOpen] = useState(!dimmed);
  const [menuOpen, setMenuOpen] = useState(false);

  const total = Number(retainer.allocationAmount) || 0;
  const used  = (retainer.entries || []).reduce((s, e) => s + Number(e.value || 0), 0);
  const remaining = total - used;
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const barColor = pct >= 90 ? '#DC2626' : pct >= 70 ? '#D97706' : '#16A34A';
  const remainingColor = remaining < 0 ? '#DC2626' : remaining === 0 ? BRAND.muted : '#16A34A';

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
          <div style={{ fontSize: 13, fontWeight: 700, color: remainingColor }}>{fmtValue(retainer, remaining)}</div>
          <div style={{ fontSize: 10, color: BRAND.muted }}>remaining</div>
        </div>
        <button onClick={onLogWork} className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px', whiteSpace: 'nowrap' }}>
          <Plus size={12} /> Log work
        </button>
        <ProjectMenu items={menuItems} open={menuOpen} onOpenChange={setMenuOpen} />
      </div>

      {open && (
        <div style={{ padding: 12 }}>
          {/* Progress bar */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: BRAND.muted, marginBottom: 4 }}>
              <span>Used: <strong style={{ color: BRAND.ink }}>{fmtValue(retainer, used)}</strong></span>
              <span>of <strong style={{ color: BRAND.ink }}>{fmtValue(retainer, total)}</strong></span>
            </div>
            <div style={{ background: BRAND.border, borderRadius: 4, height: 6, overflow: 'hidden' }}>
              <div style={{ background: barColor, height: 6, width: Math.min(100, pct) + '%', borderRadius: 4, transition: 'width 0.3s' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 11 }}>
              <span style={{ color: BRAND.muted }}>{Math.round(pct)}% used</span>
              <span style={{ fontWeight: 600, color: remainingColor }}>
                {remaining >= 0 ? fmtValue(retainer, remaining) + ' remaining' : fmtValue(retainer, Math.abs(remaining)) + ' over budget'}
              </span>
            </div>
          </div>

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
                    <td style={{ padding: '6px 6px', color: BRAND.ink, borderBottom: '1px solid ' + BRAND.border }}>{e.description}</td>
                    <td style={{ padding: '6px 6px', color: BRAND.ink, fontWeight: 600, textAlign: 'right', whiteSpace: 'nowrap', borderBottom: '1px solid ' + BRAND.border }}>
                      {fmtValue(retainer, e.value)}
                    </td>
                    <td style={{ padding: '6px 4px', borderBottom: '1px solid ' + BRAND.border }}>
                      <button
                        onClick={() => deleteEntry(e.id)}
                        className="btn-icon"
                        title="Remove entry"
                        style={{ padding: 4 }}
                      >
                        <Trash2 size={12} color={BRAND.muted} />
                      </button>
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
