// First-touch marketing attribution, parsed from the page's own URL.
//
// Two surfaces need this and used to have one copy each: /quote (when opened
// directly rather than iframed, where the parent page's track.js hands it over
// by postMessage instead) and /course, which is always a top-level page and so
// always parses its own URL.
//
// The server never trusts these values — api/_lib/leadAttribution.js re-derives
// the channel from the raw click ids. This is a carrier, not a classifier.

// Query param → the field name the API expects.
const PARAM_MAP = {
  gclid: 'gclid', gbraid: 'gbraid', wbraid: 'wbraid', fbclid: 'fbclid', msclkid: 'msclkid',
  utm_source: 'source', utm_medium: 'medium', utm_campaign: 'campaign',
  utm_term: 'term', utm_content: 'content',
  campaignid: 'campaignId', adgroupid: 'adgroupId', keyword: 'keyword',
  matchtype: 'matchtype', network: 'network', device: 'device',
};

// Returns the attribution captured from the current URL, or null when the visit
// carries none (a direct type-in, an untagged link).
export function attributionFromUrl(search = window.location.search) {
  try {
    const p = new URLSearchParams(search);
    const a = {};
    let any = false;
    for (const [param, field] of Object.entries(PARAM_MAP)) {
      const v = p.get(param);
      if (v) { a[field] = v; any = true; }
    }
    if (!any) return null;
    a.referrer = document.referrer || null;
    a.landingUrl = window.location.href;
    a.firstSeenAt = Date.now();
    return a;
  } catch {
    return null;
  }
}

const STORE_KEY = 'squideo:attr';

// FIRST touch wins. Someone can arrive from an ad, read the course over a week,
// and come back by typing the URL — the ad is still what earned the lead, so a
// later untagged visit must not overwrite it.
//
// Survives the /course → signup → /portal navigation and any quote submitted
// from inside the portal later, which is the whole point of persisting it.
export function rememberAttribution(attr = attributionFromUrl()) {
  if (!attr) return storedAttribution();
  try {
    const existing = window.localStorage.getItem(STORE_KEY);
    if (existing) return JSON.parse(existing);
    window.localStorage.setItem(STORE_KEY, JSON.stringify(attr));
  } catch { /* private mode / storage full — attribution is not worth failing over */ }
  return attr;
}

export function storedAttribution() {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
