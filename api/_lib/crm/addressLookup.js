// Postcode → address lookup, proxied to getAddress.io so the API key stays
// server-side. getAddress.io retired the old /find endpoint; the current API is
// Autocomplete + Get, so this works in two steps:
//
//   1. GET /api/crm/address-lookup?postcode=HU5+4BD
//        → { postcode, suggestions: [{ id, label }] }   (autocomplete)
//   2. GET /api/crm/address-lookup?id=<suggestion id>
//        → { address: { line1, line2, city, county, postcode, country } }  (get)
//
// Requires the GETADDRESS_API_KEY env var (set in Vercel). On a no-results /
// upstream error it returns 200 with an empty list plus a `detail` string so the
// form can show exactly what getAddress.io said.

const BASE = 'https://api.getaddress.io';

async function readBody(resp) {
  const text = await resp.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  const msg = json?.Message || json?.message || (text || '').slice(0, 200);
  return { json, msg };
}

export async function addressLookupRoute(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  // .trim() guards against a trailing space/newline in the Vercel env var, a
  // common cause of a spurious 401 from getAddress.
  const apiKey = (process.env.GETADDRESS_API_KEY || '').trim();
  if (!apiKey) return res.status(503).json({ error: 'Address lookup is not configured (GETADDRESS_API_KEY missing)' });

  const params = new URLSearchParams((req.url || '').split('?')[1] || '');
  const id = (params.get('id') || '').trim();
  const postcode = (params.get('postcode') || '').trim();

  // ── Step 2: resolve a chosen suggestion id to a full structured address ──
  if (id) {
    const url = `${BASE}/get/${encodeURIComponent(id)}?api-key=${encodeURIComponent(apiKey)}`;
    let resp;
    try {
      resp = await fetch(url);
    } catch (err) {
      console.error('[address-lookup] get fetch failed', err.message);
      return res.status(502).json({ error: 'Address lookup service unavailable' });
    }
    const { json, msg } = await readBody(resp);
    if (resp.status === 401) return res.status(503).json({ error: `Address lookup rejected the API key: ${msg || 'unauthorised'}` });
    if (resp.status === 429) return res.status(429).json({ error: 'Address lookup limit reached — try again shortly' });
    if (!resp.ok) {
      console.error('[address-lookup] get', resp.status, msg);
      return res.status(502).json({ error: `Address lookup failed (${resp.status})${msg ? ': ' + msg : ''}` });
    }
    const a = json || {};
    const line2 = [a.line_2, a.line_3, a.line_4].filter(Boolean).join(', ');
    return res.status(200).json({
      address: {
        line1: a.line_1 || '',
        line2,
        city: a.town_or_city || '',
        county: a.county || '',
        postcode: (a.postcode || '').toUpperCase(),
        country: a.country || 'United Kingdom',
      },
    });
  }

  // ── Step 1: autocomplete a postcode into a list of pickable addresses ──
  if (!postcode) return res.status(400).json({ error: 'postcode is required' });
  const term = postcode.toUpperCase();
  const url = `${BASE}/autocomplete/${encodeURIComponent(term)}?api-key=${encodeURIComponent(apiKey)}&all=true`;

  let resp;
  try {
    resp = await fetch(url);
  } catch (err) {
    console.error('[address-lookup] autocomplete fetch failed', err.message);
    return res.status(502).json({ error: 'Address lookup service unavailable' });
  }
  const { json, msg } = await readBody(resp);

  if (resp.status === 401) return res.status(503).json({ error: `Address lookup rejected the API key: ${msg || 'unauthorised'}` });
  if (resp.status === 429) return res.status(429).json({ error: 'Address lookup limit reached — try again shortly' });
  if (resp.status === 400 || resp.status === 404) {
    return res.status(200).json({ postcode: term, suggestions: [], detail: `${msg || 'No addresses found'} (getAddress ${resp.status})` });
  }
  if (!resp.ok) {
    console.error('[address-lookup] autocomplete', resp.status, msg);
    return res.status(502).json({ error: `Address lookup failed (${resp.status})${msg ? ': ' + msg : ''}` });
  }

  const suggestions = (json?.suggestions || []).map((s) => ({ id: s.id, label: s.address }));
  return res.status(200).json({ postcode: term, suggestions });
}
