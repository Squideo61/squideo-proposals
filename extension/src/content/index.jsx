// Content-script entry. Loads InboxSDK, registers handlers that mount the
// Squideo sidebar on every thread that opens, and reacts to compose / nav
// surfaces in later stages.

import React from 'react';
import { createRoot } from 'react-dom/client';
import InboxSDK from '@inboxsdk/core';
import { Sidebar } from './Sidebar.jsx';
import { chipResolver } from './chipResolver.js';
import { installBoxesNav } from './BoxesNav.jsx';
import { auth } from '../lib/api.js';

// Pipeline-stage palette mirrored from src/theme.js. Used by the inbox-row
// chip colouring so the chip's tint immediately conveys the deal's stage.
const STAGE_COLOURS = {
  lead:      { bg: '#F1F5F9', fg: '#475569' },
  qualified: { bg: '#FEF3C7', fg: '#92400E' },
  quoting:   { bg: '#DBEAFE', fg: '#1E40AF' },
  sent:      { bg: '#E0F2FE', fg: '#075985' },
  viewed:    { bg: '#CFFAFE', fg: '#0E7490' },
  signed:    { bg: '#DCFCE7', fg: '#166534' },
  paid:      { bg: '#D1FAE5', fg: '#065F46' },
  lost:      { bg: '#FEE2E2', fg: '#991B1B' },
};

const INBOXSDK_APP_ID = 'sdk_SquideoCRM_398be07a2b';

async function main() {
  // Soft-check auth state. Sidebar still renders if disconnected — it just
  // shows a prompt to click the extension icon to sign in. The threadView
  // handler below short-circuits the API calls when disconnected.
  const status = await auth.status().catch(() => ({ connected: false }));

  // 15s race so a hung InboxSDK.load (CSP/network/firewall on inboxsdk.com)
  // fails loudly instead of silently waiting forever.
  const sdk = await Promise.race([
    InboxSDK.load(2, INBOXSDK_APP_ID, { suppressAddonTitle: 'Squideo' }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('InboxSDK.load timed out after 15s — check network/CSP for inboxsdk.com')),
      15000,
    )),
  ]);

  // -------- Boxes left-nav + per-deal RouteView --------
  // Adds a "Squideo Deals" section to Gmail's left nav listing all open
  // deals, plus a custom in-Gmail route that shows every thread on a deal.
  if (status.connected) {
    installBoxesNav(sdk).catch(err => console.warn('[Squideo] BoxesNav install failed', err));
  }

  // -------- Inbox-row chips --------
  // Every thread row in any inbox/search/label view gets its deal chip(s)
  // resolved through the batching cache. Without batching this would fire
  // ~50 API calls per inbox render; with it, one bulk lookup per ~150ms.
  if (status.connected) {
    sdk.Lists.registerThreadRowViewHandler(async (threadRowView) => {
      try {
        const threadId = await threadRowView.getThreadIDAsync();
        if (!threadId) return;
        // Sender emails are pulled synchronously off the DOM so we always
        // have them in time for the batch flush. Used by the server as a
        // contact-match fallback when there's no explicit thread→deal row.
        let senderEmails = [];
        try {
          senderEmails = (threadRowView.getContacts() || [])
            .map(c => c?.emailAddress)
            .filter(Boolean);
        } catch { /* getContacts isn't available in every Gmail UI variant */ }
        const deals = await chipResolver.resolve(threadId, senderEmails);
        if (!deals || !deals.length) return;
        // Up to 2 chips per row to avoid clutter. The sidebar shows the rest
        // when the user actually opens the thread.
        for (const deal of deals.slice(0, 2)) {
          const c = STAGE_COLOURS[deal.stage] || STAGE_COLOURS.lead;
          try {
            threadRowView.addLabel({
              title: deal.title,
              foregroundColor: c.fg,
              backgroundColor: c.bg,
            });
          } catch (err) {
            // ThreadRowView may have been destroyed between resolve and add.
          }
        }
      } catch (err) {
        // Swallow per-row errors so one bad row doesn't break the inbox.
      }
    });
  }

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

    // Pull thread context. getThreadIDAsync resolves once Gmail's URL parses
    // into a known thread (works even for threads opened from search/labels).
    let gmailThreadId = null;
    try {
      gmailThreadId = await threadView.getThreadIDAsync();
    } catch (err) {
      console.warn('[Squideo] thread id resolution failed', err);
    }
    if (!gmailThreadId) {
      renderConnectedFallback(root, 'Squideo couldn\'t identify this thread — try refreshing.');
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
