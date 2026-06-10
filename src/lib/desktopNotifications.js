// Thin wrapper around the browser's Web Notifications API.
//
// Tier 1 (current): notifications are fired from an open Squideo tab — see
// DesktopNotifier.jsx, which diffs the store's notification + task state and
// calls fireDesktopNotification() for genuinely new items.
//
// Tier 2 (future): true background push would move the firing into a service
// worker (registration.showNotification) driven by the Web Push API. The
// {title, body, link, tag} payload shape here is deliberately the same shape a
// push handler would consume, so the call sites and opt-in UI carry straight
// over — only the transport changes.

const PREF_KEY = 'squideo:desktopNotifications'; // 'on' | 'off' | unset

export function desktopNotificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

// The browser-level grant: 'default' (never asked), 'granted', or 'denied'.
export function getDesktopPermission() {
  if (!desktopNotificationsSupported()) return 'unsupported';
  return Notification.permission;
}

// User's own on/off toggle, layered on top of the browser grant so they can
// silence popups without revoking the permission. Defaults to on once granted.
export function getDesktopPref() {
  try {
    const v = localStorage.getItem(PREF_KEY);
    if (v === 'off') return 'off';
    return 'on';
  } catch { return 'on'; }
}

export function setDesktopPref(on) {
  try { localStorage.setItem(PREF_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
}

// True when we should actually surface popups: supported, granted, and not
// muted by the user.
export function desktopNotificationsEnabled() {
  return getDesktopPermission() === 'granted' && getDesktopPref() === 'on';
}

// Prompt for permission. Resolves to the resulting permission string. Safe to
// call when already granted/denied (returns the current state without a prompt).
export async function requestDesktopPermission() {
  if (!desktopNotificationsSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') setDesktopPref(true);
    return result;
  } catch {
    return Notification.permission;
  }
}

// Fire a single desktop notification. `onOpen(link)` is invoked when the user
// clicks it (we also focus the window). `tag` collapses repeat notifications
// for the same subject so a re-poll can't stack duplicates.
export function fireDesktopNotification({ title, body, link, tag, icon = '/squideo-favicon.png' }, onOpen) {
  if (!desktopNotificationsEnabled()) return null;
  try {
    const n = new Notification(title, { body: body || undefined, tag, icon, renotify: false });
    n.onclick = () => {
      try { window.focus(); } catch { /* ignore */ }
      if (link) { try { onOpen?.(link); } catch { /* ignore */ } }
      n.close();
    };
    return n;
  } catch {
    // Some browsers throw if called without a user gesture / in odd states.
    return null;
  }
}
