import React from 'react';
import { createRoot } from 'react-dom/client';
import { QuoteRequestForm } from './components/QuoteRequestForm.jsx';
import { attributionFromUrl, storedAttribution } from './lib/attribution.js';

// Marketing attribution lives outside React (it arrives asynchronously from the
// parent page and the form just reads the latest value at submit time).
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
  // it from our own URL (e.g. /quote?gclid=...&utm_source=...&campaignid=...).
  // Falls back to a first touch stored earlier by another top-level page (the
  // course landing page does this), so someone who arrived from an ad, took the
  // course, then came here still carries their real source.
  attribution = attributionFromUrl() || storedAttribution();
}

const container = document.getElementById('quote-root');
createRoot(container).render(<QuoteRequestForm getAttribution={getAttribution} />);

// Auto-resize: post the rendered height to the embedding page so the
// iframe can adjust. The parent can listen for window message events
// where data.type === 'squideo-quote-form:height'.
if (inIframe) {
  let lastHeight = 0;
  const sendHeight = () => {
    /*
     * ROUNDED UP, and measured off the rect as well as scrollHeight.
     *
     * scrollHeight is an integer. A document that lays out at 1073.41px
     * reports 1073, the embedding page sets the frame to exactly that, and the
     * leftover 0.41px is overflow — which some browsers draw a scrollbar for
     * and others quietly absorb. That is the scrollbar Adam had down the side
     * of the embedded quote form: not a height handshake that failed, one that
     * succeeded to the nearest pixel and left a fraction over.
     *
     * Rounding UP cannot run away, even though #quote-root is min-height:
     * 100vh and so grows to whatever the frame is set to: at 1074 the content
     * measures 1074, which ceils to 1074 again and stops. Rounding up by less
     * than a pixel is also invisible, where being a pixel short is not.
     */
    const h = Math.ceil(Math.max(
      document.documentElement.scrollHeight,
      document.documentElement.getBoundingClientRect().height,
    ));
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
