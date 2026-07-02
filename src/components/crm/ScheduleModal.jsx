import React, { useMemo, useState } from 'react';
import { Calendar, Eraser, ListChecks, FileDown, Check } from 'lucide-react';
import { Modal } from '../ui.jsx';
import { Card, Empty } from './Card.jsx';
import { DateTimePicker, formatDTDisplay } from './TaskFormModal.jsx';
import { useStore } from '../../store.jsx';
import { BRAND } from '../../theme.js';
import {
  seedSchedule, autofillFromKickOff, enabledRows, FIELD_LABELS, FIELD_ORDER,
} from '../../lib/scheduleTemplate.js';
import { openSchedulePrintWindow } from '../../utils/printSchedule.js';

// ── Summary card shown on the deal/project page ──
// Compact read-only view of the enabled schedule; the whole card opens the modal.
export function ScheduleCard({ deal, onOpen }) {
  const schedule = deal.productionSchedule;
  const rows = schedule ? enabledRows(schedule) : [];
  const kickOff = schedule?.kickOff ? formatDTDisplay(schedule.kickOff) : null;

  const summary = useMemo(() => {
    if (!schedule) return [];
    const find = (rowId, field) => {
      for (const { row } of rows) if (row.id === rowId) return row[field] || '';
      return '';
    };
    return [
      { label: 'Kick Off', value: kickOff },
      { label: 'Script & Text Delivery', value: fmt(find('script_text_direction', 'deliveredBy')) },
      { label: 'Visuals delivered by', value: fmt(find('storyboard', 'deliveredBy')) },
      { label: 'Production by', value: fmt(find('video', 'deliveredBy')) },
    ];
  }, [schedule, rows, kickOff]);

  return (
    <Card
      title="Schedule"
      action={<button className="btn-ghost" onClick={onOpen}><Calendar size={14} /> {schedule ? 'Edit schedule' : 'Set up schedule'}</button>}
    >
      {!schedule ? (
        <button onClick={onOpen} style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}>
          <Empty text="No schedule set yet — click to fill in dates for each stage." />
        </button>
      ) : (
        <button onClick={onOpen} style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            {summary.map(s => (
              <div key={s.label}>
                <div style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>{s.label}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: s.value ? BRAND.ink : BRAND.muted }}>{s.value || '—'}</div>
              </div>
            ))}
          </div>
          {schedule.syncedAt && (
            <div style={{ marginTop: 10, fontSize: 11, color: BRAND.muted }}>
              Milestones last synced {new Date(schedule.syncedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
            </div>
          )}
        </button>
      )}
    </Card>
  );
}

function fmt(local) { return local ? formatDTDisplay(local) : ''; }

// ── The editable, doc-like popout ──
export function ScheduleModal({ deal, dealId, company, primaryContact, onClose }) {
  const { actions, showMsg } = useStore();
  const [schedule, setSchedule] = useState(() => deal.productionSchedule || seedSchedule(deal));
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const update = (fn) => setSchedule(prev => fn(structuredClone(prev)));

  const setKickOff = (val) => update(s => {
    s.kickOff = val;
    return s.autoFill ? autofillFromKickOff(s) : s;
  });
  const toggleAutoFill = () => update(s => {
    s.autoFill = !s.autoFill;
    return s.autoFill ? autofillFromKickOff(s) : s;
  });
  const clearDates = () => update(s => {
    // Reset every stage date back to unassigned. Turn off auto-fill so they
    // stay blank (otherwise the next Kick Off change would re-derive them).
    for (const section of s.sections) for (const row of section.rows) {
      row.deliveredBy = ''; row.feedbackBy = ''; row.revisedBy = '';
    }
    s.autoFill = false;
    return s;
  });
  const setSection = (sid, patch) => update(s => {
    const sec = s.sections.find(x => x.id === sid); if (sec) Object.assign(sec, patch);
    return s;
  });
  const setRow = (sid, rid, patch) => update(s => {
    const sec = s.sections.find(x => x.id === sid);
    const row = sec?.rows.find(x => x.id === rid); if (row) Object.assign(row, patch);
    return s;
  });

  const persist = () => actions.saveDeal(dealId, { productionSchedule: schedule });

  const save = async () => {
    setSaving(true);
    try { await persist(); onClose(); }
    finally { setSaving(false); }
  };

  const moveToMilestones = async () => {
    setSyncing(true);
    try {
      await persist();
      const resp = await actions.syncMilestones(dealId);
      const parts = [];
      if (resp?.created) parts.push(`${resp.created} created`);
      if (resp?.updated) parts.push(`${resp.updated} updated`);
      if (resp?.removed) parts.push(`${resp.removed} removed`);
      showMsg(`Milestones: ${parts.join(' · ') || 'up to date'}`);
      onClose();
    } catch { /* toast handled in action */ }
    finally { setSyncing(false); }
  };

  const exportDoc = async () => {
    await persist();
    const ok = openSchedulePrintWindow(schedule, deal, company, primaryContact);
    if (!ok) showMsg('Pop-up blocked — allow pop-ups to export the schedule.');
  };

  const activeFields = FIELD_ORDER; // column headers are per-row, but keep order fixed

  return (
    <Modal onClose={onClose} maxWidth={900} showClose>
      <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 700 }}>Production Schedule</h2>
      <div style={{ fontSize: 13, color: BRAND.muted, marginBottom: 18 }}>{company?.name || deal.title}</div>

      {/* Kick Off + auto-fill controls */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 16, padding: '14px 16px', background: BRAND.paper, borderRadius: 10, marginBottom: 18 }}>
        <div style={{ minWidth: 220 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Kick Off</div>
          <DateTimePicker value={schedule.kickOff} onChange={setKickOff} defaultHour={9} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!schedule.autoFill} onChange={toggleAutoFill} />
          Auto-fill dates from Kick Off (working days)
        </label>
        <button type="button" className="btn-ghost" onClick={clearDates} title="Clear all stage dates back to unassigned">
          <Eraser size={14} /> Clear dates
        </button>
      </div>

      {/* Sections */}
      {schedule.sections.map(section => (
        <div key={section.id} style={{ marginBottom: 18, border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden', opacity: section.enabled ? 1 : 0.55 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#EAF6FB' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
              <input type="checkbox" checked={section.enabled} onChange={e => setSection(section.id, { enabled: e.target.checked })} />
              {section.label}
            </label>
          </div>
          <div style={{ padding: 12 }}>
            {section.rows.map(row => (
              <div key={row.id} style={{ padding: '10px 4px', borderTop: '1px solid ' + BRAND.border, opacity: row.enabled ? 1 : 0.5 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, marginBottom: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={row.enabled} disabled={!section.enabled} onChange={e => setRow(section.id, row.id, { enabled: e.target.checked })} />
                  {row.label}
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                  {activeFields.filter(f => row.fields.includes(f)).map(field => (
                    <div key={field}>
                      <div style={{ fontSize: 11, color: BRAND.muted, marginBottom: 3 }}>{FIELD_LABELS[field]}</div>
                      <div style={{ pointerEvents: (row.enabled && section.enabled) ? 'auto' : 'none' }}>
                        <DateTimePicker
                          value={row[field]}
                          onChange={val => setRow(section.id, row.id, { [field]: val })}
                          defaultHour={17}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Actions */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'flex-end', marginTop: 8, paddingTop: 16, borderTop: '1px solid ' + BRAND.border }}>
        <button type="button" className="btn-ghost" onClick={exportDoc}><FileDown size={15} /> Export to doc</button>
        <button type="button" className="btn-ghost" onClick={moveToMilestones} disabled={syncing}>
          <ListChecks size={15} /> {syncing ? 'Moving…' : 'Move to milestones'}
        </button>
        <button type="button" className="btn" onClick={save} disabled={saving}>
          <Check size={15} /> {saving ? 'Saving…' : 'Save schedule'}
        </button>
      </div>
    </Modal>
  );
}
