import React, { useEffect, useRef, useState } from 'react';
import { Bell, Check, X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { formatRelativeTime, useIsMobile } from '../utils.js';

// Floating notification center. Mounted once at the app root so the bell is
// available on every screen. Sits in the right-hand gutter of the centered
// (max-width 1100) layout, clear of each view's own header on desktop.
//
// The feed is populated by the store's 60s poll (store.jsx); this component is
// purely presentational + marks things read. `onOpenLink` receives an in-app
// hash route (e.g. '#/admin/users') so clicking a notification navigates
// without a full reload.
export function NotificationBell({ onOpenLink, inline = false }) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const items = state.notifications || [];
  const unread = state.notificationsUnread || 0;

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // Refresh the feed whenever the panel is opened so it's current.
  useEffect(() => { if (open) actions.loadNotifications().catch(() => {}); }, [open, actions]);

  const onItemClick = (n) => {
    if (!n.read) actions.markNotificationsRead([n.id]);
    if (n.link) {
      setOpen(false);
      onOpenLink?.(n.link);
    }
  };

  const badge = unread > 9 ? '9+' : String(unread);

  // Inline: flows inside the top bar's right-hand group. Floating: a fixed
  // pill in the corner, used on views that have no top bar (builder, client).
  const wrapStyle = inline
    ? { position: 'relative', zIndex: 95 }
    : { position: 'fixed', top: isMobile ? 10 : 14, right: isMobile ? 10 : 16, zIndex: 95 };

  return (
    <div ref={wrapRef} style={wrapStyle}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        title="Notifications"
        style={{
          position: 'relative',
          width: 40, height: 40, borderRadius: '50%',
          background: 'white', border: '1px solid ' + BRAND.border,
          boxShadow: inline ? 'none' : '0 2px 8px rgba(15,42,61,0.12)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: open ? BRAND.blue : BRAND.ink,
        }}
      >
        <Bell size={18} />
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: -3, right: -3, minWidth: 18, height: 18, padding: '0 4px',
            borderRadius: 999, background: '#EF4444', color: 'white', fontSize: 10, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid white',
          }}>{badge}</span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 48, right: 0,
          width: isMobile ? 'calc(100vw - 20px)' : 360,
          maxHeight: isMobile ? 'calc(100vh - 72px)' : '70vh',
          display: 'flex', flexDirection: 'column',
          background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12,
          boxShadow: '0 12px 32px rgba(15,42,61,0.18)', overflow: 'hidden',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid ' + BRAND.border }}>
            <strong style={{ fontSize: 14 }}>Notifications</strong>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {unread > 0 && (
                <button
                  onClick={() => actions.markAllNotificationsRead()}
                  className="btn-ghost"
                  style={{ fontSize: 12, padding: '4px 8px' }}
                >
                  <Check size={13} /> Mark all read
                </button>
              )}
              <button onClick={() => setOpen(false)} aria-label="Close" className="btn-icon"><X size={14} /></button>
            </div>
          </div>

          <div style={{ overflowY: 'auto' }}>
            {items.length === 0 ? (
              <div style={{ padding: '28px 16px', textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>
                You're all caught up.
              </div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => onItemClick(n)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', cursor: n.link ? 'pointer' : 'default',
                    background: n.read ? 'white' : '#F0F9FF',
                    border: 'none', borderBottom: '1px solid ' + BRAND.border,
                    padding: '12px 14px', font: 'inherit',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <span style={{
                      flexShrink: 0, marginTop: 6, width: 7, height: 7, borderRadius: '50%',
                      background: n.read ? 'transparent' : BRAND.blue,
                    }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: n.read ? 500 : 700, color: BRAND.ink, lineHeight: 1.35 }}>{n.title}</div>
                      {n.body && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2, lineHeight: 1.4 }}>{n.body}</div>}
                      <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4 }}>{formatRelativeTime(n.createdAt)}</div>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
