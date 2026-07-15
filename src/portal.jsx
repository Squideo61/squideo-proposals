import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import PortalApp from './portal/PortalApp.jsx';
import { setPreviewToken } from './portal/api.js';

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

createRoot(document.getElementById('portal-root')).render(<PortalApp />);
