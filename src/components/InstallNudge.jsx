import React, { useEffect, useState } from 'react';
import { Bell, Download, Plus, Share, X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { enablePush, pushSupported } from '../lib/pushSubscribe.js';
import {
  desktopNotificationsSupported, getDesktopPermission, requestDesktopPermission,
} from '../lib/desktopNotifications.js';

// A dismissible bottom sheet that walks signed-in users through making the CRM a
// real mobile app: install it to the home screen, then turn on push. It picks
// the right step automatically:
//   • not installed, Android/Chrome → an Install button (native beforeinstallprompt)
//   • not installed, iOS Safari     → "Share → Add to Home Screen" instructions
//                                      (iOS has no programmatic install prompt)
//   • installed, push not yet on     → "Turn on notifications" (reuses enablePush)
// On iOS, Web Push only works once installed, so the install step gates the
// notification step naturally. Dismissal is remembered in localStorage.
const DISMISS_KEY = 'squideo.installNudge.dismissed';

function isStandalone() {
  try {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
  } catch { return false; }
}

function isIOS() {
  const ua = navigator.userAgent || '';
  // iPhone/iPod, plus iPadOS 13+ which masquerades as a Mac but is touch-capable.
  return /iphone|ipod|ipad/i.test(ua)
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

// Only nudge to install on a phone/tablet — desktop Chrome also fires
// beforeinstallprompt, but we don't want to pester desktop users to install.
function isMobileDevice() {
  try {
    return window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 1024;
  } catch { return false; }
}

export function InstallNudge() {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [standalone, setStandalone] = useState(isStandalone);
  const [perm, setPerm] = useState(() => getDesktopPermission());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Android/Chrome hands us the install prompt to defer and trigger later.
    const onBIP = (e) => { e.preventDefault(); setDeferredPrompt(e); };
    const onInstalled = () => { setStandalone(true); setDeferredPrompt(null); };
    const mq = window.matchMedia('(display-mode: standalone)');
    const onMq = () => setStandalone(isStandalone());
    window.addEventListener('beforeinstallprompt', onBIP);
    window.addEventListener('appinstalled', onInstalled);
    mq.addEventListener?.('change', onMq);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBIP);
      window.removeEventListener('appinstalled', onInstalled);
      mq.removeEventListener?.('change', onMq);
    };
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
  };

  const enableNotifications = async () => {
    setBusy(true);
    try {
      const result = await requestDesktopPermission();
      setPerm(result);
      if (result === 'granted') {
        await enablePush();
        dismiss();
      }
    } finally { setBusy(false); }
  };

  const installAndroid = async () => {
    if (!deferredPrompt) return;
    setBusy(true);
    try {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      setDeferredPrompt(null);
    } finally { setBusy(false); }
  };

  // Decide which step (if any) to show.
  let mode = null;
  if (standalone) {
    if (pushSupported() && desktopNotificationsSupported() && perm === 'default') mode = 'notifications';
  } else if (isMobileDevice() && deferredPrompt) {
    mode = 'install-android';
  } else if (isMobileDevice() && isIOS()) {
    mode = 'install-ios';
  }

  if (dismissed || !mode) return null;

  const sheet = {
    position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1600,
    background: 'white', borderTop: '1px solid ' + BRAND.border,
    boxShadow: '0 -8px 28px rgba(15,42,61,0.16)',
    padding: '16px 16px calc(16px + env(safe-area-inset-bottom))',
    display: 'flex', flexDirection: 'column', gap: 12,
  };
  const row = { display: 'flex', alignItems: 'flex-start', gap: 12 };
  const iconWrap = { flexShrink: 0, width: 38, height: 38, borderRadius: 10, background: '#EAF7FD', color: BRAND.blue, display: 'flex', alignItems: 'center', justifyContent: 'center' };
  const title = { fontSize: 15, fontWeight: 700, color: BRAND.ink, margin: 0 };
  const body = { fontSize: 13, color: BRAND.muted, margin: '2px 0 0', lineHeight: 1.4 };
  const closeBtn = { flexShrink: 0, border: 'none', background: 'transparent', color: BRAND.muted, cursor: 'pointer', padding: 4, marginLeft: 'auto' };

  return (
    <div style={sheet} role="dialog" aria-label="Install Squideo">
      {mode === 'notifications' && (
        <>
          <div style={row}>
            <div style={iconWrap}><Bell size={20} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={title}>Turn on notifications</p>
              <p style={body}>Get tasks, sign-offs and payment alerts pushed to this device — even when Squideo is closed.</p>
            </div>
            <button type="button" onClick={dismiss} aria-label="Dismiss" style={closeBtn}><X size={18} /></button>
          </div>
          <button type="button" className="btn" onClick={enableNotifications} disabled={busy} style={{ alignSelf: 'stretch', background: BRAND.blue, color: 'white', border: 'none', fontWeight: 600 }}>
            {busy ? 'Enabling…' : 'Enable notifications'}
          </button>
        </>
      )}

      {mode === 'install-android' && (
        <>
          <div style={row}>
            <div style={iconWrap}><Download size={20} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={title}>Install Squideo</p>
              <p style={body}>Add Squideo to your home screen for a full-screen app and push notifications.</p>
            </div>
            <button type="button" onClick={dismiss} aria-label="Dismiss" style={closeBtn}><X size={18} /></button>
          </div>
          <button type="button" className="btn" onClick={installAndroid} disabled={busy} style={{ alignSelf: 'stretch', background: BRAND.blue, color: 'white', border: 'none', fontWeight: 600 }}>
            {busy ? 'Installing…' : 'Install app'}
          </button>
        </>
      )}

      {mode === 'install-ios' && (
        <>
          <div style={row}>
            <div style={iconWrap}><Plus size={20} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={title}>Add Squideo to your Home Screen</p>
              <p style={body}>
                Tap the Share button <Share size={13} style={{ verticalAlign: 'middle' }} /> in Safari, then choose
                <strong style={{ color: BRAND.ink }}> “Add to Home Screen”</strong>. Open Squideo from there to enable push notifications.
              </p>
            </div>
            <button type="button" onClick={dismiss} aria-label="Dismiss" style={closeBtn}><X size={18} /></button>
          </div>
        </>
      )}
    </div>
  );
}
