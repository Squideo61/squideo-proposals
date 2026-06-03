// Postcode → address lookup, proxied to getAddress.io so the API key stays
// server-side. GET /api/crm/address-lookup?postcode=EC3R+8HL
//
// Requires the GETADDRESS_API_KEY env var (set in Vercel). Returns a normalised
// { postcode, addresses: [{ line1, line2, city, county, postcode, country, label }] }
// shape the company address form can drop straight into its fields.

export async function addressLookupRoute(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const apiKey = process.env.GETADDRESS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Address lookup is not configured' });

  const qs = (req.url || '').split('?')[1] || '';
  const postcode = (new URLSearchParams(qs).get('postcode') || '').trim();
  if (!postcode) return res.status(400).json({ error: 'postcode is required' });

  const url = `https://api.getaddress.io/find/${encodeURIComponent(postcode)}`
    + `?api-key=${encodeURIComponent(apiKey)}&expand=true`;

  let resp;
  try {
    resp = await fetch(url);
  } catch (err) {
    console.error('[address-lookup] fetch failed', err.message);
    return res.status(502).json({ error: 'Address lookup service unavailable' });
  }

  // Unknown postcode → empty list rather than an error, so the UI can just say
  // "no addresses found" and let the user type it manually.
  if (resp.status === 404) return res.status(200).json({ postcode, addresses: [] });
  if (resp.status === 429) return res.status(429).json({ error: 'Address lookup limit reached — try again shortly' });
  if (resp.status === 401) {
    console.error('[address-lookup] getAddress rejected the API key');
    return res.status(503).json({ error: 'Address lookup is not configured' });
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error('[address-lookup] getAddress error', resp.status, text);
    return res.status(502).json({ error: 'Address lookup failed' });
  }

  const data = await resp.json();
  const outPostcode = (data.postcode || postcode).toUpperCase();
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
