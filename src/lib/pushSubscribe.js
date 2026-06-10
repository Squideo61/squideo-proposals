// Client side of Web Push (Tier 2). Registers the service worker, subscribes
// to the browser's push service using the server's VAPID public key, and posts
// the resulting subscription to /api/push so the cron can reach this device
// even when no tab is open.
//
// Everything here is best-effort and gated on real support: if the browser
// lacks service workers / PushManager, or the server hasn't been provisioned
// with VAPID keys, these resolve quietly and the app falls back to the in-tab
// (Tier 1) notifications in desktopNotifications.js.
import { api } from '../api.js';

export function pushSupported() {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && typeof window !== 'undefined'
    && 'PushManager' in window;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let swRegistration = null;
async function getRegistration() {
  if (swRegistration) return swRegistration;
  swRegistration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  return swRegistration;
}

// Register the SW + subscribe, then hand the subscription to the server.
// Idempotent: an existing subscription is reused. Returns true on success.
export async function enablePush() {
  if (!pushSupported()) return false;
  try {
    const { key } = await api.get('/api/push?action=public-key');
    if (!key) return false; // server not provisioned with VAPID keys

    const reg = await getRegistration();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }
    await api.post('/api/push?action=subscribe', { subscription: sub.toJSON() });
    return true;
  } catch (err) {
    console.warn('[push] enable failed', err?.message || err);
    return false;
  }
}

// Tear down this device's subscription (used when the user mutes desktop alerts).
export async function disablePush() {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
      await api.post('/api/push?action=unsubscribe', { endpoint }).catch(() => {});
    }
  } catch (err) {
    console.warn('[push] disable failed', err?.message || err);
  }
}
