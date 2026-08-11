// Entry point for /course — the public landing page for The Explainer Video
// Video Guide. Its own Vite bundle (like /quote and /contact) so an anonymous
// visitor never downloads the CRM or the authenticated portal.
//
// This page is always top-level (Duda hard-links to it rather than iframing —
// the sq_portal cookie is SameSite=Lax and would never be set inside a
// third-party frame), so attribution is parsed from its own URL, and the CSP
// block for /course in vercel.json keeps frame-ancestors 'none'.
//
// Two things about that CSP block, since vercel.json can carry no comments of
// its own (a "//" key fails Vercel's schema validation and breaks the build):
//   - a `source` block REPLACES the default block rather than merging with it,
//     so it has to repeat media-src for the blob host — the free video is a 302
//     to https://*.public.blob.vercel-storage.com and won't play without it;
//   - /course must also be added to the default block's negative lookahead, or
//     both blocks match and the stricter one wins.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { CoursePage } from './components/course/CoursePage.jsx';
import { rememberAttribution } from './lib/attribution.js';

// First touch wins and is persisted, so it survives this page → signup →
// portal, and is still attached to a quote request submitted weeks later.
rememberAttribution();

// A random per-tab id for the anonymous half of the funnel (page views and
// free-video plays that happen before anyone signs up). sessionStorage, not a
// cookie, and never joined to a person — so it needs no consent banner.
const visitorKey = (() => {
  try {
    const existing = window.sessionStorage.getItem('squideo:course:visitor');
    if (existing) return existing;
    const key = Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.sessionStorage.setItem('squideo:course:visitor', key);
    return key;
  } catch {
    return null;
  }
})();

// Fire-and-forget: analytics must never block the page or surface an error to
// a visitor. keepalive so a click that navigates away still records.
function track(eventKey, detail = null) {
  try {
    fetch('/api/course?action=event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        eventKey,
        visitorKey,
        slug: detail?.slug || null,
        detail: detail && Object.keys(detail).length ? detail : null,
      }),
    }).catch(() => {});
  } catch { /* ignore */ }
}

const container = document.getElementById('course-root');
container.innerHTML = '';   // drop the no-JS fallback markup
createRoot(container).render(<CoursePage track={track} />);
