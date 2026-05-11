// Content-script entry. Loads InboxSDK, registers handlers that mount the
// Squideo sidebar on every thread that opens, and reacts to compose / nav
// surfaces in later stages.

import React from 'react';
import { createRoot } from 'react-dom/client';
import InboxSDK from '@inboxsdk/core';
import { Sidebar } from './Sidebar.jsx';
import { chipResolver } from './chipResolver.js';
import { installBoxesNav } from './BoxesNav.jsx';
import { ComposeBar } from './ComposeBar.jsx';
import { openQuickAddTask } from './QuickAddTask.jsx';
import { api, auth } from '../lib/api.js';

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

    // Quick-add task toolbar button. Must be registered before the toolbar
    // is finalised by InboxSDK, so we add it immediately and do the deal
    // lookup lazily on click rather than up front.
    threadView.addToolbarButton({
      title: 'Add Squideo task',
      iconUrl: chrome.runtime.getURL('icon-16.png'),
      onClick: async () => {
        try {
          const linkResp = await api.get('/api/crm/threads/by-thread-ids?ids=' + encodeURIComponent(gmailThreadId));
          const links = Array.isArray(linkResp?.[gmailThreadId]) ? linkResp[gmailThreadId] : [];
          const primaryDealId = links[0]?.dealId || null;
          const primaryDealTitle = links[0]?.title || null;
          if (!primaryDealId) return; // thread not linked yet — sidebar handles that
          openQuickAddTask({ dealId: primaryDealId, dealTitle: primaryDealTitle, gmailThreadId });
        } catch (err) {
          console.warn('[Squideo] toolbar button: deal lookup failed', err);
        }
      },
    });

    threadView.on('destroy', () => root.unmount());
  });

  // -------- Compose helpers --------
  // Every compose window (new, reply, forward) gets a status bar with a
  // deal picker + template dropdown. On send, if a deal is selected, we
  // attach the freshly-sent message to it as soon as Gmail emits its
  // thread/message IDs.
  if (status.connected) {
    sdk.Compose.registerComposeViewHandler((composeView) => {
      installComposeBar(composeView).catch(err =>
        console.warn('[Squideo] ComposeBar install failed', err));
    });
  }
}

async function installComposeBar(composeView) {
  // Resolve a sensible default deal for the compose:
  //   - Reply: use the thread's currently-linked deal (if any).
  //   - New compose: try to match the To recipient against a deal contact.
  let initialDealId = null;
  let initialDealTitle = null;
  let initialDealStage = null;

  if (composeView.isReply && composeView.isReply()) {
    try {
      const threadId = composeView.getThreadID && composeView.getThreadID();
      if (threadId) {
        const r = await api.get('/api/crm/threads/by-thread-ids?ids=' + encodeURIComponent(threadId));
        const deals = Array.isArray(r?.[threadId]) ? r[threadId] : [];
        if (deals.length) {
          initialDealId = deals[0].dealId;
          initialDealTitle = deals[0].title;
          initialDealStage = deals[0].stage;
        }
      }
    } catch { /* best effort */ }
  }
  if (!initialDealId) {
    try {
      const recipients = composeView.getToRecipients() || [];
      const firstEmail = recipients[0]?.emailAddress;
      if (firstEmail) {
        const matches = await api.get('/api/crm/threads/by-contact?email=' + encodeURIComponent(firstEmail));
        if (Array.isArray(matches) && matches.length) {
          initialDealId = matches[0].id;
          initialDealTitle = matches[0].title;
          initialDealStage = matches[0].stage;
        }
      }
    } catch { /* best effort */ }
  }

  // Status bar mount. height ~36 fits one row of pill + button comfortably.
  const statusBar = composeView.addStatusBar({ height: 36, orderHint: 100 });
  const el = statusBar.el || statusBar.getElement?.();
  if (!el) return;
  const root = createRoot(el);
  const controllerRef = { current: null };

  root.render(
    <ComposeBar
      initialDealId={initialDealId}
      initialDealTitle={initialDealTitle}
      initialDealStage={initialDealStage}
      controllerRef={controllerRef}
      insertHTML={(html) => composeView.insertHTMLIntoBodyAtCursor(html)}
    />
  );

  composeView.on('destroy', () => {
    try { root.unmount(); } catch {}
  });

  // After send: if a deal is selected, attach the new message to it.
  // event.data.getThreadID() / getMessageID() return the IDs Gmail assigned
  // to the sent message; we POST those to /api/crm/threads so the timeline
  // updates immediately rather than waiting on Pub/Sub.
  composeView.getEventStream().filter(e => e.eventName === 'sent').onValue(async (event) => {
    try {
      const dealId = controllerRef.current?.getSelectedDealId();
      if (!dealId) return;
      const [gmailThreadId, gmailMessageId] = await Promise.all([
        event.data?.getThreadID(),
        event.data?.getMessageID(),
      ]);
      if (!gmailThreadId || !gmailMessageId) return;

      // Recipient info for the snapshot. Best-effort — server's auto-link
      // resolver will overwrite when Pub/Sub delivers the real message.
      let toEmails = [];
      let ccEmails = [];
      let subject = null;
      try {
        toEmails = (composeView.getToRecipients() || []).map(r => r.emailAddress).filter(Boolean);
        ccEmails = (composeView.getCcRecipients() || []).map(r => r.emailAddress).filter(Boolean);
        subject = composeView.getSubject ? composeView.getSubject() : null;
      } catch {}

      await api.post('/api/crm/threads', {
        gmailThreadId,
        gmailMessageId,
        dealId,
        direction: 'outbound',
        toEmails,
        ccEmails,
        subject,
        sentAt: new Date().toISOString(),
      });
      chipResolver.invalidate(gmailThreadId);
    } catch (err) {
      console.warn('[Squideo] post-send attach failed', err);
    }
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
