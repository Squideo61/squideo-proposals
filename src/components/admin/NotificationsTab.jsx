import React, { useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { Badge } from '../ui.jsx';
import { NOTIFICATIONS } from '../../lib/notifications.js';

// "Who gets what" overview. For each notification key, lists the users who
// would be in the recipient set for a broadcast-audience send right now.
// Owner/assignee audience notifications can't be rolled up without a record
// context, so they're flagged as "depends on the deal/task".
export function NotificationsTab() {
  const { state } = useStore();
  const users = Object.values(state.users || {});
  const roles = state.roles || {};

  // Per-user prefs loaded lazily — we hit /api/users?_kind=notifications for
  // each user the first time the page renders. Small workspaces (the only
  // ones using this tool today) make this trivial; if a workspace ever grows
  // to 50+ this should switch to a single rollup endpoint instead.
  const [prefsByUser, setPrefsByUser] = useState({}); // email -> { key: enabled }
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all(users.map(u =>
      fetch('/api/users?_kind=notifications&email=' + encodeURIComponent(u.email), { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(j => [u.email, j])
        .catch(() => [u.email, null])
    )).then((entries) => {
      if (cancelled) return;
      const map = {};
      for (const [email, data] of entries) {
        if (!data) continue;
        map[email] = {};
        for (const n of NOTIFICATIONS) {
          map[email][n.key] = !!data.effective?.[n.key]?.enabled;
        }
      }
      setPrefsByUser(map);
      setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users.length]);

  if (loading) {
    return <div style={{ padding: 24, color: BRAND.muted, fontSize: 13 }}>Loading recipient rollup…</div>;
  }

  return (
    <>
      <h3 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 700 }}>Who gets what</h3>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: BRAND.muted }}>
        For broadcast notifications, every subscribed user gets the email.
        For ownership-bound notifications (proposal first-view, task reminders)
        the recipient is determined by the deal / task, then filtered by their
        own preference.
      </p>

      <div style={{ display: 'grid', gap: 12 }}>
        {NOTIFICATIONS.map(n => {
          const subscribed = users
            .filter(u => prefsByUser[u.email]?.[n.key])
            .map(u => u.name || u.email);
          return (
            <div key={n.key} style={{
              background: 'white',
              border: '1px solid ' + BRAND.border,
              borderRadius: 8,
              padding: 14,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{n.label}</div>
                  <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>{n.description}</div>
                </div>
                <Badge color={n.audience === 'broadcast' ? 'blue' : 'orange'}>
                  {n.audience}
                </Badge>
              </div>
              <div style={{ marginTop: 10, fontSize: 12 }}>
                {n.audience === 'broadcast' ? (
                  subscribed.length === 0
                    ? <span style={{ color: BRAND.muted }}>Nobody is currently subscribed.</span>
                    : <span><strong>{subscribed.length}</strong> recipient{subscribed.length === 1 ? '' : 's'}: {subscribed.join(', ')}</span>
                ) : (
                  <span style={{ color: BRAND.muted }}>
                    Recipient is determined per record (the {n.audience}). Subscribers ({subscribed.length}): {subscribed.join(', ') || 'none'}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
