import React, { useEffect, useRef, useState } from 'react';
import { Bell, Check, X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { formatRelativeTime } from '../utils.js';
import { CHANNEL_META } from './NotificationBell.jsx';

// Short tab labels — CHANNEL_META.label is tuned for the desktop bells' tooltips
// ("Notifications", "Sales & finance", "View Tracking"), too long for a phone tab.
const TAB_LABEL = { general: 'Updates', finance: 'Finance', tracking: 'Tracking' };

// Mobile-only notification center: one bell in the slim top bar that folds the
// general / finance / tracking feeds (the three separate desktop bells) into a
// single sheet with channel tabs. Frees the cramped phone header. `channels` is
// the ordered list of feeds this user can see (finance is permission-gated).
// `hideTrigger` + `openSignal` let the mobile header burger menu own the launch
// button and pop this sheet itself: bumping `openSignal` opens it, and with
// `hideTrigger` the component renders the sheet only (no bell of its own).
export function MobileNotifications({ onOpenLink, channels, hideTrigger = false, openSignal = 0 }) {
  const { state, actions } = useStore();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(channels[0] || 'general');
  const ref = useRef(null);

  const byChannel = state.notificationsByChannel || {};
  const unreadFor = (ch) => byChannel[ch]?.unread || 0;
  const totalUnread = channels.reduce((n, ch) => n + unreadFor(ch), 0);
  const feed = byChannel[active] || { items: [], unread: 0 };
  const items = feed.items || [];
  const meta = CHANNEL_META[active] || CHANNEL_META.general;

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // Refresh whenever opened so the sheet is current (mirrors NotificationBell).
  useEffect(() => { if (open) actions.loadNotifications().catch(() => {}); }, [open, actions]);

  // Parent-driven open (mobile header burger). Ignore the initial 0.
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);

  const onItemClick = (n) => {
    if (!n.read) actions.markNotificationsRead([n.id], active);
    if (n.link) { setOpen(false); onOpenLink?.(n.link); }
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {!hideTrigger && (
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={totalUnread > 0 ? `Notifications (${totalUnread} unread)` : 'Notifications'}
        title="Notifications"
        style={{
          position: 'relative', width: 40, height: 40, borderRadius: '50%', padding: 0,
          background: 'white', border: '1px solid ' + BRAND.border, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: open ? BRAND.blue : BRAND.ink,
        }}
      >
        <Bell size={18} />
        {totalUnread > 0 && (
          <span style={{
            position: 'absolute', top: -3, right: -3, minWidth: 18, height: 18, padding: '0 4px',
            borderRadius: 999, background: '#EF4444', color: 'white', fontSize: 10, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid white',
          }}>{totalUnread > 99 ? '99+' : totalUnread}</span>
        )}
      </button>
      )}

      {open && (
        <div style={{
          // Fixed to the viewport (not the bell) so it spans the screen evenly
          // and never spills off-edge — the bell isn't the rightmost top-bar item.
          position: 'fixed', left: 10, right: 10,
          top: 'calc(env(safe-area-inset-top) + 58px)', maxHeight: 'calc(100vh - 150px)',
          display: 'flex', flexDirection: 'column',
          background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12,
          boxShadow: '0 12px 32px rgba(15,42,61,0.18)', overflow: 'hidden', zIndex: 200,
        }}>
          {/* Channel tabs — only shown when the user has more than one feed. */}
          {channels.length > 1 && (
            <div style={{ display: 'flex', borderBottom: '1px solid ' + BRAND.border }}>
              {channels.map((ch) => {
                const m = CHANNEL_META[ch] || CHANNEL_META.general;
                const u = unreadFor(ch);
                const on = ch === active;
                const Icon = m.icon;
                return (
                  <button
                    key={ch}
                    onClick={() => setActive(ch)}
                    style={{
                      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                      padding: '11px 6px', border: 'none', background: 'transparent', cursor: 'pointer',
                      borderBottom: on ? `2px solid ${m.accent}` : '2px solid transparent',
                      color: on ? m.accent : BRAND.muted, fontSize: 12.5, fontWeight: on ? 700 : 500,
                    }}
                  >
                    <Icon size={15} />
                    {TAB_LABEL[ch] || m.label}
                    {u > 0 && (
                      <span style={{ background: m.badge, color: 'white', fontSize: 10, fontWeight: 700, padding: '0 5px', borderRadius: 999 }}>{u}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px 8px 14px', borderBottom: '1px solid ' + BRAND.border }}>
            <strong style={{ fontSize: 13, color: BRAND.ink }}>{meta.label}</strong>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {feed.unread > 0 && (
                <button onClick={() => actions.markAllNotificationsRead(active)} className="btn-ghost" style={{ fontSize: 12, padding: '4px 8px' }}>
                  <Check size={13} /> Mark read
                </button>
              )}
              {items.length > 0 && (
                <button onClick={() => actions.clearNotifications(active)} className="btn-ghost" style={{ fontSize: 12, padding: '4px 8px' }}>
                  Clear
                </button>
              )}
            </div>
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {items.length === 0 ? (
              <div style={{ padding: '28px 16px', textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>
                You're all caught up.
              </div>
            ) : (
              items.map((n) => (
                <div key={n.id} style={{ display: 'flex', alignItems: 'stretch', background: n.read ? 'white' : '#F0F9FF', borderBottom: '1px solid ' + BRAND.border }}>
                  <button
                    onClick={() => onItemClick(n)}
                    style={{ flex: 1, minWidth: 0, textAlign: 'left', cursor: n.link ? 'pointer' : 'default', background: 'transparent', border: 'none', padding: '12px 14px', font: 'inherit' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <span style={{ flexShrink: 0, marginTop: 6, width: 7, height: 7, borderRadius: '50%', background: n.read ? 'transparent' : meta.accent }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: n.read ? 500 : 700, color: BRAND.ink, lineHeight: 1.35 }}>{n.title}</div>
                        {n.body && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2, lineHeight: 1.4 }}>{n.body}</div>}
                        <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4 }}>{formatRelativeTime(n.createdAt)}</div>
                      </div>
                    </div>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); actions.dismissNotification(n.id, active); }}
                    aria-label="Dismiss notification"
                    title="Dismiss"
                    style={{ flexShrink: 0, padding: '8px 12px', background: 'transparent', border: 'none', color: BRAND.muted, cursor: 'pointer' }}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
