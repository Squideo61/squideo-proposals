// Content-script entry point. Loaded by Chrome inside every Gmail tab.
// Stage C ships only the InboxSDK skeleton + a tiny "Squideo connected"
// indicator on the right rail. Stages D/E/F/G/H add the real surfaces
// (sidebar, thread chips, Boxes nav, compose helpers, toolbar button).

import InboxSDK from '@inboxsdk/core';
import { auth } from '../lib/api.js';

const INBOXSDK_APP_ID = 'sdk_squideo_crm_0_1';

async function main() {
  // First, check if we have an auth token. If not, the sidebar will prompt
  // the user to connect via the popup. We don't block InboxSDK load on auth
  // — being signed out is a normal (transient) state.
  const status = await auth.status().catch(() => ({ connected: false }));

  const sdk = await InboxSDK.load(2, INBOXSDK_APP_ID, {
    suppressAddonTitle: 'Squideo',
  });

  // Sanity surface: every thread view gets a panel that confirms the
  // content script is running. Stage D replaces this with the real deal
  // context (linked deals, timeline, tasks, actions).
  sdk.Conversations.registerThreadViewHandler((threadView) => {
    const el = document.createElement('div');
    el.style.padding = '12px';
    el.style.fontFamily = '-apple-system, system-ui, sans-serif';
    el.innerHTML = `
      <div style="font-size:13px;font-weight:600;color:#0F2A3D;margin-bottom:6px">Squideo CRM</div>
      <div style="font-size:12px;color:#6B7785">
        ${status.connected
          ? 'Connected. Deal context arrives in the next release.'
          : 'Not connected. Click the Squideo extension icon to sign in.'}
      </div>
    `;
    threadView.addSidebarContentPanel({
      title: 'Squideo',
      iconUrl: chrome.runtime.getURL('icon-48.png'),
      el,
    });
  });
}

main().catch((err) => {
  console.error('[Squideo extension] failed to start', err);
});
