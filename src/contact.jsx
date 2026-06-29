import React from 'react';
import { createRoot } from 'react-dom/client';
import { ContactForm } from './components/ContactForm.jsx';

// Marketing attribution lives outside React (it arrives asynchronously from the
// parent page and the form just reads the latest value at submit time). We reuse
// the SAME message namespace as the quote form (`squideo-quote-form:*`) so the
// track.js snippet already deployed on squideo.com answers us with zero changes.
let attribution = null;
const getAttribution = () => attribution;

const inIframe = window.parent !== window;

if (inIframe) {
  // Ask the embedding page (squideo.com, running /track.js) for the first-touch
  // attribution it captured on the landing page. Retried a few times because
  // track.js may load after us. The reply is handled below.
  const requestAttribution = () => {
    try {
      window.parent.postMessage({ type: 'squideo-quote-form:attr-request' }, '*');
    } catch { /* parent may reject — not critical */ }
  };
  window.addEventListener('message', (event) => {
    const data = event.data;
    // Accept only our attribution message. The payload is non-sensitive
    // (marketing source data, no auth), and event.origin here is the embedding
    // marketing site which is not a fixed value (squideo.com / a Duda preview),
    // so we gate on the message type rather than a strict origin allowlist.
    if (!data || data.type !== 'squideo-quote-form:attr') return;
    if (data.attribution && typeof data.attribution === 'object') {
      attribution = data.attribution;
    }
  });
  requestAttribution();
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (attribution || tries > 10) { clearInterval(timer); return; }
    requestAttribution();
  }, 300);
} else {
  // Direct visit / local QA: no embedding page to hand us attribution, so parse
  // it from our own URL (e.g. /contact?gclid=...&utm_source=...&campaignid=...).
  try {
    const p = new URLSearchParams(window.location.search);
    const map = {
      gclid: 'gclid', gbraid: 'gbraid', wbraid: 'wbraid', fbclid: 'fbclid', msclkid: 'msclkid',
      utm_source: 'source', utm_medium: 'medium', utm_campaign: 'campaign',
      utm_term: 'term', utm_content: 'content',
      campaignid: 'campaignId', adgroupid: 'adgroupId', keyword: 'keyword',
      matchtype: 'matchtype', network: 'network', device: 'device',
    };
    const a = {};
    let any = false;
    for (const [k, field] of Object.entries(map)) {
      const v = p.get(k);
      if (v) { a[field] = v; any = true; }
    }
    if (any) {
      a.referrer = document.referrer || null;
      a.landingUrl = window.location.href;
      a.firstSeenAt = Date.now();
      attribution = a;
    }
  } catch { /* ignore */ }
}

const container = document.getElementById('contact-root');
createRoot(container).render(<ContactForm getAttribution={getAttribution} />);

// Auto-resize: post the rendered height to the embedding page so the iframe can
// adjust. Reuses the quote form's `squideo-quote-form:height` message type so the
// existing embed snippet pattern works unchanged.
if (inIframe) {
  let lastHeight = 0;
  const sendHeight = () => {
    const h = document.documentElement.scrollHeight;
    if (h !== lastHeight) {
      lastHeight = h;
      try {
        window.parent.postMessage({ type: 'squideo-quote-form:height', height: h }, '*');
      } catch {
        /* parent might reject — not critical */
      }
    }
  };
  const ro = new ResizeObserver(sendHeight);
  ro.observe(document.documentElement);
  window.addEventListener('load', sendHeight);
  setTimeout(sendHeight, 200);
}
