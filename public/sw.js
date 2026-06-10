/* Squideo service worker — Web Push receiver for desktop notifications.
 *
 * Kept deliberately minimal: it exists only to show OS notifications when a
 * push arrives (incl. when no tab is open) and to focus/route the app when one
 * is clicked. No fetch handler, no caching — this is not a PWA offline shell.
 *
 * Payload shape (sent by api/_lib/push.js): { title, body, link, tag }. The
 * same {title, body, link, tag} shape the in-tab path uses, so behaviour stays
 * consistent across Tier 1 and Tier 2. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }
  const title = data.title || 'Squideo';
  const options = {
    body: data.body || undefined,
    icon: '/squideo-favicon.png',
    badge: '/squideo-favicon.png',
    tag: data.tag || undefined,
    data: { link: data.link || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data && event.notification.data.link;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Reuse an existing Squideo tab if one is open: focus it and let the app
    // do the in-app (hash) navigation so we don't trigger a full reload.
    for (const client of all) {
      if (client.url.includes(self.location.origin)) {
        await client.focus();
        if (link) client.postMessage({ type: 'squideo:navigate', link });
        return;
      }
    }
    // Otherwise open a fresh window straight to the deep link.
    if (self.clients.openWindow) {
      const url = link ? new URL(link, self.registration.scope).href : self.registration.scope;
      await self.clients.openWindow(url);
    }
  })());
});
