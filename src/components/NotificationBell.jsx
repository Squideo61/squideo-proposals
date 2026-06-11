import React, { useEffect, useRef, useState } from 'react';
import { Bell, PoundSterling, Check, X, Monitor, Eye } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { formatRelativeTime, useIsMobile } from '../utils.js';
import {
  desktopNotificationsSupported, getDesktopPermission, getDesktopPref,
  setDesktopPref, requestDesktopPermission,
} from '../lib/desktopNotifications.js';
import { enablePush, disablePush } from '../lib/pushSubscribe.js';

// Per-channel presentation. 'general' is the standard bell; 'finance' is the £
// bell shown to its left for sales/money updates.
const CHANNEL_META = {
  general: { icon: Bell, label: 'Notifications', accent: BRAND.blue, badge: '#EF4444' },
  finance: { icon: PoundSterling, label: 'Sales & finance', accent: '#0E7490', badge: '#0E7490' },
  tracking: { icon: Eye, label: 'View Tracking', accent: '#16A34A', badge: '#16A34A' },
};

// Floating notification center. Mounted once at the app root so the bell is
// available on every screen. Sits in the right-hand gutter of the centered
// (max-width 1100) layout, clear of each view's own header on desktop.
//
// The feed is populated by the store's 60s poll (store.jsx); this component is
// purely presentational + marks things read. `onOpenLink` receives an in-app
// hash route (e.g. '#/admin/users') so clicking a notification navigates
// without a full reload. `channel` selects which feed/bell this instance is.
export function NotificationBell({ onOpenLink, inline = false, channel = 'general' }) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const meta = CHANNEL_META[channel] || CHANNEL_META.general;
  const Icon = meta.icon;
  const feed = (state.notificationsByChannel && state.notificationsByChannel[channel]) || { items: [], unread: 0 };
  const items = feed.items || [];
  const unread = feed.unread || 0;

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
    if (!n.read) actions.markNotificationsRead([n.id], channel);
    if (n.link) {
      setOpen(false);
      onOpenLink?.(n.link);
    }
  };

  const badge = String(unread);

  // Inline: flows inside the top bar's right-hand group. Floating: a fixed
  // pill in the corner, used on views that have no top bar (builder, client).
  const wrapStyle = inline
    ? { position: 'relative', zIndex: 95 }
    : { position: 'fixed', top: isMobile ? 10 : 14, right: isMobile ? 10 : 16, zIndex: 95 };

  return (
    <div ref={wrapRef} style={wrapStyle}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={unread > 0 ? `${meta.label} (${unread} unread)` : meta.label}
        title={meta.label}
        style={{
          position: 'relative',
          width: 40, height: 40, borderRadius: '50%',
          background: 'white', border: '1px solid ' + BRAND.border,
          boxShadow: inline ? 'none' : '0 2px 8px rgba(15,42,61,0.12)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: open ? meta.accent : BRAND.ink,
        }}
      >
        <Icon size={18} />
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: -3, right: -3, minWidth: 18, height: 18, padding: '0 4px',
            borderRadius: 999, background: meta.badge, color: 'white', fontSize: 10, fontWeight: 700,
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
            <strong style={{ fontSize: 14 }}>{meta.label}</strong>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {unread > 0 && (
                <button
                  onClick={() => actions.markAllNotificationsRead(channel)}
                  className="btn-ghost"
                  style={{ fontSize: 12, padding: '4px 8px' }}
                >
                  <Check size={13} /> Mark all read
                </button>
              )}
              {items.length > 0 && (
                <button
                  onClick={() => actions.clearNotifications(channel)}
                  className="btn-ghost"
                  style={{ fontSize: 12, padding: '4px 8px' }}
                >
                  Clear all
                </button>
              )}
              <button onClick={() => setOpen(false)} aria-label="Close" className="btn-icon"><X size={14} /></button>
            </div>
          </div>

          {/* Shown in both bells — desktop alerts are a single global toggle that
              already covers general + finance, so it's reachable from either. */}
          <DesktopAlertsRow />

          <div style={{ overflowY: 'auto' }}>
            {items.length === 0 ? (
              <div style={{ padding: '28px 16px', textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>
                You're all caught up.
              </div>
            ) : (
              items.map((n) => (
                <div
                  key={n.id}
                  style={{
                    display: 'flex', alignItems: 'stretch',
                    background: n.read ? 'white' : '#F0F9FF',
                    borderBottom: '1px solid ' + BRAND.border,
                  }}
                >
                  <button
                    onClick={() => onItemClick(n)}
                    style={{
                      display: 'block', flex: 1, minWidth: 0, textAlign: 'left', cursor: n.link ? 'pointer' : 'default',
                      background: 'transparent', border: 'none', padding: '12px 14px', font: 'inherit',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <span style={{
                        flexShrink: 0, marginTop: 6, width: 7, height: 7, borderRadius: '50%',
                        background: n.read ? 'transparent' : meta.accent,
                      }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: n.read ? 500 : 700, color: BRAND.ink, lineHeight: 1.35 }}>{n.title}</div>
                        {n.body && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2, lineHeight: 1.4 }}>{n.body}</div>}
                        <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4 }}>{formatRelativeTime(n.createdAt)}</div>
                      </div>
                    </div>
                  </button>
                  <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, padding: '8px 8px 0 0' }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); actions.dismissNotification(n.id, channel); }}
                      aria-label="Dismiss notification"
                      title="Dismiss"
                      style={{
                        padding: 4, background: 'transparent', border: 'none', borderRadius: 6, cursor: 'pointer',
                        color: BRAND.muted, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = BRAND.ink; e.currentTarget.style.background = BRAND.paper; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = BRAND.muted; e.currentTarget.style.background = 'transparent'; }}
                    >
                      <X size={13} />
                    </button>
                    {/* A "go to" affordance on tracking alerts — opens the email
                        (or the proposal's deal) the alert is about. */}
                    {channel === 'tracking' && n.link && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onItemClick(n); }}
                        title={/^https?:/i.test(n.link) ? 'Open the email' : 'Go to'}
                        style={{
                          fontSize: 11, fontWeight: 600, color: meta.accent, background: 'transparent',
                          border: '1px solid ' + BRAND.border, borderRadius: 6, padding: '2px 8px',
                          cursor: 'pointer', whiteSpace: 'nowrap',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        {/^https?:/i.test(n.link) ? 'Open email →' : 'Go to →'}
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Opt-in control for desktop notifications, shown at the top of the general
// bell's panel. Drives both tiers: requesting permission lights up the in-tab
// popups (Tier 1) and registers this browser for background push (Tier 2).
function DesktopAlertsRow() {
  const [perm, setPerm] = useState(() => getDesktopPermission());
  const [pref, setPref] = useState(() => getDesktopPref());
  const [busy, setBusy] = useState(false);

  if (!desktopNotificationsSupported()) return null;

  const enable = async () => {
    setBusy(true);
    try {
      const result = await requestDesktopPermission();
      setPerm(result);
      if (result === 'granted') {
        setDesktopPref(true);
        setPref('on');
        // Best-effort background push; in-tab alerts work regardless.
        await enablePush();
      }
    } finally { setBusy(false); }
  };

  const mute = async () => {
    setBusy(true);
    try {
      setDesktopPref(false);
      setPref('off');
      await disablePush();
    } finally { setBusy(false); }
  };

  const unmute = async () => {
    setBusy(true);
    try {
      setDesktopPref(true);
      setPref('on');
      await enablePush();
    } finally { setBusy(false); }
  };

  const wrap = {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border,
    background: '#FAFBFC', fontSize: 12.5, color: BRAND.muted,
  };
  const link = { background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: BRAND.blue, fontWeight: 600, font: 'inherit' };

  if (perm === 'denied') {
    return (
      <div style={wrap}>
        <Monitor size={14} />
        <span>Desktop alerts are blocked in your browser settings.</span>
      </div>
    );
  }

  if (perm === 'granted') {
    return (
      <div style={wrap}>
        <Monitor size={14} color={pref === 'on' ? '#16A34A' : BRAND.muted} />
        <span style={{ flex: 1 }}>Desktop alerts {pref === 'on' ? 'on' : 'off'}</span>
        {pref === 'on'
          ? <button onClick={mute} disabled={busy} style={link}>Mute</button>
          : <button onClick={unmute} disabled={busy} style={link}>Turn on</button>}
      </div>
    );
  }

  // permission === 'default' — never asked.
  return (
    <div style={wrap}>
      <Monitor size={14} />
      <span style={{ flex: 1 }}>Get task reminders &amp; alerts on your desktop.</span>
      <button onClick={enable} disabled={busy} style={link}>{busy ? 'Enabling…' : 'Enable'}</button>
    </div>
  );
}
