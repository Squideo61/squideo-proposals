// Single-row scrolling reviews banner, built to be iframed into squideo.com.
//
// Plain DOM on purpose — this is a ~190px strip on a marketing page, so paying
// for React on every homepage view would be silly.
//
// Data comes from /api/reviews (our own Google reviews, synced nightly, showing
// only what someone approved in Admin → Reviews). ./reviewsData.js holds a
// bundled copy which renders first and stays on screen if the API is empty or
// unreachable — the banner is on the homepage, so "briefly stale" is a much
// better failure than "briefly blank".
//
// Query params (all optional), so the same embed can be dropped into different
// sections of the site without a rebuild:
//   ?theme=dark      cards go translucent-on-dark instead of white  (default: light)
//   ?speed=45        scroll speed in px/sec                          (default: 45)
//   ?summary=off     hide the pinned "5.0 / 115 Google reviews" pill (default: on)
//   ?direction=rtl   scroll left-to-right instead                    (default: right-to-left)
//   ?max=12          how many cards to show, of everything approved  (default: 12)

import { REVIEWS, SUMMARY } from './reviewsData.js';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const speed = Math.min(200, Math.max(5, Number(params.get('speed')) || 45));
const showSummary = params.get('summary') !== 'off';
const reverse = params.get('direction') === 'rtl';
// How many cards to show. Approving more in the CRM doesn't make the banner
// heavier — the API serves a random slice of this size and rotates it.
const max = Math.min(40, Math.max(1, Number(params.get('max')) || 12));

// Honoured, not merely respected: with reduced motion we drop the animation
// entirely and hand the user a normal horizontally-scrollable strip.
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

document.documentElement.dataset.theme = theme;

/* ---------------------------------------------------------------- helpers */

const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
};

const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

// Stable per-name colour so a given reviewer keeps the same avatar between
// loads and between the two rendered copies of the list.
const AVATAR_HUES = ['#2BB8E6', '#0F2A3D', '#E4780E', '#3E8E5A', '#8A5CD1', '#C2456B'];
const avatarColour = (name) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length];
};

const googleMark = (size = 16) => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('gmark');
  const paths = [
    ['#4285F4', 'M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z'],
    ['#34A853', 'M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z'],
    ['#FBBC05', 'M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z'],
    ['#EA4335', 'M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z']
  ];
  for (const [fill, d] of paths) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('fill', fill);
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
};

const starRow = (stars) => {
  const row = el('div', 'stars');
  row.setAttribute('role', 'img');
  row.setAttribute('aria-label', `${stars} out of 5 stars`);
  for (let i = 1; i <= 5; i++) {
    row.appendChild(el('span', i <= stars ? 'star on' : 'star', '★'));
  }
  return row;
};

/* ------------------------------------------------------------------ cards */

function card(review, href) {
  // An anchor when we can link out, a plain article when we can't — rather than
  // a div with a click handler, which keyboard and middle-click both lose.
  const art = el(href ? 'a' : 'article', 'card');
  if (href) {
    art.href = href;
    art.target = '_blank';
    art.rel = 'noopener noreferrer';
    art.title = 'Read our reviews on Google';
  }

  const head = el('div', 'card-head');

  // Initials sit underneath as the resting state; a photo, if we have one,
  // covers them. So a missing or dead image degrades to something deliberate
  // rather than a broken-image glyph.
  const av = el('div', 'avatar', initials(review.name));
  av.style.background = avatarColour(review.name);
  av.setAttribute('aria-hidden', 'true');
  if (review.photo) {
    const img = el('img', 'avatar-img');
    img.src = review.photo;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    // Google reissues profile photo URLs when someone changes their picture,
    // so these do rot. Drop the img and let the initials show through.
    img.addEventListener('error', () => img.remove());
    av.appendChild(img);
  }
  head.appendChild(av);

  const who = el('div', 'who');
  who.appendChild(el('div', 'name', review.name));
  who.appendChild(starRow(review.stars));
  head.appendChild(who);

  if (review.source === 'google') {
    const badge = el('span', 'badge');
    badge.title = 'Google review';
    badge.appendChild(googleMark(15));
    head.appendChild(badge);
  }

  art.appendChild(head);
  art.appendChild(el('p', 'text', review.text));
  return art;
}

function summaryPill(summary) {
  const a = el(summary.href ? 'a' : 'div', 'summary');
  if (summary.href) {
    a.href = summary.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  if (summary.source === 'google') a.appendChild(googleMark(22));
  const body = el('div', 'summary-body');
  const top = el('div', 'summary-top');
  if (summary.rating) top.appendChild(el('span', 'summary-rating', summary.rating));
  top.appendChild(starRow(5));
  body.appendChild(top);
  body.appendChild(el('div', 'summary-count', `${summary.count} reviews`));
  a.appendChild(body);
  return a;
}

/* ----------------------------------------------------------------- render */

const root = document.getElementById('reviews-root');
let cleanup = null;

function render(reviews, summary, profileUrl) {
  // A re-render replaces the whole strip, so tear down the listeners the last
  // one attached rather than stacking a second set on top.
  if (cleanup) cleanup();
  root.textContent = '';

  const wrap = el('div', 'wrap');
  if (showSummary && summary?.count) wrap.appendChild(summaryPill(summary));

  const marquee = el('div', 'marquee');
  const track = el('div', 'track');
  if (reverse) track.classList.add('reverse');

  // Appends one full copy of the list. Copies after the first are decoration —
  // screen readers should hear each review once.
  let copies = 0;
  function appendCopy() {
    const decorative = copies > 0;
    for (const r of reviews) {
      const node = card(r, profileUrl);
      if (decorative) {
        node.setAttribute('aria-hidden', 'true');
        // Cards are links now, and a focusable element inside aria-hidden is a
        // trap: a keyboard user tabs into something screen readers insist isn't
        // there. Take the copies out of the tab order.
        node.tabIndex = -1;
      }
      track.appendChild(node);
    }
    copies++;
  }

  appendCopy();
  marquee.appendChild(track);
  wrap.appendChild(marquee);
  root.appendChild(wrap);

  if (reduceMotion) {
    marquee.classList.add('static');
    cleanup = null;
    return;
  }

  appendCopy(); // need at least two so there's something to scroll into view

  const layout = () => {
    const cards = track.children;
    if (cards.length <= reviews.length) return;
    // One period is the distance from a card to its twin in the next copy.
    // Measuring it beats translating by -50%: a card's trailing margin isn't
    // counted consistently in scrollWidth across engines, and being a few px
    // out means a visible jolt on every single pass.
    const period = cards[reviews.length].offsetLeft - cards[0].offsetLeft;
    if (!period) return;

    // If the strip is wider than one copy, the tail of the last copy scrolls
    // off into empty space. Pad with extra copies until it can't.
    while (track.offsetWidth < period + marquee.clientWidth) appendCopy();

    track.style.setProperty('--shift', `${period}px`);
    // Constant perceived speed no matter how many reviews are in the list.
    track.style.setProperty('--dur', `${period / speed}s`);
  };

  layout();
  // Web fonts landing late changes every card's width, so re-measure.
  if (document.fonts?.ready) document.fonts.ready.then(layout);
  window.addEventListener('resize', layout);
  cleanup = () => window.removeEventListener('resize', layout);
}

/* ------------------------------------------------------------------- data */

// Bundled copy first, so the strip is never empty while the network happens.
render(REVIEWS, SUMMARY, SUMMARY.href || null);

// Then upgrade to the live list. An empty or failed response deliberately
// changes nothing — what's already on screen is the fallback.
fetch('/api/reviews?max=' + max, { headers: { Accept: 'application/json' } })
  .then((r) => (r.ok ? r.json() : null))
  .then((json) => {
    const live = (json?.reviews || []).filter((r) => r?.name && r?.text);
    if (!live.length) return;
    render(live, json.summary || SUMMARY, json.profileUrl || SUMMARY.href || null);
    reportHeight();
  })
  .catch(() => { /* keep the bundled list; nothing useful to do here */ });

/* ----------------------------------------------- tell the parent our height */

// Duda iframes take a fixed height, but if we're ever embedded somewhere that
// can listen, let it size us properly.
function reportHeight() {
  const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
  try {
    parent.postMessage({ type: 'squideo:reviews:height', height: h }, '*');
  } catch {
    /* cross-origin parent that refuses messages — nothing to do */
  }
}
reportHeight();
window.addEventListener('resize', reportHeight);
if (document.fonts?.ready) document.fonts.ready.then(reportHeight);
