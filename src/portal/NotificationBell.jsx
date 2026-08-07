// The client's in-portal bells. Two of them, side by side in the header —
// the same shape as the CRM's own general/finance split (see
// src/components/NotificationBell.jsx): one component, parameterised by
// channel, mounted twice.
//
// They are deliberately two feeds rather than two groups in one list, because
// they answer different questions and behave differently:
//
//   TASKS — what's still waiting on you to DO. Read live from your projects
//   every time, never stored. Nothing to mark read: a task leaves the list by
//   being finished. A stored task row is a snapshot, so the moment someone
//   uploads their logo it's a lie sitting in the bell until they click it.
//
//   UPDATES — what HAPPENED. Stored rows, unread until opened, marked read on
//   click. "Your video is ready to review", "your storyboard was finalised".
//
// Mixing them meant a checklist summary sat in the feed pretending to be an
// event, and one number spoke for both.
import React, { useEffect, useRef, useState } from 'react';
import { Bell, ClipboardCheck, ChevronRight, Circle } from 'lucide-react';
import { BRAND } from '../theme.js';
import { usePortal } from './PortalContext.jsx';

// Per-channel presentation. Amber for tasks — the same colour the task lists
// and "action needed from you" banners already use, so a client doesn't have to
// learn that this bell means the same thing as that card.
const CHANNEL_META = {
  tasks: {
    Icon: ClipboardCheck,
    label: 'Your tasks',
    badge: '#F59E0B',
    empty: 'Nothing waiting on you right now.',
  },
  updates: {
    Icon: Bell,
    label: 'Updates',
    badge: '#EF4444',
    empty: "You're all caught up.",
  },
};

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

export default function NotificationBell({ compact = false, channel = 'updates' }) {
  const { notifications, unreadCount, openTasks, markRead, markAllRead } = usePortal();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const meta = CHANNEL_META[channel] || CHANNEL_META.updates;
  const { Icon } = meta;
  const isTasks = channel === 'tasks';
  const tasks = openTasks || [];
  const count = isTasks ? tasks.length : unreadCount;

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onItem = (n) => {
    if (!n.readAt) markRead(n.id);
    if (n.link) window.location.hash = n.link;
    setOpen(false);
  };

  // Nothing to mark read — a task leaves the list by being done.
  const onTask = (t) => {
    if (t.link) window.location.hash = t.link;
    setOpen(false);
  };

  // Only worth naming the project when they have more than one; otherwise it's
  // the same words on every row telling them nothing.
  const multiProject = new Set(tasks.map((t) => t.dealId)).size > 1;

  // An empty tasks bell is a permanently grey clipboard for the many clients
  // who have nothing outstanding. The updates bell always shows, because "no
  // news" is itself worth being able to check.
  if (isTasks && tasks.length === 0) return null;

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={meta.label}
        aria-label={count > 0 ? `${meta.label} (${count})` : meta.label}
        style={{
          background: 'none', border: 'none', color: '#B9CBD6', cursor: 'pointer',
          padding: 6, display: 'flex', position: 'relative',
        }}
      >
        <Icon size={compact ? 20 : 17} />
        {count > 0 && (
          <span style={{
            position: 'absolute', top: 0, right: 0,
            minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8,
            background: meta.badge, color: '#fff', fontSize: 10, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
          }}>
            {count > 9 ? '9+' : count}
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
            <span style={{ fontWeight: 700, fontSize: 14, color: BRAND.ink }}>
              {meta.label}
              {isTasks && tasks.length > 0 && (
                <span style={{ color: BRAND.muted, fontWeight: 600 }}> · {tasks.length} to do</span>
              )}
            </span>
            {/* Only the stored feed has a read state to clear. */}
            {!isTasks && unreadCount > 0 && (
              <button
                onClick={markAllRead}
                style={{ background: 'none', border: 'none', color: BRAND.blue, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, padding: 0 }}
              >
                Mark all read
              </button>
            )}
          </div>

          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            {isTasks ? (
              tasks.map((t) => (
                <button
                  key={t.key}
                  onClick={() => onTask(t)}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%', textAlign: 'left',
                    cursor: 'pointer', padding: '11px 14px', border: 'none',
                    borderBottom: `1px solid ${BRAND.border}`, background: '#FFFDF5',
                  }}
                >
                  <span style={{
                    width: 22, height: 22, borderRadius: 7, flexShrink: 0, marginTop: 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: '#FEF3C7', color: '#B45309',
                  }}>
                    <Circle size={12} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5, color: BRAND.ink }}>{t.title}</span>
                    {t.detail && (
                      <span style={{ display: 'block', fontSize: 12.5, color: BRAND.muted, marginTop: 2, lineHeight: 1.4 }}>
                        {t.detail}
                      </span>
                    )}
                    {multiProject && t.dealTitle && (
                      <span style={{ display: 'block', fontSize: 11, color: BRAND.muted, marginTop: 3, fontWeight: 600 }}>
                        {t.dealTitle}
                      </span>
                    )}
                  </span>
                  <ChevronRight size={15} color={BRAND.muted} style={{ flexShrink: 0, marginTop: 4 }} />
                </button>
              ))
            ) : notifications.length === 0 ? (
              <div style={{ padding: '28px 16px', textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>
                {meta.empty}
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
