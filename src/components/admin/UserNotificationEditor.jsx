import React, { useEffect, useMemo, useState } from 'react';
import { X, Save } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { Modal } from '../ui.jsx';
import { NOTIFICATIONS } from '../../lib/notifications.js';

function groupBy(list, key) {
  const out = {};
  for (const item of list) {
    const g = item[key] || 'Other';
    if (!out[g]) out[g] = [];
    out[g].push(item);
  }
  return out;
}

// Editor for one user's notification preferences. Each notification has a
// tri-state value: "default" (use the role's default), "on" (force on for
// this user), or "off" (force off for this user).
export function UserNotificationEditor({ email, onClose, inline = false }) {
  const { state, actions, showMsg } = useStore();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState(null); // { role, effective, overrides }
  // Working state: key -> 'default' | 'on' | 'off'
  const [working, setWorking] = useState({});

  const groups = useMemo(() => groupBy(NOTIFICATIONS, 'group'), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    actions.getUserNotifications(email).then((r) => {
      if (cancelled) return;
      const w = {};
      for (const n of NOTIFICATIONS) {
        if (Object.prototype.hasOwnProperty.call(r.overrides || {}, n.key)) {
          w[n.key] = r.overrides[n.key] ? 'on' : 'off';
        } else {
          w[n.key] = 'default';
        }
      }
      setData(r);
      setWorking(w);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) {
        showMsg('Could not load notification settings');
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [email, actions, showMsg]);

  const roleName = state.roles?.[data?.role]?.name || data?.role || 'Member';

  const setMode = (key, mode) => {
    setWorking(prev => ({ ...prev, [key]: mode }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const overrides = {};
      for (const [key, mode] of Object.entries(working)) {
        if (mode === 'on') overrides[key] = true;
        else if (mode === 'off') overrides[key] = false;
        // 'default' → omit (server treats missing as "use role default")
      }
      await actions.saveUserNotifications(email, overrides);
      showMsg('Notification preferences saved');
      if (!inline) onClose && onClose();
    } catch (err) {
      showMsg(err.message || 'Could not save preferences');
    } finally {
      setSaving(false);
    }
  };

  const Body = (
    <>
      {!inline && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            Notifications for {email}
          </h3>
          <button onClick={onClose} aria-label="Close" className="btn-icon"><X size={14} /></button>
        </div>
      )}
      {loading ? (
        <div style={{ padding: 24, color: BRAND.muted, fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 16 }}>
            Defaults come from the <strong>{roleName}</strong> role. Override
            any notification on or off for this user specifically.
          </div>

          <div style={{ display: 'grid', gap: 16 }}>
            {Object.entries(groups).map(([group, items]) => (
              <div key={group}>
                <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                  {group}
                </div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {items.map(n => {
                    const mode = working[n.key] || 'default';
                    const roleDefault = !!data?.effective?.[n.key]?.enabled && data.effective[n.key].source === 'role';
                    const effective = data?.effective?.[n.key]?.enabled;
                    return (
                      <div key={n.key} style={{
                        background: 'white',
                        border: '1px solid ' + BRAND.border,
                        borderRadius: 8,
                        padding: 12,
                        display: 'grid',
                        gridTemplateColumns: '1fr auto',
                        gap: 12,
                        alignItems: 'center',
                      }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{n.label}</div>
                          <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>{n.description}</div>
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <SegBtn label={`Default (${roleDefault ? 'on' : 'off'})`} active={mode === 'default'} onClick={() => setMode(n.key, 'default')} />
                          <SegBtn label="Force on" active={mode === 'on'} onClick={() => setMode(n.key, 'on')} />
                          <SegBtn label="Force off" active={mode === 'off'} onClick={() => setMode(n.key, 'off')} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20, borderTop: '1px solid ' + BRAND.border, paddingTop: 16 }}>
            {!inline && <button onClick={onClose} className="btn-ghost">Cancel</button>}
            <button onClick={save} disabled={saving} className="btn">
              <Save size={14} /> {saving ? 'Saving…' : 'Save preferences'}
            </button>
          </div>
        </>
      )}
    </>
  );

  if (inline) return Body;
  return <Modal onClose={onClose} maxWidth={720}>{Body}</Modal>;
}

function SegBtn({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? BRAND.blue : 'transparent',
        color: active ? 'white' : BRAND.ink,
        border: '1px solid ' + (active ? BRAND.blue : BRAND.border),
        borderRadius: 6,
        padding: '6px 10px',
        fontSize: 12,
        fontWeight: active ? 700 : 500,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}
