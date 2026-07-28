import React, { useState } from 'react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';

const DEFAULTS = { enabled: false, everyDays: 3, maxReminders: 3, subject: '', bodyHtml: '' };

// Admin-only config for the automatic client-task reminders. The cron
// (cronClientTaskReminders) chases clients who still have open portal tasks
// (choose voiceover / book kick-off / send PO) on this cadence, and stops the
// moment their tasks are done or the cap is hit.
export function TaskRemindersTab() {
  const { state, actions, showMsg } = useStore();
  const [cfg, setCfg] = useState(() => ({ ...DEFAULTS, ...(state.taskReminders || {}) }));

  const set = (key, value) => setCfg((c) => ({ ...c, [key]: value }));

  const save = () => {
    const clean = {
      enabled: !!cfg.enabled,
      everyDays: Math.max(1, Number(cfg.everyDays) || 3),
      maxReminders: Math.max(1, Number(cfg.maxReminders) || 3),
      subject: (cfg.subject || '').trim(),
      bodyHtml: cfg.bodyHtml || '',
    };
    setCfg((c) => ({ ...c, ...clean }));
    actions.saveTaskReminders(clean);
    showMsg('Reminder settings saved');
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 700 }}>Client task reminders</h2>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: BRAND.muted }}>
        Automatically remind clients (in their portal and by email) when they still have tasks to
        complete — choosing a voiceover, booking the kick-off call, or sending a PO. Reminders stop
        automatically once every task is done or the maximum is reached.
      </p>

      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!cfg.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          <span style={{ fontSize: 14, fontWeight: 600, color: BRAND.ink }}>Send automatic reminders</span>
        </label>

        <Row label="Remind every (days)" hint="How long to wait between reminders.">
          <input type="number" min={1} max={60} value={cfg.everyDays}
            onChange={(e) => set('everyDays', Number(e.target.value))}
            style={numStyle} />
        </Row>

        <Row label="Maximum reminders" hint="Stop after this many, even if tasks remain.">
          <input type="number" min={1} max={20} value={cfg.maxReminders}
            onChange={(e) => set('maxReminders', Number(e.target.value))}
            style={numStyle} />
        </Row>

        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: BRAND.ink, marginBottom: 6 }}>Email subject</div>
          <input type="text" value={cfg.subject}
            onChange={(e) => set('subject', e.target.value)}
            placeholder="A few things still need you — {project}"
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 14, boxSizing: 'border-box' }} />
          <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>Leave blank to use the default subject.</div>
        </div>

        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: BRAND.ink, marginBottom: 6 }}>Email intro (optional HTML)</div>
          <textarea value={cfg.bodyHtml}
            onChange={(e) => set('bodyHtml', e.target.value)}
            rows={5}
            placeholder="<p>Just a quick nudge — your project is ready to move forward…</p>"
            style={{ width: '100%', padding: '10px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 13, fontFamily: 'monospace', boxSizing: 'border-box', resize: 'vertical' }} />
          <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>
            Appears above the outstanding-task list and portal button. Leave blank to use the default copy.
          </div>
        </div>

        <button onClick={save} className="btn" style={{ alignSelf: 'flex-start', marginTop: 4 }}>
          Save reminder settings
        </button>
      </div>
    </div>
  );
}

const numStyle = { width: 90, padding: '6px 10px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 14 };

function Row({ label, hint, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: BRAND.ink }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}
