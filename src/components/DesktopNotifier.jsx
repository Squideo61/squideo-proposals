import { useEffect, useRef } from 'react';
import { useStore } from '../store.jsx';
import { fireDesktopNotification } from '../lib/desktopNotifications.js';

// Tier 1 desktop notifications: fires OS popups from an open Squideo tab by
// diffing the store's polled state for genuinely new items. Renders nothing.
//
//  - Bell notifications (general + finance): popup on each new unread item.
//  - Task reminders: popup the moment a task crosses its due time ("triggered")
//    while the app is open. Tier 2 (push) covers the same events when the tab is
//    closed, tagged identically (notif-<id> / task-<id>) so the browser collapses
//    any overlap instead of double-alerting.
//
// `onOpenLink` is also used as the target for the service worker's click
// messages, so a click on a background push focuses this tab and routes in-app.
export function DesktopNotifier({ onOpenLink }) {
  const { state } = useStore();

  // Keep the latest navigation handler in a ref so notification/SW click
  // closures (created outside React's render) always call the current one.
  const openRef = useRef(onOpenLink);
  openRef.current = onOpenLink;
  const open = (link) => openRef.current?.(link);

  // ---- Bell notifications (general + finance) ----
  const seenNotifIds = useRef(null); // Set<string>; null until first seed
  useEffect(() => {
    const channels = state.notificationsByChannel || {};
    const allItems = [];
    for (const ch of ['general', 'finance']) {
      for (const n of (channels[ch]?.items || [])) allItems.push(n);
    }

    // First pass: seed what's already on screen so opening the app doesn't
    // replay a popup for every pre-existing unread item.
    if (seenNotifIds.current === null) {
      seenNotifIds.current = new Set(allItems.map(n => n.id));
      return;
    }

    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    for (const n of allItems) {
      if (seenNotifIds.current.has(n.id)) continue;
      seenNotifIds.current.add(n.id);
      // Only the genuinely new + unread + recent should pop.
      if (n.read) continue;
      if (n.createdAt && new Date(n.createdAt).getTime() < tenMinAgo) continue;
      fireDesktopNotification(
        { title: n.title, body: n.body, link: n.link, tag: `notif-${n.id}` },
        open,
      );
    }
  }, [state.notificationsByChannel]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Task reminders (crossing their due time) ----
  const notifiedTaskIds = useRef(null); // Set<id>; null until first seed
  useEffect(() => {
    const check = () => {
      const tasks = state.tasks || [];
      const now = Date.now();
      const deals = state.deals || {};

      // Seed on first run with everything already due, so we never blast popups
      // for old overdue tasks when the app loads — only future crossings fire.
      if (notifiedTaskIds.current === null) {
        notifiedTaskIds.current = new Set(
          tasks.filter(t => !t.doneAt && t.dueAt && new Date(t.dueAt).getTime() <= now).map(t => t.id),
        );
        return;
      }

      for (const t of tasks) {
        const due = t.dueAt ? new Date(t.dueAt).getTime() : null;
        const isDue = !t.doneAt && due != null && due <= now;
        if (!isDue) {
          // Reset so a task that's completed or re-dated into the future can
          // legitimately re-fire if it later becomes due again.
          notifiedTaskIds.current.delete(t.id);
          continue;
        }
        if (notifiedTaskIds.current.has(t.id)) continue;
        notifiedTaskIds.current.add(t.id);
        const deal = t.dealId ? deals[t.dealId] : null;
        fireDesktopNotification(
          {
            title: `Task due: ${t.title}`,
            body: deal ? deal.title : (t.notes || undefined),
            link: t.dealId ? `#/deal/${t.dealId}` : '#/tasks',
            tag: `task-${t.id}`,
          },
          open,
        );
      }
    };

    check();
    // Tasks can cross their due time between 60s polls, so also tick locally.
    const interval = setInterval(check, 30_000);
    return () => clearInterval(interval);
  }, [state.tasks, state.deals]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Service worker click routing (Tier 2) ----
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined;
    const onMsg = (e) => {
      if (e.data?.type === 'squideo:navigate' && e.data.link) open(e.data.link);
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
