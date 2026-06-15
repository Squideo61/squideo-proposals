/*
 * Squideo lead-attribution tracker.
 *
 * Add to the squideo.com marketing site (sitewide, or as a GTM Custom HTML tag):
 *   <script src="https://app.squideo.com/track.js" async></script>
 *
 * On landing it captures first-touch attribution — Google/Microsoft/Facebook
 * click ids, UTM params and Google Ads ValueTrack params ({campaignid},
 * {keyword}, ...) plus the referrer and landing URL — and persists it (first
 * touch wins) in a first-party cookie + localStorage for 90 days. When the
 * embedded quote-form iframe asks for it (postMessage handshake), we hand it
 * over so the lead is submitted with its source attached.
 *
 * Self-contained, no dependencies, safe to load on any page.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'sq_attr';
  var MAX_AGE_DAYS = 90;
  // Only ever reply to the embedded form running on a Squideo app origin.
  var APP_ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)*squideo\.com$|^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

  function params() {
    try { return new URLSearchParams(window.location.search); } catch (e) { return new URLSearchParams(''); }
  }

  // Pull the fields we care about out of the current URL. Missing params are
  // simply absent from the returned object.
  function readFromUrl() {
    var p = params();
    var map = {
      // click ids
      gclid: 'gclid', gbraid: 'gbraid', wbraid: 'wbraid', fbclid: 'fbclid', msclkid: 'msclkid',
      // utm
      utm_source: 'source', utm_medium: 'medium', utm_campaign: 'campaign',
      utm_term: 'term', utm_content: 'content',
      // Google Ads ValueTrack
      campaignid: 'campaignId', adgroupid: 'adgroupId', keyword: 'keyword',
      matchtype: 'matchtype', network: 'network', device: 'device'
    };
    var out = {};
    Object.keys(map).forEach(function (key) {
      var v = p.get(key);
      if (v != null && String(v).trim() !== '') out[map[key]] = String(v).slice(0, 512);
    });
    return out;
  }

  function classify(a, referrer) {
    var medium = (a.medium || '').toLowerCase();
    var host = '';
    try { host = referrer ? new URL(referrer).hostname.toLowerCase() : ''; } catch (e) { host = ''; }
    if (a.gclid || a.gbraid || a.wbraid || a.msclkid) return 'paid_search';
    if (/(^|[-_ ])(cpc|ppc|paid|sem|paidsearch)([-_ ]|$)/.test(medium)) return 'paid_search';
    if (a.fbclid || /social/.test(medium) || /(facebook|instagram|linkedin|youtube|tiktok|pinterest|reddit|t\.co|twitter|x\.com)\./.test(host)) return 'social';
    if (medium === 'organic' || /(google|bing|yahoo|duckduckgo|ecosia|baidu|yandex|ask|aol)\./.test(host)) return 'organic';
    if (host) return 'referral';
    return 'direct';
  }

  function readStored() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* localStorage blocked */ }
    // Cookie fallback (e.g. localStorage disabled).
    try {
      var m = document.cookie.match(/(?:^|;\s*)sq_attr=([^;]+)/);
      if (m) return JSON.parse(decodeURIComponent(m[1]));
    } catch (e) { /* malformed */ }
    return null;
  }

  function persist(attr) {
    var json = JSON.stringify(attr);
    try { window.localStorage.setItem(STORAGE_KEY, json); } catch (e) { /* ignore */ }
    try {
      var maxAge = MAX_AGE_DAYS * 24 * 60 * 60;
      // Domain-wide so it's readable across www / subdomains of the marketing site.
      var domain = '';
      var h = window.location.hostname.replace(/^www\./, '');
      if (/squideo\.(com|co\.uk)$/.test(h)) domain = '; domain=.' + h;
      document.cookie = 'sq_attr=' + encodeURIComponent(json) +
        '; max-age=' + maxAge + '; path=/; samesite=lax' + domain +
        (window.location.protocol === 'https:' ? '; secure' : '');
    } catch (e) { /* ignore */ }
  }

  // Capture once per visit. First touch wins: if we already have a stored
  // attribution, keep it (so the original ad gets credit even if they later
  // arrive direct). We only overwrite when the existing record has no usable
  // source signal AND this visit does.
  function capture() {
    var fromUrl = readFromUrl();
    var existing = readStored();
    var hasNewSignal = Object.keys(fromUrl).length > 0;
    if (existing && (existing.gclid || existing.campaignId || existing.source || existing.medium)) {
      return existing; // first touch already recorded
    }
    if (!existing && !hasNewSignal && !document.referrer) {
      // Pure direct visit with nothing to record — still stamp a record so the
      // channel is 'direct' rather than null, but don't bother persisting noise.
    }
    var attr = {};
    Object.keys(fromUrl).forEach(function (k) { attr[k] = fromUrl[k]; });
    attr.referrer = document.referrer || null;
    attr.landingUrl = (window.location.href || '').slice(0, 1024);
    attr.firstSeenAt = Date.now();
    attr.channel = classify(attr, attr.referrer);
    persist(attr);
    return attr;
  }

  var attribution = capture();

  // Answer the quote-form iframe's request for attribution. The request arrives
  // from the iframe; we validate its origin against our app-origin allowlist and
  // reply only to the sender, at its own origin. The payload is non-sensitive
  // (marketing source data, no auth), so this is the appropriate trust level.
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'squideo-quote-form:attr-request') return;
    if (!APP_ORIGIN_RE.test(event.origin)) return;
    try {
      event.source.postMessage(
        { type: 'squideo-quote-form:attr', attribution: attribution },
        event.origin
      );
    } catch (e) { /* sender gone */ }
  });
})();
