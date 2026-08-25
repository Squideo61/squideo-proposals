// GET /api/reviews — public, unauthenticated. Feeds the /reviews embed that
// squideo.com iframes into its homepage.
//
// Serves only reviews a human has approved in Admin → Reviews. Everything else
// Google returns stays in the database unseen.
//
// This must never be the reason the homepage banner breaks: the embed ships
// with a bundled copy of the reviews and renders that whenever this returns
// nothing, so a database blip degrades to slightly stale rather than empty.
import { cors } from './_lib/middleware.js';
import { publicReviews } from './_lib/crm/googleBusinessReviews.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const max = req.query?.max;
    const data = await publicReviews({ max });
    // Cached at the edge: the banner is on every homepage view but the content
    // changes at most once a night.
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=86400');
    return res.status(200).json(data);
  } catch (err) {
    console.error('[api/reviews]', err?.message);
    // 200 with an empty list, not a 5xx: the client treats empty as "use the
    // bundled copy", and a 500 here would show up as a console error on a
    // marketing page for no benefit.
    return res.status(200).json({ reviews: [], summary: null, profileUrl: null, unavailable: true });
  }
}
