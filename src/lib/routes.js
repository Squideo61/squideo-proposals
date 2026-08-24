// The one place a CRM view becomes a URL.
//
// Lived in App.jsx, which meant the nav could only ever be buttons: nothing
// else could work out what a destination's address was. Shared so every
// navigation control can be a real <a href> — which is what makes middle-click,
// ctrl-click and "open link in new tab" work, none of which a <button> can ever
// offer however many handlers are bolted onto it.
export function buildHash(view, id) {
  if (view === 'list') return '#/';
  return '#/' + view + (id ? '/' + encodeURIComponent(id) : '');
}

// True when a click carries a modifier the browser has its own plans for —
// a new tab, a new window, a download. Those must be left alone: intercepting
// them is exactly the bug this file exists to fix.
export function isPlainLeftClick(e) {
  return !e.defaultPrevented
    && e.button === 0
    && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
