// Postcode → address lookup, proxied to getAddress.io so the API key stays
// server-side. GET /api/crm/address-lookup?postcode=EC3R+8HL
//
// Requires the GETADDRESS_API_KEY env var (set in Vercel). Returns a normalised
// { postcode, addresses: [{ line1, line2, city, county, postcode, country, label }] }
// shape the company address form can drop straight into its fields. On a
// no-results / upstream error it returns 200 with an empty list plus a `detail`
// string so the form can show exactly what getAddress.io said.

export async function addressLookupRoute(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const apiKey = process.env.GETADDRESS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Address lookup is not configured (GETADDRESS_API_KEY missing)' });

  const qs = (req.url || '').split('?')[1] || '';
  const raw = (new URLSearchParams(qs).get('postcode') || '').trim();
  if (!raw) return res.status(400).json({ error: 'postcode is required' });
  // getAddress.io's /find path wants the postcode with no spaces, upper-cased.
  const postcode = raw.toUpperCase().replace(/\s+/g, '');

  const url = `https://api.getaddress.io/find/${encodeURIComponent(postcode)}`
    + `?api-key=${encodeURIComponent(apiKey)}&expand=true`;

  let resp;
  try {
    resp = await fetch(url);
  } catch (err) {
    console.error('[address-lookup] fetch failed', err.message);
    return res.status(502).json({ error: 'Address lookup service unavailable' });
  }

  // Read the body once so we can surface getAddress's own message on errors.
  const bodyText = await resp.text().catch(() => '');
  let body = null;
  try { body = bodyText ? JSON.parse(bodyText) : null; } catch { /* non-JSON */ }
  const upstreamMsg = body?.Message || body?.message || (bodyText || '').slice(0, 200);

  if (!resp.ok) {
    console.error('[address-lookup] getAddress', resp.status, upstreamMsg);
    // 404 = postcode parsed but no addresses (or not a real postcode). Treat as
    // an empty result the user can fill manually, but pass the message through.
    if (resp.status === 404) {
      return res.status(200).json({ postcode, addresses: [], detail: upstreamMsg || 'No addresses found' });
    }
    if (resp.status === 400) {
      return res.status(200).json({ postcode, addresses: [], detail: upstreamMsg || 'That doesn’t look like a valid postcode' });
    }
    if (resp.status === 429) return res.status(429).json({ error: 'Address lookup limit reached — try again shortly' });
    if (resp.status === 401) return res.status(503).json({ error: `Address lookup rejected the API key: ${upstreamMsg || 'unauthorised'}` });
    return res.status(502).json({ error: `Address lookup failed (${resp.status})${upstreamMsg ? ': ' + upstreamMsg : ''}` });
  }

  const data = body || {};
  const outPostcode = (data.postcode || raw).toUpperCase();
  const addresses = (data.addresses || []).map((a) => {
    const line1 = a.line_1 || '';
    const line2 = [a.line_2, a.line_3, a.line_4].filter(Boolean).join(', ');
    const city = a.town_or_city || '';
    return {
      line1,
      line2,
      city,
      county: a.county || '',
      postcode: outPostcode,
      country: 'United Kingdom',
      label: [a.line_1, a.line_2, a.line_3, a.line_4, a.town_or_city].filter(Boolean).join(', '),
    };
  });

  return res.status(200).json({ postcode: outPostcode, addresses });
}
