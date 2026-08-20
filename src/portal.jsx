import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import PortalApp from './portal/PortalApp.jsx';
import { setPreviewToken } from './portal/api.js';
import { setDemoState, readDemoStateFromUrl } from './portal/demo/portalDemo.js';

// Staff "preview as client": the token arrives in ?preview= and is stashed in
// sessionStorage (per-tab) BEFORE React mounts, so the very first `me` call
// already carries the preview header. Then it's stripped from the URL so it
// isn't shared or bookmarked.
(function capturePreview() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('preview');
  if (token) {
    setPreviewToken(token);
    params.delete('preview');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + (window.location.hash || ''));
  }
})();

// The admin portal demo arrives as ?demo=<state>. Captured BEFORE React
// mounts, for the same reason the preview token is: the very first `me`
// call has to already know it is answering from fixtures. Kept in the URL
// (unlike ?preview=) so the state is what the address bar says — that's how
// the admin panel switches states, by reloading its iframe.
(function captureDemo() {
  setDemoState(readDemoStateFromUrl());
})();

createRoot(document.getElementById('portal-root')).render(<PortalApp />);
