import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, Eraser, ListChecks, FileDown, Check, Users, Plus, GripVertical, Trash2 } from 'lucide-react';
import { Modal } from '../ui.jsx';
import { Card, Empty } from './Card.jsx';
import { DateTimePicker, formatDTDisplay } from './TaskFormModal.jsx';
import { useStore } from '../../store.jsx';
import { BRAND } from '../../theme.js';
import {
  seedSchedule, autofillFromKickOff, enabledRows, FIELD_LABELS, FIELD_ORDER,
  sectionNotes, newScheduleNote,
} from '../../lib/scheduleTemplate.js';
import { openSchedulePrintWindow } from '../../utils/printSchedule.js';

// ── Summary card shown on the deal/project page ──
// Compact read-only view of the enabled schedule; the whole card opens the modal.
export function ScheduleCard({ deal, video, onOpen }) {
  const source = video || deal;
  const schedule = source.productionSchedule;
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
      title="Production Schedule"
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

// "Pre-Production: Storyboard" → "Storyboard" for the compact Move-to menu.
const shortSectionLabel = (label) => String(label || '').replace(/^.*?:\s*/, '');

function DropLine() {
  return <div style={{ height: 3, borderRadius: 2, background: BRAND.blue, margin: '6px 4px' }} />;
}

// One free-text box under a schedule section. Dragged by its grip (the textarea
// itself stays selectable); the Move-to menu does the same job on touch
// screens, where native drag-and-drop doesn't fire.
function NoteBox({ note, sectionId, sections, autoFocus, dragging, dropBefore, dropProps, onDragStart, onDragEnd, onChange, onMove, onRemove }) {
  const boxRef = useRef(null);
  const areaRef = useRef(null);

  // Grow with the text so longer explanations don't hide behind a scrollbar.
  useEffect(() => {
    const el = areaRef.current; if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.max(64, el.scrollHeight + 2) + 'px';
  }, [note.text]);
  useEffect(() => { if (autoFocus) areaRef.current?.focus(); }, [autoFocus]);

  return (
    <div {...dropProps}>
      {dropBefore && <DropLine />}
      <div
        ref={boxRef}
        style={{
          margin: '10px 4px 4px', padding: '8px 10px 10px', border: '1px solid ' + BRAND.border, borderRadius: 8,
          background: BRAND.paper, opacity: dragging ? 0.4 : 1,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span
            draggable
            onDragStart={e => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', note.id);
              if (boxRef.current) e.dataTransfer.setDragImage(boxRef.current, 16, 16);
              onDragStart();
            }}
            onDragEnd={onDragEnd}
            title="Drag to move this text box"
            style={{ display: 'inline-flex', cursor: 'grab', color: BRAND.muted, padding: 2 }}
          >
            <GripVertical size={15} />
          </span>
          <span style={{ fontSize: 11, fontWeight: 600, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>Text box</span>
          <select
            value={sectionId}
            onChange={e => onMove(e.target.value)}
            title="Move to another section"
            style={{ marginLeft: 'auto', padding: '3px 6px', border: '1px solid ' + BRAND.border, borderRadius: 6, fontSize: 12, background: 'white', maxWidth: 180 }}
          >
            {sections.map(s => <option key={s.id} value={s.id}>{shortSectionLabel(s.label)}</option>)}
          </select>
          <button type="button" className="btn-icon" onClick={onRemove} title="Remove text box" style={{ display: 'inline-flex', padding: 4, color: BRAND.muted }}>
            <Trash2 size={14} />
          </button>
        </div>
        <textarea
          ref={areaRef}
          value={note.text}
          onChange={e => onChange(e.target.value)}
          placeholder="Add more detail about this stage…"
          style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid ' + BRAND.border, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', lineHeight: 1.45, resize: 'vertical', background: 'white' }}
        />
      </div>
    </div>
  );
}

// ── The editable, doc-like popout ──
export function ScheduleModal({ deal, dealId, video, videoId, company, primaryContact, onClose }) {
  const { state, actions, showMsg } = useStore();
  const isVideo = !!videoId;
  const source = isVideo ? video : deal;
  const [schedule, setSchedule] = useState(() => source.productionSchedule || seedSchedule(source));
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Producer options for the per-stage assignment (drives the weekly schedule).
  useEffect(() => { if (!state.schedule?.loaded) actions.loadSchedule(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const producerOptions = state.schedule?.producers || [];
  const producers = schedule.producers || {};
  const setProducer = (kind, email) => update(s => {
    s.producers = { ...(s.producers || {}), [kind]: email || null };
    return s;
  });

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

  // ── Text boxes ── free-text notes under a section, draggable between sections.
  const [focusNoteId, setFocusNoteId] = useState(null);
  const [dragNoteId, setDragNoteId] = useState(null);
  const [dropAt, setDropAt] = useState(null); // { sid, beforeId } while hovering
  const addNote = (sid) => {
    const note = newScheduleNote();
    update(s => {
      const sec = s.sections.find(x => x.id === sid);
      if (sec) sec.notes = [...sectionNotes(sec), note];
      return s;
    });
    setFocusNoteId(note.id);
  };
  const setNoteText = (nid, text) => update(s => {
    for (const sec of s.sections) for (const n of sectionNotes(sec)) if (n.id === nid) n.text = text;
    return s;
  });
  const removeNote = (nid) => update(s => {
    for (const sec of s.sections) sec.notes = sectionNotes(sec).filter(n => n.id !== nid);
    return s;
  });
  // Move a note into section `toSid`, before `beforeId` (or to the end).
  const moveNote = (nid, toSid, beforeId = null) => {
    if (nid === beforeId) return;
    update(s => {
      let note = null;
      for (const sec of s.sections) {
        const i = sectionNotes(sec).findIndex(n => n.id === nid);
        if (i >= 0) { note = sec.notes[i]; sec.notes = sec.notes.filter(n => n.id !== nid); }
      }
      const to = s.sections.find(x => x.id === toSid);
      if (!note || !to) return s;
      const list = [...sectionNotes(to)];
      const at = beforeId ? list.findIndex(n => n.id === beforeId) : -1;
      if (at >= 0) list.splice(at, 0, note); else list.push(note);
      to.notes = list;
      return s;
    });
  };
  const endDrag = () => { setDragNoteId(null); setDropAt(null); };
  const dropHandlers = (sid, beforeId = null) => ({
    onDragOver: (e) => {
      if (!dragNoteId) return; // ignore stray drags (e.g. selected text)
      e.preventDefault();
      e.stopPropagation();
      if (dropAt?.sid !== sid || dropAt?.beforeId !== beforeId) setDropAt({ sid, beforeId });
    },
    onDrop: (e) => {
      if (!dragNoteId) return;
      e.preventDefault();
      e.stopPropagation();
      moveNote(dragNoteId, sid, beforeId);
      endDrag();
    },
  });

  // Pass the browser's UTC offset so the server maps the wall-clock schedule
  // times correctly when it reconciles milestones on save. Empty text boxes
  // are dropped rather than stored.
  const persist = () => {
    const clean = {
      ...schedule,
      sections: schedule.sections.map(sec => ({ ...sec, notes: sectionNotes(sec).filter(n => n.text.trim()) })),
    };
    return isVideo
      ? actions.updateVideo(videoId, { productionSchedule: clean, tzOffsetMinutes: new Date().getTimezoneOffset() })
      : actions.saveDeal(dealId, { productionSchedule: clean, tzOffsetMinutes: new Date().getTimezoneOffset() });
  };

  const save = async () => {
    setSaving(true);
    try { await persist(); onClose(); }
    finally { setSaving(false); }
  };

  const moveToMilestones = async () => {
    setSyncing(true);
    try {
      await persist();
      const resp = isVideo ? await actions.syncVideoMilestones(videoId) : await actions.syncMilestones(dealId);
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
    const ok = openSchedulePrintWindow(schedule, source, company, primaryContact);
    if (!ok) showMsg('Pop-up blocked — allow pop-ups to export the schedule.');
  };

  const activeFields = FIELD_ORDER; // column headers are per-row, but keep order fixed

  return (
    <Modal onClose={onClose} maxWidth={900} showClose>
      <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 700 }}>Production Schedule{isVideo ? ` — ${video.title}` : ''}</h2>
      <div style={{ fontSize: 13, color: BRAND.muted, marginBottom: 18 }}>{isVideo ? (video.projectTitle || company?.name || 'Video') : (company?.name || deal.title)}</div>

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

      {/* Per-stage producer assignment — drives who each block lands on in the
          Weekly Schedule. Leave blank to fall back to the video's own producer. */}
      <div style={{ padding: '14px 16px', background: BRAND.paper, borderRadius: 10, marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
          <Users size={15} color={BRAND.blue} /> Assign producers <span style={{ fontWeight: 400, color: BRAND.muted }}>— populates the Weekly Schedule</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          {[
            { kind: 'script', label: 'Script' },
            { kind: 'storyboard', label: 'Storyboard / Visuals' },
            { kind: 'revisions', label: 'Revisions (Amends)' },
            { kind: 'production', label: 'Production' },
          ].map(({ kind, label }) => (
            <div key={kind}>
              <div style={{ fontSize: 11, color: BRAND.muted, marginBottom: 3 }}>{label}</div>
              <select
                value={producers[kind] || ''}
                onChange={e => setProducer(kind, e.target.value)}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid ' + BRAND.border, borderRadius: 8, fontSize: 13, background: 'white' }}
              >
                <option value="">Video’s producer</option>
                {producerOptions.map(p => <option key={p.email} value={p.email}>{p.name || p.email}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>

      {/* Sections */}
      {schedule.sections.map(section => {
        const notes = sectionNotes(section);
        const dropHere = dragNoteId && dropAt?.sid === section.id;
        return (
        <div
          key={section.id}
          {...dropHandlers(section.id)}
          style={{
            marginBottom: 18, border: '1px solid ' + (dropHere ? BRAND.blue : BRAND.border), borderRadius: 10, overflow: 'hidden',
            opacity: section.enabled ? 1 : 0.55, boxShadow: dropHere ? `0 0 0 2px ${BRAND.blue}33` : 'none',
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#EAF6FB' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
              <input type="checkbox" checked={section.enabled} onChange={e => setSection(section.id, { enabled: e.target.checked })} />
              {section.label}
            </label>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => addNote(section.id)}
              title="Add a text box to explain this stage in more detail"
              style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }}
            >
              <Plus size={14} /> Add text box
            </button>
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
            {notes.map(note => (
              <NoteBox
                key={note.id}
                note={note}
                sectionId={section.id}
                sections={schedule.sections}
                autoFocus={focusNoteId === note.id}
                dragging={dragNoteId === note.id}
                dropBefore={dragNoteId && dragNoteId !== note.id && dropAt?.sid === section.id && dropAt?.beforeId === note.id}
                dropProps={dropHandlers(section.id, note.id)}
                onDragStart={() => setDragNoteId(note.id)}
                onDragEnd={endDrag}
                onChange={text => setNoteText(note.id, text)}
                onMove={toSid => moveNote(note.id, toSid)}
                onRemove={() => removeNote(note.id)}
              />
            ))}
            {dropHere && dropAt?.beforeId == null && <DropLine />}
          </div>
        </div>
        );
      })}

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
