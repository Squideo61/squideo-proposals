import React, { useEffect, useMemo, useState } from 'react';
import { X, Save, Bell, Mail, BellRing } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
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

const CHANNELS = [
  { value: 'in_app', label: 'In-app', icon: Bell },
  { value: 'email', label: 'Email', icon: Mail },
  { value: 'both', label: 'Both', icon: BellRing },
];

// Editor for one user's notification preferences. Each notification has:
//  - an enabled tri-state: "default" (use the role's default), "on" (force on),
//    "off" (force off);
//  - a delivery channel (in-app bell / email / both) that defaults to the
//    role's channel and can be overridden per user.
export function UserNotificationEditor({ email, onClose, inline = false }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState(null); // { role, effective, overrides, channels }
  // Working state: key -> { mode: 'default'|'on'|'off', channel: 'in_app'|'email'|'both' }
  const [working, setWorking] = useState({});

  const groups = useMemo(() => groupBy(NOTIFICATIONS, 'group'), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    actions.getUserNotifications(email).then((r) => {
      if (cancelled) return;
      const w = {};
      for (const n of NOTIFICATIONS) {
        const hasEnabledOverride = Object.prototype.hasOwnProperty.call(r.overrides || {}, n.key);
        const mode = hasEnabledOverride ? (r.overrides[n.key] ? 'on' : 'off') : 'default';
        // Start from the effective channel (override or role default) so the
        // control shows what's actually happening today.
        const channel = r.effective?.[n.key]?.channel || 'both';
        w[n.key] = { mode, channel };
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

  const setMode = (key, mode) => setWorking(prev => ({ ...prev, [key]: { ...prev[key], mode } }));
  const setChannel = (key, channel) => setWorking(prev => ({ ...prev, [key]: { ...prev[key], channel } }));

  const save = async () => {
    setSaving(true);
    try {
      const overrides = {};
      const channels = {};
      for (const n of NOTIFICATIONS) {
        const w = working[n.key] || { mode: 'default', channel: 'both' };
        if (w.mode === 'on') overrides[n.key] = true;
        else if (w.mode === 'off') overrides[n.key] = false;
        // 'default' → omit (server uses the role default for enabled)

        // Only persist a channel override when it differs from the role default,
        // so the setting keeps inheriting the role unless explicitly changed.
        const roleChannel = data?.effective?.[n.key]?.roleChannel || 'both';
        if (w.channel && w.channel !== roleChannel) channels[n.key] = w.channel;
      }
      await actions.saveUserNotifications(email, overrides, channels);
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, minWidth: 0, overflowWrap: 'anywhere' }}>
            Notifications for {email}
          </h3>
          <button onClick={onClose} aria-label="Close" className="btn-icon" style={{ flexShrink: 0 }}><X size={14} /></button>
        </div>
      )}
      {loading ? (
        <div style={{ padding: 24, color: BRAND.muted, fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 16 }}>
            Defaults come from the <strong>{roleName}</strong> role. Override any
            notification for this user — turn it on/off and choose how it's
            delivered (in-app bell, email, or both).
          </div>

          <div style={{ display: 'grid', gap: 16 }}>
            {Object.entries(groups).map(([group, items]) => (
              <div key={group}>
                <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                  {group}
                </div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {items.map(n => {
                    const w = working[n.key] || { mode: 'default', channel: 'both' };
                    const roleDefaultOn = !!data?.effective?.[n.key]?.enabled && data.effective[n.key].source === 'role';
                    // Is the notification effectively ON (so the channel picker matters)?
                    const effectivelyOn = w.mode === 'on' || (w.mode === 'default' && roleDefaultOn);
                    return (
                      <div key={n.key} style={{
                        background: 'white',
                        border: '1px solid ' + BRAND.border,
                        borderRadius: 10,
                        padding: 12,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                      }}>
                        {/* Label + enabled control. Stacks on mobile so the
                            buttons never crush the text into a narrow column. */}
                        <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'space-between', gap: isMobile ? 8 : 12 }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{n.label}</div>
                            <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 2 }}>{n.description}</div>
                          </div>
                          <Seg
                            fill={isMobile}
                            options={[
                              { value: 'default', label: `Default (${roleDefaultOn ? 'on' : 'off'})` },
                              { value: 'on', label: 'On' },
                              { value: 'off', label: 'Off' },
                            ]}
                            value={w.mode}
                            onChange={(v) => setMode(n.key, v)}
                          />
                        </div>
                        {/* Delivery channel — only shown when the alert will fire. */}
                        {effectivelyOn && (
                          <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'stretch' : 'center', gap: isMobile ? 6 : 10, paddingTop: 8, borderTop: '1px dashed ' + BRAND.border }}>
                            <span style={{ fontSize: 11, fontWeight: 600, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, flexShrink: 0 }}>Deliver via</span>
                            <Seg
                              fill={isMobile}
                              options={CHANNELS}
                              value={w.channel}
                              onChange={(v) => setChannel(n.key, v)}
                            />
                          </div>
                        )}
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
  return <Modal onClose={onClose} maxWidth={720} showClose={false}>{Body}</Modal>;
}

// A compact segmented control. `fill` makes the buttons share the full width
// (used on mobile so they're comfortable tap targets instead of a cramped row).
function Seg({ options, value, onChange, fill = false }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexShrink: 0, width: fill ? '100%' : undefined }}>
      {options.map((o) => {
        const active = value === o.value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            style={{
              flex: fill ? 1 : undefined,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              background: active ? BRAND.blue : 'transparent',
              color: active ? 'white' : BRAND.ink,
              border: '1px solid ' + (active ? BRAND.blue : BRAND.border),
              borderRadius: 6,
              padding: '7px 10px',
              minHeight: 38,
              fontSize: 12,
              fontWeight: active ? 700 : 500,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              fontFamily: 'inherit',
            }}
          >
            {Icon && <Icon size={13} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
