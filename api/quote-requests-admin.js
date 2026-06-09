import sql from './_lib/db.js';
import { cors, requireAuth } from './_lib/middleware.js';
import { makeId, trimOrNull, lowerOrNull } from './_lib/crm/shared.js';
import { serialiseContact } from './_lib/crm/contacts.js';
import { serialiseCompany } from './_lib/crm/companies.js';
import { serialiseDeal } from './_lib/crm/deals.js';
import { getRole } from './_lib/userRoles.js';
import { hasPermission } from './_lib/permissions.js';
import { qualifyQuoteRequest, disqualifyQuoteRequest } from './_lib/quoteRequestActions.js';

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
           status, contact_id, deal_id, reviewed_at, created_at
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
  if (!hasPermission(await getRole(user.role), 'quote_requests.manage')) {
    return res.status(403).json({ error: 'You do not have permission to view quote requests' });
  }

  try {
    // ── List ────────────────────────────────────────────────────────────────
    if (!id) {
      if (req.method !== 'GET') return res.status(405).end();
      const status = queryParams.get('status') || 'new';
      const requests = status === 'all'
        ? await sql`
            SELECT id, form_session_id, name, email, phone, country_code, country_name,
                   company, project_details, timeline, budget, opt_in, source_url,
                   status, contact_id, deal_id, reviewed_at, created_at
            FROM quote_requests
            ORDER BY created_at DESC
            LIMIT 500
          `
        : await sql`
            SELECT id, form_session_id, name, email, phone, country_code, country_name,
                   company, project_details, timeline, budget, opt_in, source_url,
                   status, contact_id, deal_id, reviewed_at, created_at
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
