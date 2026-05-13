import React from 'react';
import { createRoot } from 'react-dom/client';
import { QuoteRequestForm } from './components/QuoteRequestForm.jsx';

const container = document.getElementById('quote-root');
createRoot(container).render(<QuoteRequestForm />);

// Auto-resize: post the rendered height to the embedding page so the
// iframe can adjust. The parent can listen for window message events
// where data.type === 'squideo-quote-form:height'.
if (window.parent !== window) {
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
