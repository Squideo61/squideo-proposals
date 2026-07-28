// The client's in-portal notification bell + dropdown feed. Lives in the portal
// header. Reads from PortalContext (polled), marks items read on click, and
// routes to the item's portal hash link.
import React, { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { BRAND } from '../theme.js';
import { usePortal } from './PortalContext.jsx';

function relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export default function NotificationBell({ compact = false }) {
  const { notifications, unreadCount, markRead, markAllRead } = usePortal();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const onItem = (n) => {
    if (!n.readAt) markRead(n.id);
    if (n.link) window.location.hash = n.link;
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        aria-label="Notifications"
        style={{ background: 'none', border: 'none', color: '#B9CBD6', cursor: 'pointer', padding: 6, display: 'flex', position: 'relative' }}
      >
        <Bell size={compact ? 20 : 17} />
        {unreadCount > 0 && (
          <span style={{
            position: 'absolute', top: 0, right: 0,
            minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8,
            background: '#EF4444', color: '#fff', fontSize: 10, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
          }}>
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 60,
          width: 340, maxWidth: 'calc(100vw - 32px)',
          background: '#fff', border: `1px solid ${BRAND.border}`, borderRadius: 12,
          boxShadow: '0 12px 32px rgba(15,42,61,0.18)', overflow: 'hidden',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 14px', borderBottom: `1px solid ${BRAND.border}`,
          }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: BRAND.ink }}>Notifications</span>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                style={{ background: 'none', border: 'none', color: BRAND.blue, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, padding: 0 }}
              >
                Mark all read
              </button>
            )}
          </div>
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {notifications.length === 0 ? (
              <div style={{ padding: '28px 16px', textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>
                You're all caught up.
              </div>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => onItem(n)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', cursor: n.link ? 'pointer' : 'default',
                    padding: '12px 14px', border: 'none', borderBottom: `1px solid ${BRAND.border}`,
                    background: n.readAt ? '#fff' : '#F0F9FF',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 13.5, color: BRAND.ink, flex: 1 }}>{n.title}</span>
                    <span style={{ fontSize: 11, color: BRAND.muted, whiteSpace: 'nowrap' }}>{relativeTime(n.createdAt)}</span>
                  </div>
                  {n.body && <div style={{ fontSize: 12.5, color: BRAND.muted, marginTop: 3, lineHeight: 1.4 }}>{n.body}</div>}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
