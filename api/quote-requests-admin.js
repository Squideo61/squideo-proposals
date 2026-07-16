import sql, { batchWrite } from './_lib/db.js';
import { cors, requireAuth } from './_lib/middleware.js';
import { makeId, trimOrNull, lowerOrNull } from './_lib/crm/shared.js';
import { serialiseContact } from './_lib/crm/contacts.js';
import { serialiseCompany } from './_lib/crm/companies.js';
import { serialiseDeal } from './_lib/crm/deals.js';
import { getRole } from './_lib/userRoles.js';
import { hasPermission } from './_lib/permissions.js';
import { qualifyQuoteRequest, disqualifyQuoteRequest, markQuoteRequestSpam, clearQuoteRequest, clearNewQuoteRequests } from './_lib/quoteRequestActions.js';
import { ensurePortalTables } from './_lib/portal/db.js';
import { ensureLeadAttribution } from './_lib/leadAttribution.js';

// Channels a lead can be logged under by hand. Off-web enquiries (email, phone,
// referral) never pass through /track.js, so they carry no PPC attribution —
// these keep them visible in the Marketing funnel, grouped by their own channel
// so they never muddy paid-ad ROAS.
const MANUAL_CHANNELS = ['email', 'phone', 'referral', 'other'];

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const buf = Buffer.concat(chunks);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { return {}; }
}

// Parse a YYYY-MM-DD "enquiry date" to a noon-UTC timestamp (noon keeps it on the
// intended calendar day in every UK-ish timezone). Falls back to now.
function enquiryDateToTs(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(v + 'T12:00:00Z');
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function serialiseQuoteRequest(r, files = []) {
  return {
    id: r.id,
    formSessionId: r.form_session_id || null,
    name: r.name || null,
    email: r.email || null,
    phone: r.phone || null,
    countryCode: r.country_code || null,
    countryName: r.country_name || null,
    company: r.company || null,
    projectDetails: r.project_details || null,
    timeline: r.timeline || null,
    budget: r.budget || null,
    optIn: r.opt_in === true,
    sourceUrl: r.source_url || null,
    status: r.status || 'new',
    source: r.source || 'web',
    portalDiscount: r.portal_discount === true,
    contactId: r.contact_id || null,
    dealId: r.deal_id || null,
    reviewedAt: r.reviewed_at || null,
    createdAt: r.created_at,
    files: files.map((f) => ({
      id: f.id,
      filename: f.filename,
      mimeType: f.mime_type || null,
      sizeBytes: f.size_bytes,
      blobUrl: f.blob_url,
    })),
  };
}

async function loadRequest(id) {
  const rows = await sql`
    SELECT id, form_session_id, name, email, phone, country_code, country_name,
           company, project_details, timeline, budget, opt_in, source_url,
           status, contact_id, deal_id, reviewed_at, created_at, source, portal_discount
    FROM quote_requests WHERE id = ${id}
  `;
  if (!rows[0]) return null;
  const files = await sql`
    SELECT id, filename, mime_type, size_bytes, blob_url, blob_pathname
    FROM quote_request_files
    WHERE quote_request_id = ${id}
    ORDER BY created_at ASC
  `;
  return { row: rows[0], files };
}

async function loadContact(id) {
  const rows = await sql`
    SELECT id, email, name, phone, title, company_id, notes, provisional, source, created_at, updated_at
    FROM contacts WHERE id = ${id}
  `;
  return rows[0] || null;
}

async function loadDeal(id) {
  const rows = await sql`
    SELECT id, title, company_id, primary_contact_id, owner_email, stage, stage_changed_at,
           value, expected_close_at, lost_reason, notes, last_activity_at, created_at, updated_at
    FROM deals WHERE id = ${id}
  `;
  return rows[0] || null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const urlPath = (req.url || '').split('?')[0];
  const qs = (req.url || '').split('?')[1] || '';
  const queryParams = new URLSearchParams(qs);
  const segs = urlPath.split('/').filter(Boolean).slice(1); // strip 'api'
  // segs[0] === 'quote-requests-admin'; subsequent segments come via rewrites.
  const id = segs[1] || queryParams.get('_id') || null;
  const action = segs[2] || queryParams.get('_action') || null;

  const user = await requireAuth(req, res);
  if (!user) return;
  const role = await getRole(user.role);
  if (!hasPermission(role, 'quote_requests.manage')) {
    return res.status(403).json({ error: 'You do not have permission to view quote requests' });
  }
  // Clearing (single + bulk) is admin-only — the wildcard '*' role.
  const isAdmin = Array.isArray(role?.permissions) && role.permissions.includes('*');

  // Self-heal the portal columns (source / portal_discount) read below.
  await ensurePortalTables().catch((e) => console.warn('[quote-requests-admin] portal ensure failed', e?.message));

  try {
    // ── Bulk clear (POST, no id) — empties the "new" inbox non-destructively ──
    if (!id && req.method === 'POST' && action === 'clear-new') {
      if (!isAdmin) return res.status(403).json({ error: 'Only admins can clear quote requests' });
      const result = await clearNewQuoteRequests();
      return res.status(200).json({ ok: true, clearedIds: result.clearedIds });
    }

    // ── Log a lead by hand (POST, no id) — capture an off-web enquiry (email/
    // phone/referral) so it counts in the Marketing funnel. Optionally links to
    // an existing deal, in which case it lands "qualified" and its revenue flows
    // through as a sale when that deal signs. ────────────────────────────────
    if (!id && req.method === 'POST' && action === 'manual') {
      const body = await readJsonBody(req);
      const name = trimOrNull(body.name);
      const email = lowerOrNull(body.email);
      const company = trimOrNull(body.company);
      if (!name && !email && !company) {
        return res.status(400).json({ error: 'Give the lead a name, email or company' });
      }
      const channel = MANUAL_CHANNELS.includes(body.channel) ? body.channel : 'other';
      const dealId = trimOrNull(body.dealId);
      let deal = null;
      if (dealId) {
        deal = await loadDeal(dealId);
        if (!deal) return res.status(400).json({ error: 'Linked deal not found' });
      }
      const createdAt = enquiryDateToTs(body.enquiryDate);
      await ensureLeadAttribution().catch((e) => console.warn('[quote-requests-admin] attr ensure failed', e?.message));

      const newId = makeId('qr');
      await sql`
        INSERT INTO quote_requests (
          id, name, email, phone, company, project_details,
          source, status, contact_id, deal_id, company_id, reviewed_at, created_at,
          attr_channel, attr_source, attr_medium
        ) VALUES (
          ${newId}, ${name}, ${email}, ${trimOrNull(body.phone)}, ${company},
          ${trimOrNull(body.projectDetails)},
          'manual', ${dealId ? 'qualified' : 'new'},
          ${deal?.primary_contact_id || null}, ${dealId || null}, ${deal?.company_id || null},
          ${dealId ? createdAt : null}, ${createdAt},
          ${channel}, 'manual', ${channel}
        )
      `;
      const refreshed = await loadRequest(newId);
      return res.status(201).json(serialiseQuoteRequest(refreshed.row, refreshed.files));
    }

    // ── Email-enquiry backfill (GET preview / POST apply, no id) — surfaces
    // deals that arrived via the enquiries inbox (≥1 inbound email) but were
    // never logged as a Marketing lead, and lets you create 'email' leads for
    // them in bulk so historic sales stop being under-counted. ────────────────
    if (!id && action === 'email-backfill') {
      if (req.method === 'GET') {
        const rows = await sql`
          SELECT d.id, d.title, d.stage, d.value, d.created_at,
                 c.name AS company_name,
                 ct.name AS contact_name, ct.email AS contact_email,
                 MIN(m.sent_at) AS first_inbound,
                 (array_agg(m.from_email ORDER BY m.sent_at))[1] AS first_from,
                 COUNT(m.gmail_message_id) AS inbound_count
            FROM deals d
            JOIN email_thread_deals etd ON etd.deal_id = d.id
            JOIN email_messages m ON m.gmail_thread_id = etd.gmail_thread_id AND m.direction = 'inbound'
            LEFT JOIN companies c ON c.id = d.company_id
            LEFT JOIN contacts ct ON ct.id = d.primary_contact_id
           WHERE NOT EXISTS (SELECT 1 FROM quote_requests qr WHERE qr.deal_id = d.id)
           GROUP BY d.id, d.title, d.stage, d.value, d.created_at, c.name, ct.name, ct.email
           ORDER BY MIN(m.sent_at) DESC NULLS LAST
           LIMIT 300`;
        return res.status(200).json({
          candidates: rows.map((r) => ({
            dealId: r.id,
            title: r.title || null,
            stage: r.stage || null,
            value: r.value != null ? Number(r.value) : null,
            company: r.company_name || null,
            name: r.contact_name || null,
            email: r.contact_email || r.first_from || null,
            firstInboundAt: r.first_inbound || r.created_at,
            inboundCount: Number(r.inbound_count) || 0,
          })),
        });
      }

      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const dealIds = Array.isArray(body.dealIds) ? body.dealIds.filter((x) => typeof x === 'string') : [];
        if (!dealIds.length) return res.status(400).json({ error: 'No deals selected' });
        await ensureLeadAttribution().catch((e) => console.warn('[quote-requests-admin] attr ensure failed', e?.message));

        // Re-derive everything server-side (don't trust client dates/emails) and
        // skip any deal that already has a lead — keeps apply idempotent.
        const rows = await sql`
          SELECT d.id, d.company_id, d.primary_contact_id, d.created_at,
                 c.name AS company_name,
                 ct.name AS contact_name, ct.email AS contact_email,
                 MIN(m.sent_at) AS first_inbound,
                 (array_agg(m.from_email ORDER BY m.sent_at))[1] AS first_from
            FROM deals d
            JOIN email_thread_deals etd ON etd.deal_id = d.id
            JOIN email_messages m ON m.gmail_thread_id = etd.gmail_thread_id AND m.direction = 'inbound'
            LEFT JOIN companies c ON c.id = d.company_id
            LEFT JOIN contacts ct ON ct.id = d.primary_contact_id
           WHERE d.id = ANY(${dealIds})
             AND NOT EXISTS (SELECT 1 FROM quote_requests qr WHERE qr.deal_id = d.id)
           GROUP BY d.id, d.company_id, d.primary_contact_id, d.created_at, c.name, ct.name, ct.email`;

        const inserts = rows.map((r) => {
          const createdAt = r.first_inbound || r.created_at || new Date();
          return sql`
            INSERT INTO quote_requests (
              id, name, email, company, source, status,
              contact_id, deal_id, company_id, reviewed_at, created_at,
              attr_channel, attr_source, attr_medium
            ) VALUES (
              ${makeId('qr')}, ${trimOrNull(r.contact_name)},
              ${lowerOrNull(r.contact_email || r.first_from)}, ${trimOrNull(r.company_name)},
              'manual', 'qualified',
              ${r.primary_contact_id || null}, ${r.id}, ${r.company_id || null},
              ${createdAt}, ${createdAt},
              'email', 'manual', 'email'
            )`;
        });
        await batchWrite(inserts);
        return res.status(200).json({ ok: true, created: inserts.length });
      }

      return res.status(405).end();
    }

    // ── List ────────────────────────────────────────────────────────────────
    if (!id) {
      if (req.method !== 'GET') return res.status(405).end();
      const status = queryParams.get('status') || 'new';
      const requests = status === 'all'
        ? await sql`
            SELECT id, form_session_id, name, email, phone, country_code, country_name,
                   company, project_details, timeline, budget, opt_in, source_url,
                   status, contact_id, deal_id, reviewed_at, created_at, source, portal_discount
            FROM quote_requests
            ORDER BY created_at DESC
            LIMIT 500
          `
        : await sql`
            SELECT id, form_session_id, name, email, phone, country_code, country_name,
                   company, project_details, timeline, budget, opt_in, source_url,
                   status, contact_id, deal_id, reviewed_at, created_at, source, portal_discount
            FROM quote_requests
            WHERE status = ${status}
            ORDER BY created_at DESC
            LIMIT 500
          `;
      const ids = requests.map((r) => r.id);
      const fileRows = ids.length
        ? await sql`
            SELECT id, quote_request_id, filename, mime_type, size_bytes, blob_url, blob_pathname
            FROM quote_request_files
            WHERE quote_request_id = ANY(${ids})
            ORDER BY created_at ASC
          `
        : [];
      const filesByReq = new Map();
      for (const f of fileRows) {
        if (!filesByReq.has(f.quote_request_id)) filesByReq.set(f.quote_request_id, []);
        filesByReq.get(f.quote_request_id).push(f);
      }
      return res
        .status(200)
        .json(requests.map((r) => serialiseQuoteRequest(r, filesByReq.get(r.id) || [])));
    }

    const loaded = await loadRequest(id);
    if (!loaded) return res.status(404).json({ error: 'Not found' });

    // ── Disqualify (DELETE) ────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const result = await disqualifyQuoteRequest(id);
      if (result.status === 'not_found') return res.status(404).json({ error: 'Not found' });
      if (result.status === 'already_qualified') {
        return res.status(409).json({ error: 'Already qualified — open the deal instead' });
      }
      return res.status(200).json({ ok: true });
    }

    // ── Spam (POST /:id/spam) — mark as junk, purge like disqualify ────────
    if (req.method === 'POST' && action === 'spam') {
      const result = await markQuoteRequestSpam(id);
      if (result.status === 'not_found') return res.status(404).json({ error: 'Not found' });
      if (result.status === 'already_qualified') {
        return res.status(409).json({ error: 'Already qualified — open the deal instead' });
      }
      return res.status(200).json({ ok: true });
    }

    // ── Clear (POST /:id/clear) — neutral "remove from inbox", admin-only ──
    if (req.method === 'POST' && action === 'clear') {
      if (!isAdmin) return res.status(403).json({ error: 'Only admins can clear quote requests' });
      const result = await clearQuoteRequest(id);
      if (result.status === 'not_found') return res.status(404).json({ error: 'Not found' });
      if (result.status === 'already_qualified') {
        return res.status(409).json({ error: 'Already qualified — open the deal instead' });
      }
      return res.status(200).json({ ok: true });
    }

    // ── Review (POST /:id/review) — lazy-create provisional contact ────────
    if (req.method === 'POST' && action === 'review') {
      let contactRow = loaded.row.contact_id ? await loadContact(loaded.row.contact_id) : null;
      let isExisting = contactRow ? !contactRow.provisional : false;

      if (!contactRow) {
        // Check for an existing non-provisional contact with the same email before
        // creating a provisional one — prevents duplicates when the requester is
        // already in the CRM.
        const email = lowerOrNull(loaded.row.email);
        let existingRow = null;
        if (email) {
          const existing = await sql`
            SELECT id, email, name, phone, title, company_id, notes, provisional, source, created_at, updated_at
            FROM contacts
            WHERE LOWER(email) = LOWER(${email})
              AND provisional = FALSE
            LIMIT 1
          `;
          existingRow = existing[0] || null;
        }

        if (existingRow) {
          // Link to the existing contact — no new provisional record needed.
          await sql`
            UPDATE quote_requests
               SET contact_id = ${existingRow.id},
                   reviewed_at = COALESCE(reviewed_at, NOW())
             WHERE id = ${id}
          `;
          contactRow = existingRow;
          isExisting = true;
        } else {
          const newContactId = makeId('ct');
          await sql`
            INSERT INTO contacts (id, email, name, phone, title, company_id, notes, provisional, source)
            VALUES (
              ${newContactId},
              ${email},
              ${trimOrNull(loaded.row.name)},
              ${trimOrNull(loaded.row.phone ? `${loaded.row.country_code || ''} ${loaded.row.phone}`.trim() : null)},
              ${null},
              ${null},
              ${trimOrNull(loaded.row.company ? `Company: ${loaded.row.company}` : null)},
              TRUE,
              'quote_request'
            )
          `;
          await sql`
            UPDATE quote_requests
               SET contact_id = ${newContactId},
                   reviewed_at = COALESCE(reviewed_at, NOW())
             WHERE id = ${id}
          `;
          contactRow = await loadContact(newContactId);
          isExisting = false;
        }
      } else if (!loaded.row.reviewed_at) {
        await sql`UPDATE quote_requests SET reviewed_at = NOW() WHERE id = ${id}`;
      }

      const refreshed = await loadRequest(id);
      return res.status(200).json({
        request: serialiseQuoteRequest(refreshed.row, refreshed.files),
        contact: contactRow ? serialiseContact(contactRow) : null,
        isExisting,
      });
    }

    // ── Qualify (POST /:id/qualify) ────────────────────────────────────────
    if (req.method === 'POST' && action === 'qualify') {
      const result = await qualifyQuoteRequest(id, { actorEmail: user.email });
      if (result.status === 'not_found') return res.status(404).json({ error: 'Not found' });
      if (result.status === 'already_qualified') {
        return res.status(409).json({ error: 'Already qualified' });
      }

      const { contactId, dealId, companyId } = result;
      const [refreshed, contactRow, dealRow, companyRows] = await Promise.all([
        loadRequest(id),
        loadContact(contactId),
        loadDeal(dealId),
        companyId
          ? sql`SELECT id, name, domain, notes, created_at, updated_at FROM companies WHERE id = ${companyId}`
          : Promise.resolve([]),
      ]);

      return res.status(200).json({
        request: serialiseQuoteRequest(refreshed.row, refreshed.files),
        contact: contactRow ? serialiseContact(contactRow) : null,
        deal: dealRow ? serialiseDeal(dealRow) : null,
        company: companyRows[0] ? serialiseCompany(companyRows[0]) : null,
      });
    }

    return res.status(405).end();
  } catch (err) {
    console.error('[quote-requests-admin] error', err);
    return res.status(500).json({ error: 'Request failed' });
  }
}
