// Content-script entry. Loads InboxSDK, registers handlers that mount the
// Squideo sidebar on every thread that opens, and reacts to compose / nav
// surfaces in later stages.

import React from 'react';
import { createRoot } from 'react-dom/client';
import InboxSDK from '@inboxsdk/core';
import { Sidebar } from './Sidebar.jsx';
import { auth } from '../lib/api.js';

const INBOXSDK_APP_ID = 'sdk_SquideoCRM_398be07a2b';

// Proof-of-life beacon. If we see this in the console, the content script
// is being injected. If we don't, Chrome isn't running content.js at all.
console.log('[Squideo] content script booted', { url: location.href });

// Visible DOM beacon so we know the script ran even without devtools.
// Removed after the first sidebar renders successfully.
function paintDebugBanner(text, colour) {
  let el = document.getElementById('squideo-debug-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'squideo-debug-banner';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999999;padding:6px 10px;font:600 12px -apple-system,system-ui,sans-serif;color:white;text-align:center;';
    document.body.appendChild(el);
  }
  el.style.background = colour;
  el.textContent = text;
}
function removeDebugBanner() {
  const el = document.getElementById('squideo-debug-banner');
  if (el) el.remove();
}

paintDebugBanner('Squideo content script loaded — initialising…', '#2BB8E6');

async function main() {
  // Soft-check auth state. Sidebar still renders if disconnected — it just
  // shows a prompt to click the extension icon to sign in. The threadView
  // handler below short-circuits the API calls when disconnected.
  const status = await auth.status().catch(() => ({ connected: false }));
  console.log('[Squideo] auth status', status);

  paintDebugBanner('Squideo loading InboxSDK…', '#2BB8E6');
  // InboxSDK.load downloads its platform runtime from inboxsdk.com. If that's
  // blocked (CSP, network filter, enterprise policy) the promise hangs
  // forever. A timeout race forces a visible failure so we know WHY it stuck.
  const sdk = await Promise.race([
    InboxSDK.load(2, INBOXSDK_APP_ID, { suppressAddonTitle: 'Squideo' }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('InboxSDK.load timed out after 15s — check network/CSP for inboxsdk.com')),
      15000,
    )),
  ]);
  console.log('[Squideo] InboxSDK loaded');
  paintDebugBanner('Squideo InboxSDK loaded — waiting for thread to open', '#16A34A');

  sdk.Conversations.registerThreadViewHandler(async (threadView) => {
    console.log('[Squideo] threadView handler firing');
    removeDebugBanner();
    // Each rendered DOM container is owned by its sidebar React root, so
    // we capture both and tear them down when InboxSDK destroys the panel
    // (happens on thread close or navigation).
    const el = document.createElement('div');
    el.setAttribute('data-squideo-sidebar', '');
    const root = createRoot(el);

    threadView.addSidebarContentPanel({
      title: 'Squideo',
      iconUrl: chrome.runtime.getURL('icon-48.png'),
      el,
    });

    // Pull thread context. getThreadIDIfStableAsync resolves to null on
    // "dirty" threads (e.g. drafts), where we have no anchor to attach to.
    let gmailThreadId = null;
    try {
      gmailThreadId = await threadView.getThreadIDIfStableAsync();
    } catch (err) {
      console.warn('[Squideo] thread id resolution failed', err);
    }
    if (!gmailThreadId) {
      renderConnectedFallback(root, 'This thread can\'t be attached yet (still being drafted).');
      threadView.on('destroy', () => root.unmount());
      return;
    }

    // Pick a counterparty email: first sender that isn't the current user.
    let counterpartyEmail = null;
    try {
      const messageViews = threadView.getMessageViewsAll();
      for (const mv of messageViews) {
        const sender = mv.getSender();
        if (sender && sender.emailAddress) {
          counterpartyEmail = sender.emailAddress;
          break;
        }
      }
    } catch { /* best effort */ }

    if (!status.connected) {
      renderConnectedFallback(root, 'Click the Squideo extension icon in the toolbar to sign in.');
      threadView.on('destroy', () => root.unmount());
      return;
    }

    root.render(<Sidebar gmailThreadId={gmailThreadId} counterpartyEmail={counterpartyEmail} />);
    threadView.on('destroy', () => root.unmount());
  });
}

function renderConnectedFallback(root, message) {
  root.render(
    <div style={{ padding: 12, fontFamily: '-apple-system, system-ui, sans-serif', color: '#0F2A3D' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Squideo CRM</div>
      <div style={{ fontSize: 12, color: '#6B7785', lineHeight: 1.4 }}>{message}</div>
    </div>
  );
}

main().catch((err) => {
  console.error('[Squideo extension] failed to start', err);
  paintDebugBanner('Squideo failed to start: ' + (err?.message || err), '#DC2626');
});
