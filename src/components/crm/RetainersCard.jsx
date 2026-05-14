import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Edit2, Plus, Printer, Trash2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { api } from '../../api.js';
import { Card, Empty } from './Card.jsx';
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
  const { showMsg } = useStore();
  const [rows, setRows] = useState(null);
  const [addingRetainer, setAddingRetainer] = useState(false);
  const [editingRetainer, setEditingRetainer] = useState(null);
  const [loggingEntry, setLoggingEntry] = useState(null);

  const reload = useCallback(() => {
    api.get('/api/crm/retainers?dealId=' + encodeURIComponent(dealId))
      .then(setRows)
      .catch((err) => {
        showMsg?.(err.message || 'Failed to load projects', 'error');
        setRows([]);
      });
  }, [dealId, showMsg]);

  useEffect(() => { reload(); }, [reload]);

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
              onEdit={() => setEditingRetainer(r)}
              onLogWork={() => setLoggingEntry(r)}
              onPrint={() => openRetainerPrintWindow(r)}
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
          onDeleted={() => { setEditingRetainer(null); reload(); }}
        />
      )}
      {loggingEntry && (
        <AddRetainerEntryModal
          retainer={loggingEntry}
          onClose={() => setLoggingEntry(null)}
          onSaved={() => { setLoggingEntry(null); reload(); }}
        />
      )}
    </Card>
  );
}

function RetainerSection({ retainer, onEdit, onLogWork, onPrint, onEntryDeleted }) {
  const { showMsg } = useStore();
  const [open, setOpen] = useState(true);

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

  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden' }}>
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
          <div style={{ fontSize: 14, fontWeight: 600, color: BRAND.ink }}>{retainer.title}</div>
          {retainer.contactName && (
            <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 1 }}>{retainer.contactName}</div>
          )}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: remainingColor }}>{fmtValue(retainer, remaining)}</div>
          <div style={{ fontSize: 10, color: BRAND.muted }}>remaining</div>
        </div>
        <button onClick={onPrint} className="btn-icon" title="Print / PDF summary" style={{ padding: 6 }}>
          <Printer size={14} color={BRAND.muted} />
        </button>
        <button onClick={onLogWork} className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px', whiteSpace: 'nowrap' }}>
          <Plus size={12} /> Log work
        </button>
        <button onClick={onEdit} className="btn-icon" title="Edit project" style={{ padding: 6 }}>
          <Edit2 size={14} color={BRAND.muted} />
        </button>
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
