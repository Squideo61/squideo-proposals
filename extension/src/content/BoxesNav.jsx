// Boxes left-nav + in-Gmail per-deal RouteView.
//
// On startup we fetch every open deal and add it as a sub-item under a
// top-level "Squideo Deals" nav section. Clicking a deal navigates to a
// custom route (#squideo-box/<dealId>) we register; the route renders a
// React-based table of every thread attached to that deal. Threads are
// clickable and use Gmail's native thread route to navigate.

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from '../lib/api.js';
import { STAGE_COLOURS } from '../lib/stages.js';

const BRAND = {
  ink:    '#0F2A3D',
  border: '#E5E9EE',
  muted:  '#6B7785',
};

const BOX_ROUTE_ID = 'squideo-box/:dealId';

// Used by the route view to navigate to a specific Gmail thread when the
// user clicks a row. Stored on first load so we don't need to pass it
// through React props.
let sharedSdk = null;

// Reference to the current nav section so we can tear it down and rebuild
// when the deal list changes (deletes, renames, new deals from the web app).
let currentSection = null;
let refreshTimer = null;
let refreshing = false;

async function rebuildDealsSection(sdk) {
  if (refreshing) return;
  refreshing = true;
  try {
    let deals;
    try {
      deals = await api.get('/api/crm/deals');
    } catch (err) {
      console.warn('[Squideo] could not load deals for nav', err);
      return;
    }
    if (!Array.isArray(deals)) return;

    const openDeals = deals
      .filter(d => d.stage !== 'lost')
      .sort((a, b) => new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0))
      .slice(0, 50);

    // Tear down the previous section before rebuilding. InboxSDK removes
    // child nav items along with the parent.
    if (currentSection) {
      try { currentSection.remove(); } catch (err) { /* already gone */ }
      currentSection = null;
    }

    if (!openDeals.length) return;

    currentSection = sdk.NavMenu.addNavItem({
      name: 'Squideo Deals',
      iconUrl: chrome.runtime.getURL('icon-48.png'),
      type: sdk.NavMenu.NavItemTypes?.NAVIGATION || 'NAVIGATION',
    });

    for (const deal of openDeals) {
      const colours = STAGE_COLOURS[deal.stage] || STAGE_COLOURS.lead;
      currentSection.addNavItem({
        name: deal.title,
        routeID: BOX_ROUTE_ID,
        routeParams: { dealId: deal.id },
        backgroundColor: colours.bg,
      });
    }
  } finally {
    refreshing = false;
  }
}

export async function installBoxesNav(sdk) {
  sharedSdk = sdk;

  // Register the route so it's a valid target even before the nav items
  // exist. Activation handler renders the per-deal thread list.
  sdk.Router.handleCustomRoute(BOX_ROUTE_ID, (routeView) => {
    const dealId = routeView.getParams().dealId;
    const el = routeView.getElement();
    el.innerHTML = '';
    const container = document.createElement('div');
    container.style.cssText = 'padding: 24px; background: #FAFBFC; min-height: 100vh; font-family: -apple-system, system-ui, sans-serif;';
    el.appendChild(container);
    const root = createRoot(container);
    root.render(<BoxRouteView dealId={dealId} />);
    routeView.on('destroy', () => root.unmount());
  });

  // Initial load.
  await rebuildDealsSection(sdk);

  // Re-sync when the user comes back to Gmail (typical flow: delete/rename
  // a deal in the web app, switch back to Gmail). Also poll every 2 minutes
  // as a fallback for cases where the focus event doesn't fire.
  const onFocus = () => rebuildDealsSection(sdk);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') rebuildDealsSection(sdk);
  });
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => rebuildDealsSection(sdk), 120_000);
}

function BoxRouteView({ dealId }) {
  const [state, setState] = useState({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get('/api/crm/deals/' + encodeURIComponent(dealId)),
      api.get('/api/crm/deals/' + encodeURIComponent(dealId) + '/threads'),
    ])
      .then(([deal, threads]) => {
        if (!cancelled) setState({ phase: 'ready', deal, threads: threads || [] });
      })
      .catch((err) => {
        if (!cancelled) setState({ phase: 'error', message: err?.message || 'Failed to load' });
      });
    return () => { cancelled = true; };
  }, [dealId]);

  if (state.phase === 'loading') {
    return <Centered>Loading box…</Centered>;
  }
  if (state.phase === 'error') {
    return <Centered colour="#DC2626">Couldn&apos;t load box: {state.message}</Centered>;
  }

  const { deal, threads } = state;
  const c = STAGE_COLOURS[deal.stage] || STAGE_COLOURS.lead;
  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <header style={{ marginBottom: 24, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: BRAND.ink }}>{deal.title}</h1>
          <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{
              padding: '2px 8px', borderRadius: 4, background: c.bg, color: c.fg,
              fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4,
            }}>{deal.stage}</span>
            {deal.value != null && (
              <span style={{ fontSize: 13, color: BRAND.ink, fontWeight: 600 }}>
                £{Number(deal.value).toLocaleString('en-GB')}
              </span>
            )}
            {deal.ownerEmail && (
              <span style={{ fontSize: 12, color: BRAND.muted }}>{deal.ownerEmail}</span>
            )}
          </div>
        </div>
        <a
          href={'https://squideo-proposals-tu96.vercel.app/?deal=' + encodeURIComponent(deal.id)}
          target="_blank" rel="noopener noreferrer"
          style={{
            background: '#2BB8E6', color: 'white', textDecoration: 'none',
            padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          Open in Squideo →
        </a>
      </header>

      <section>
        <h2 style={{ fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
          Threads on this box ({threads.length})
        </h2>
        {threads.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8, color: BRAND.muted, fontSize: 14 }}>
            No threads attached yet. Open one in your inbox and click &quot;Attach to this deal&quot; in the Squideo sidebar.
          </div>
        ) : (
          <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden' }}>
            {threads.map((t, i) => (
              <ThreadRow key={t.gmailThreadId} thread={t} first={i === 0} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ThreadRow({ thread, first }) {
  const openThread = () => {
    if (sharedSdk) {
      // Navigate to the Gmail thread view. NativeRouteIDs.THREAD takes the
      // gmail thread id and Gmail routes us to it. The sidebar's threadView
      // handler then lights up with the deal context.
      sharedSdk.Router.goto(sharedSdk.Router.NativeRouteIDs.THREAD, { threadID: thread.gmailThreadId });
    } else {
      // Fallback if for some reason sdk is unavailable.
      location.hash = '#all/' + thread.gmailThreadId;
    }
  };
  return (
    <button
      onClick={openThread}
      style={{
        display: 'flex', width: '100%', textAlign: 'left',
        padding: '12px 16px', borderTop: first ? 'none' : '1px solid ' + BRAND.border,
        background: 'white', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
        gap: 12, alignItems: 'flex-start',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {thread.subject || <span style={{ color: BRAND.muted, fontStyle: 'italic' }}>(no subject)</span>}
        </div>
        {thread.participantEmails && thread.participantEmails.length > 0 && (
          <div style={{ marginTop: 2, fontSize: 12, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {thread.participantEmails.slice(0, 3).join(', ')}{thread.participantEmails.length > 3 ? ` +${thread.participantEmails.length - 3}` : ''}
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0, textAlign: 'right' }}>
        <div style={{ fontSize: 12, color: BRAND.muted }}>{formatDate(thread.lastMessageAt)}</div>
        {thread.messageCount > 1 && (
          <div style={{ marginTop: 2, fontSize: 11, color: BRAND.muted }}>{thread.messageCount} messages</div>
        )}
      </div>
    </button>
  );
}

function Centered({ children, colour }) {
  return (
    <div style={{ padding: 48, textAlign: 'center', color: colour || BRAND.muted, fontSize: 14 }}>
      {children}
    </div>
  );
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const days = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (days < 1) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (days < 7) return d.toLocaleDateString('en-GB', { weekday: 'short' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
