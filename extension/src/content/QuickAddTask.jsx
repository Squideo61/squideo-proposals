import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from '../lib/api.js';

const BRAND = {
  blue:   '#2BB8E6',
  ink:    '#0F2A3D',
  paper:  '#FAFBFC',
  border: '#E5E9EE',
  muted:  '#6B7785',
  hover:  '#F1F4F7',
};

// Up to this many recently-used due dates are tracked across all sessions
// (stored in localStorage). Streak's panel shows three — matching keeps the
// surface area small enough to scan at a glance.
const RECENT_LIMIT = 3;
const RECENT_KEY = 'squideo:quickTaskRecentDueAt';

// Singleton popover container — one popover at a time. Re-mounting on each
// open guarantees a fresh React tree (resets focus, suggestion state, etc.).
let _container = null;
let _root = null;

function getContainer() {
  if (!_container) {
    _container = document.createElement('div');
    _container.setAttribute('data-squideo-task-popover', '');
    _container.style.cssText = 'position:fixed;z-index:9999;top:0;left:0;width:0;height:0;overflow:visible;pointer-events:none;';
    document.body.appendChild(_container);
    _root = createRoot(_container);
  }
  return _root;
}

export function openQuickAddTask({ dealId, dealTitle, gmailThreadId }) {
  const root = getContainer();
  root.render(
    <QuickAddTaskPopover
      key={gmailThreadId + dealId}
      dealId={dealId}
      dealTitle={dealTitle}
      gmailThreadId={gmailThreadId}
      onClose={() => root.render(null)}
    />
  );
}

// -------------------- date helpers --------------------

function startOfTomorrow8am() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d;
}

function nextMonday8am() {
  const d = new Date();
  // 0=Sun..6=Sat. We want the next Monday strictly after today; if today is
  // Monday, jump 7 days so "next Monday" never collides with "today".
  const day = d.getDay();
  const daysUntilMon = ((8 - day) % 7) || 7;
  d.setDate(d.getDate() + daysUntilMon);
  d.setHours(8, 0, 0, 0);
  return d;
}

function inOneHour() {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 60);
  d.setSeconds(0, 0);
  return d;
}

function inOneWeek() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(d.getHours(), 0, 0, 0);
  return d;
}

// `<input type="datetime-local">` only accepts/produces strings in local time
// with no zone (YYYY-MM-DDTHH:MM). Converting via toISOString() would shift
// into UTC and confuse users whose local zone isn't UTC.
function toLocalInputValue(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseLocalInputValue(value) {
  if (!value) return null;
  // new Date('YYYY-MM-DDTHH:MM') parses as local time per the spec.
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatHuman(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const opts = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  return d.toLocaleString(undefined, opts);
}

function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    // Drop entries already in the past — surfacing yesterday's 8am as a
    // "recently used" suggestion would always create overdue tasks.
    return parsed.filter(iso => {
      const t = Date.parse(iso);
      return Number.isFinite(t) && t > now;
    }).slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

function pushRecent(iso) {
  try {
    const cur = loadRecent();
    const dedup = [iso, ...cur.filter(x => x !== iso)].slice(0, RECENT_LIMIT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(dedup));
  } catch { /* private mode, quota, etc. — non-fatal */ }
}

// -------------------- component --------------------

function QuickAddTaskPopover({ dealId, dealTitle, gmailThreadId, onClose }) {
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState(null); // Date | null
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const inputRef = useRef(null);
  const cardRef = useRef(null);
  const recent = useMemo(loadRecent, []);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e) => {
      if (cardRef.current && !cardRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const suggestions = useMemo(() => ([
    { label: 'In 1 hour',       date: inOneHour() },
    { label: 'Tomorrow 8am',    date: startOfTomorrow8am() },
    { label: 'Next Monday 8am', date: nextMonday8am() },
    { label: 'In 1 week',       date: inOneWeek() },
  ]), []);

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setErr('');
    try {
      const iso = dueAt ? dueAt.toISOString() : undefined;
      await api.post('/api/crm/tasks', {
        dealId,
        title: title.trim(),
        dueAt: iso,
      });
      if (iso) pushRecent(iso);
      setDone(true);
      setTimeout(onClose, 800);
    } catch (err) {
      setErr(err.message || 'Could not create task');
      setBusy(false);
    }
  };

  const cardStyle = {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    background: 'white',
    border: '1px solid ' + BRAND.border,
    borderRadius: 10,
    boxShadow: '0 8px 32px rgba(15,42,61,0.18)',
    padding: 20,
    width: 340,
    fontFamily: '-apple-system, system-ui, sans-serif',
    color: BRAND.ink,
    pointerEvents: 'all',
    zIndex: 10000,
  };

  if (done) {
    return (
      <div ref={cardRef} style={cardStyle}>
        <div style={{ textAlign: 'center', padding: '8px 0' }}>
          <div style={{ fontSize: 24, marginBottom: 6 }}>✓</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#16A34A' }}>Task added</div>
        </div>
      </div>
    );
  }

  const labelStyle = { display: 'block', fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 };
  const inputStyle = {
    display: 'block', width: '100%', boxSizing: 'border-box',
    padding: '7px 8px', border: '1px solid ' + BRAND.border,
    borderRadius: 6, fontSize: 13, fontFamily: 'inherit',
  };

  return (
    <div ref={cardRef} style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Add task</div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: BRAND.muted, padding: 0, lineHeight: 1 }}
        >×</button>
      </div>

      <div style={labelStyle}>Deal</div>
      <div style={{
        fontSize: 12, fontWeight: 600, marginBottom: 14,
        padding: '5px 8px', background: BRAND.paper,
        border: '1px solid ' + BRAND.border, borderRadius: 6,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {dealTitle || dealId}
      </div>

      <form onSubmit={submit}>
        <label style={labelStyle}>Task</label>
        <input
          ref={inputRef}
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="e.g. Follow up on proposal"
          required
          style={{ ...inputStyle, marginBottom: 12 }}
        />

        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>Due (optional)</label>
          {dueAt && (
            <button
              type="button"
              onClick={() => setDueAt(null)}
              style={{ background: 'none', border: 'none', color: BRAND.muted, cursor: 'pointer', fontSize: 11, padding: 0, textDecoration: 'underline' }}
            >Clear</button>
          )}
        </div>
        <input
          type="datetime-local"
          value={dueAt ? toLocalInputValue(dueAt) : ''}
          onChange={e => setDueAt(parseLocalInputValue(e.target.value))}
          style={{ ...inputStyle, marginBottom: 8 }}
        />

        <div style={{ fontSize: 10, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Suggestions</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: recent.length ? 10 : 14 }}>
          {suggestions.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => setDueAt(s.date)}
              title={formatHuman(s.date)}
              style={{
                flex: '1 1 calc(50% - 3px)',
                padding: '6px 8px',
                background: BRAND.paper,
                border: '1px solid ' + BRAND.border,
                borderRadius: 6,
                fontSize: 12,
                color: BRAND.ink,
                cursor: 'pointer',
                fontFamily: 'inherit',
                textAlign: 'left',
              }}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.hover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = BRAND.paper; }}
            >{s.label}</button>
          ))}
        </div>

        {recent.length > 0 && (
          <>
            <div style={{ fontSize: 10, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Recently used</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
              {recent.map((iso) => (
                <button
                  key={iso}
                  type="button"
                  onClick={() => setDueAt(new Date(iso))}
                  style={{
                    padding: '6px 8px',
                    background: BRAND.paper,
                    border: '1px solid ' + BRAND.border,
                    borderRadius: 6,
                    fontSize: 12,
                    color: BRAND.ink,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.hover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = BRAND.paper; }}
                >{formatHuman(iso)}</button>
              ))}
            </div>
          </>
        )}

        {err && (
          <div style={{ background: '#FEE2E2', color: '#991B1B', fontSize: 12, padding: '6px 8px', borderRadius: 6, marginBottom: 10 }}>
            {err}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !title.trim()}
          style={{
            width: '100%', padding: '8px 0',
            background: BRAND.blue, color: 'white',
            border: 'none', borderRadius: 7,
            fontSize: 13, fontWeight: 600,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy || !title.trim() ? 0.6 : 1,
            fontFamily: 'inherit',
          }}
        >
          {busy ? 'Adding…' : 'Add task'}
        </button>
      </form>
    </div>
  );
}
