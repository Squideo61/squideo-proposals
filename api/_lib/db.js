import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
export default sql;

// Execute many write queries in as few round-trips as possible. The Neon HTTP
// driver runs one query per HTTP request, so `for (...) await sql`INSERT...`` in
// a loop serialises a network round-trip per row — a few thousand rows blows the
// serverless time budget (this is what was timing out the Ads/GSC/GA4 syncs).
// sql.transaction() ships a whole batch in a single request; chunk to keep each
// request a sane size. Pass UN-awaited sql`...` query objects.
export async function batchWrite(queries, chunk = 500) {
  const qs = (queries || []).filter(Boolean);
  for (let i = 0; i < qs.length; i += chunk) {
    const slice = qs.slice(i, i + chunk);
    if (slice.length) await sql.transaction(slice);
  }
}
