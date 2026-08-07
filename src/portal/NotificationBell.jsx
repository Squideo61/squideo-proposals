// The client's in-portal bell. Lives in the portal header, reads from
// PortalContext (polled), and shows two groups that are deliberately different
// things:
//
//   TASKS — what's still waiting on them. Read live from their projects, so a
//   task that gets done simply stops appearing; there is nothing to mark read
//   and nothing to go stale.
//
//   NOTIFICATIONS — what happened. Stored rows, marked read on click.
//
// The count on the bell is both, because it answers one question ("is anything
// waiting on me?") and splitting that number would make it answer neither.
import React, { useEffect, useRef, useState } from 'react';
import { Bell, Circle, ChevronRight } from 'lucide-react';
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

function GroupHeading({ children }) {
  return (
    <div style={{
      padding: '9px 14px 6px', background: '#F7FAFC',
      borderBottom: `1px solid ${BRAND.border}`,
      fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase',
      color: BRAND.muted,
    }}>
      {children}
    </div>
  );
}

export default function NotificationBell({ compact = false }) {
  const { notifications, unreadCount, openTasks, markRead, markAllRead } = usePortal();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const tasks = openTasks || [];
  // One number for "anything waiting on me?". A client doesn't care which of
  // the two lists a thing came from until they've opened the bell.
  const badge = unreadCount + tasks.length;

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

  // Nothing to mark read — a task leaves the list by being done.
  const onTask = (t) => {
    if (t.link) window.location.hash = t.link;
    setOpen(false);
  };

  const multiProject = new Set(tasks.map((t) => t.dealId)).size > 1;

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        aria-label="Notifications"
        style={{ background: 'none', border: 'none', color: '#B9CBD6', cursor: 'pointer', padding: 6, display: 'flex', position: 'relative' }}
      >
        <Bell size={compact ? 20 : 17} />
        {badge > 0 && (
          <span style={{
            position: 'absolute', top: 0, right: 0,
            minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8,
            background: '#EF4444', color: '#fff', fontSize: 10, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
          }}>
            {badge > 9 ? '9+' : badge}
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
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            {tasks.length === 0 && notifications.length === 0 ? (
              <div style={{ padding: '28px 16px', textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>
                You're all caught up.
              </div>
            ) : (
              <>
                {tasks.length > 0 && (
                  <>
                    <GroupHeading>Your tasks · {tasks.length} to do</GroupHeading>
                    {tasks.map((t) => (
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
                          {/* Only worth naming the project when they have more
                              than one — otherwise it's the same words on every
                              row telling them nothing. */}
                          {multiProject && t.dealTitle && (
                            <span style={{ display: 'block', fontSize: 11, color: BRAND.muted, marginTop: 3, fontWeight: 600 }}>
                              {t.dealTitle}
                            </span>
                          )}
                        </span>
                        <ChevronRight size={15} color={BRAND.muted} style={{ flexShrink: 0, marginTop: 4 }} />
                      </button>
                    ))}
                  </>
                )}

                {notifications.length > 0 && (
                  <>
                    {tasks.length > 0 && <GroupHeading>Updates</GroupHeading>}
                    {notifications.map((n) => (
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
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
