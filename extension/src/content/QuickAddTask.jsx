import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from '../lib/api.js';

const BRAND = {
  blue:   '#2BB8E6',
  ink:    '#0F2A3D',
  paper:  '#FAFBFC',
  border: '#E5E9EE',
  muted:  '#6B7785',
};

// Mount a singleton popover container on first call, then toggle it.
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

function QuickAddTaskPopover({ dealId, dealTitle, gmailThreadId, onClose }) {
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const inputRef = useRef(null);
  const cardRef = useRef(null);

  // Focus title field on open
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Close on Escape or click outside
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

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setErr('');
    try {
      await api.post('/api/crm/tasks', {
        dealId,
        title: title.trim(),
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
      });
      setDone(true);
      setTimeout(onClose, 1000);
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
    width: 300,
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

  return (
    <div ref={cardRef} style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Add task</div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: BRAND.muted, padding: 0, lineHeight: 1 }}
        >×</button>
      </div>

      <div style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
        Deal
      </div>
      <div style={{
        fontSize: 12, fontWeight: 600, marginBottom: 14,
        padding: '5px 8px', background: BRAND.paper,
        border: '1px solid ' + BRAND.border, borderRadius: 6,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {dealTitle || dealId}
      </div>

      <form onSubmit={submit}>
        <label style={{ display: 'block', fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
          Task
        </label>
        <input
          ref={inputRef}
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="e.g. Follow up on proposal"
          required
          style={{
            display: 'block', width: '100%', boxSizing: 'border-box',
            padding: '7px 8px', border: '1px solid ' + BRAND.border,
            borderRadius: 6, fontSize: 13, fontFamily: 'inherit',
            marginBottom: 12,
          }}
        />

        <label style={{ display: 'block', fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
          Due date (optional)
        </label>
        <input
          type="date"
          value={dueAt}
          onChange={e => setDueAt(e.target.value)}
          style={{
            display: 'block', width: '100%', boxSizing: 'border-box',
            padding: '7px 8px', border: '1px solid ' + BRAND.border,
            borderRadius: 6, fontSize: 13, fontFamily: 'inherit',
            marginBottom: 14,
          }}
        />

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
