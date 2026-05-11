// Content-script entry. Loads InboxSDK, registers handlers that mount the
// Squideo sidebar on every thread that opens, and reacts to compose / nav
// surfaces in later stages.

import React from 'react';
import { createRoot } from 'react-dom/client';
import InboxSDK from '@inboxsdk/core';
import { Sidebar } from './Sidebar.jsx';
import { auth } from '../lib/api.js';

const INBOXSDK_APP_ID = 'sdk_squideo_crm_0_1';

async function main() {
  // Soft-check auth state. Sidebar still renders if disconnected — it just
  // shows a prompt to click the extension icon to sign in. The threadView
  // handler below short-circuits the API calls when disconnected.
  const status = await auth.status().catch(() => ({ connected: false }));

  const sdk = await InboxSDK.load(2, INBOXSDK_APP_ID, {
    suppressAddonTitle: 'Squideo',
  });

  sdk.Conversations.registerThreadViewHandler(async (threadView) => {
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
});
