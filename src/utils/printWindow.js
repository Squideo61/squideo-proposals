// Shared plumbing for the "open a blank window, write branded HTML, print it"
// pattern used by every client-facing doc (proposal, receipt, schedule, retainer).
//
// The written document inherits the app's CSP (`script-src 'self'`), so an
// inline `onclick="window.print()"` on the button is blocked and the button
// silently does nothing. Handlers have to be attached from app script instead,
// which is what writeDoc does.
export const PRINT_BTN_ID = 'sq-print-btn';

// Drop this into any printable HTML where the Print / Save as PDF button goes.
export function printButtonHTML(style = 'margin-left:16px;padding:6px 14px;background:#2BB8E6;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;') {
  return `<button type="button" id="${PRINT_BTN_ID}" style="${style}">Print / Save as PDF</button>`;
}

// Write the doc into an already-opened window and wire its print button up.
export function writeDoc(w, html) {
  w.document.write(html);
  w.document.close();
  const btn = w.document.getElementById(PRINT_BTN_ID);
  if (btn) btn.addEventListener('click', () => w.print());
}
