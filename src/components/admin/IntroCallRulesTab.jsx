import React, { useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';

const minutesToHHMM = (m) => {
  const h = Math.floor(m / 60), mi = m % 60;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
};
const hhmmToMinutes = (s) => {
  const [h, mi] = String(s).split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(mi) ? mi : 0);
};

// Admin-only global booking rules for client intro calls. Times are local
// (Europe/London) wall-clock; everything else is plain numbers.
export function IntroCallRulesTab() {
  const { actions, showMsg } = useStore();
  const [rules, setRules] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    actions.loadIntroCallRules().then((d) => {
      if (d && d.rules) setRules(d.rules);
    });
  }, [actions]);

  const set = (key, value) => setRules((r) => ({ ...r, [key]: value }));

  const save = () => {
    setSaving(true);
    actions.saveIntroCallRules(rules)
      .then((d) => { if (d && d.rules) setRules(d.rules); showMsg('Booking rules saved'); })
      .finally(() => setSaving(false));
  };

  if (!rules) return <div style={{ color: BRAND.muted }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 620 }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 700 }}>Intro call booking rules</h2>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: BRAND.muted }}>
        Global limits applied to every project's booking link. Each staff member also sets their own
        working days/hours in their account; a slot must satisfy both.
      </p>

      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <NumberRow label="Minimum notice (hours)" hint="How far ahead the earliest bookable slot must be."
          value={rules.minNoticeHours} onChange={(v) => set('minNoticeHours', v)} min={0} max={336} />

        <TimeRow label="Earliest start" hint="No calls begin before this time."
          value={rules.earliestMinute} onChange={(v) => set('earliestMinute', v)} />

        <TimeRow label="Daily close (Mon–Thu)" hint="Last call must end by this time."
          value={rules.latestEndMinute} onChange={(v) => set('latestEndMinute', v)} />

        <TimeRow label="Friday close" hint="Earlier finish on Fridays."
          value={rules.fridayLatestEndMinute} onChange={(v) => set('fridayLatestEndMinute', v)} />

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <TimeRow label="Lunch starts" value={rules.lunchStartMinute} onChange={(v) => set('lunchStartMinute', v)} />
          <TimeRow label="Lunch ends" value={rules.lunchEndMinute} onChange={(v) => set('lunchEndMinute', v)} />
        </div>

        <NumberRow label="Call duration (minutes)" value={rules.durationMinutes} onChange={(v) => set('durationMinutes', v)} min={10} max={240} />
        <NumberRow label="Slot spacing (minutes)" hint="Gap between offered start times."
          value={rules.slotGranularityMinutes} onChange={(v) => set('slotGranularityMinutes', v)} min={10} max={120} />
        <NumberRow label="Look-ahead (days)" hint="How far into the future clients can book."
          value={rules.lookaheadDays} onChange={(v) => set('lookaheadDays', v)} min={1} max={60} />

        <button onClick={save} disabled={saving} className="btn" style={{ alignSelf: 'flex-start', marginTop: 4 }}>
          {saving ? 'Saving…' : 'Save rules'}
        </button>
      </div>
    </div>
  );
}

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

function TimeRow({ label, hint, value, onChange }) {
  return (
    <Row label={label} hint={hint}>
      <input
        type="time"
        value={minutesToHHMM(value)}
        onChange={(e) => onChange(hhmmToMinutes(e.target.value))}
        style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 14 }}
      />
    </Row>
  );
}

function NumberRow({ label, hint, value, onChange, min, max }) {
  return (
    <Row label={label} hint={hint}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: 90, padding: '6px 10px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 14 }}
      />
    </Row>
  );
}
