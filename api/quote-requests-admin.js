import { del } from '@vercel/blob';
import sql from './_lib/db.js';
import { cors, requireAuth } from './_lib/middleware.js';
import { makeId, trimOrNull, lowerOrNull } from './_lib/crm/shared.js';
import { serialiseContact } from './_lib/crm/contacts.js';
import { serialiseCompany } from './_lib/crm/companies.js';
import { serialiseDeal } from './_lib/crm/deals.js';
import { getRole } from './_lib/userRoles.js';
import { hasPermission } from './_lib/permissions.js';

// Parse a free-text budget band like "£5k–£10k", "5000-10000", "Under £2k"
// into a numeric lower bound. Returns null when nothing parseable is found.
function parseBudgetLower(budget) {
  if (!budget) return null;
  const matches = String(budget).match(/(\d[\d,.]*)\s*(k|K)?/g);
  if (!matches || !matches.length) return null;
  const nums = matches
    .map((m) => {
      const inner = m.match(/(\d[\d,.]*)\s*(k|K)?/);
      if (!inner) return null;
      const n = Number(inner[1].replace(/,/g, ''));
      if (!Number.isFinite(n)) return null;
      return inner[2] ? n * 1000 : n;
    })
    .filter((n) => n != null && n > 0);
  if (!nums.length) return null;
  return Math.min(...nums);
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
      if (loaded.row.status === 'qualified') {
        return res.status(409).json({ error: 'Already qualified — open the deal instead' });
      }
      // Delete the provisional contact if we created one. Stay defensive: only
      // delete contacts we tagged provisional + source='quote_request'.
      if (loaded.row.contact_id) {
        await sql`
          DELETE FROM contacts
          WHERE id = ${loaded.row.contact_id}
            AND provisional = TRUE
            AND source = 'quote_request'
        `;
      }
      // Delete blobs (best-effort; ignore failures so DB row still goes).
      for (const f of loaded.files) {
        if (f.blob_url) {
          try { await del(f.blob_url); } catch (e) { console.warn('[quote-requests] blob delete failed', e?.message); }
        }
      }
      await sql`DELETE FROM quote_request_files WHERE quote_request_id = ${id}`;
      await sql`DELETE FROM quote_requests WHERE id = ${id}`;
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
      if (loaded.row.status === 'qualified') {
        return res.status(409).json({ error: 'Already qualified' });
      }

      // Ensure contact exists (qualify can run without an explicit /review first).
      let contactId = loaded.row.contact_id;
      if (!contactId) {
        contactId = makeId('ct');
        await sql`
          INSERT INTO contacts (id, email, name, phone, title, company_id, notes, provisional, source)
          VALUES (
            ${contactId},
            ${lowerOrNull(loaded.row.email)},
            ${trimOrNull(loaded.row.name)},
            ${trimOrNull(loaded.row.phone ? `${loaded.row.country_code || ''} ${loaded.row.phone}`.trim() : null)},
            ${null},
            ${null},
            ${trimOrNull(loaded.row.company ? `Company: ${loaded.row.company}` : null)},
            TRUE,
            'quote_request'
          )
        `;
      }

      // Find or create the company so the deal + contact can be linked to it.
      // Match case-insensitively on the trimmed name; never silently merge a
      // blank company into something existing.
      let companyId = null;
      const companyName = trimOrNull(loaded.row.company);
      if (companyName) {
        const existing = await sql`
          SELECT id FROM companies
          WHERE LOWER(name) = LOWER(${companyName})
          LIMIT 1
        `;
        if (existing[0]) {
          companyId = existing[0].id;
        } else {
          companyId = makeId('co');
          await sql`
            INSERT INTO companies (id, name)
            VALUES (${companyId}, ${companyName})
          `;
        }
      }

      // Flip provisional → permanent and attach to the company.
      await sql`
        UPDATE contacts
           SET provisional = FALSE,
               source = COALESCE(source, 'quote_request'),
               company_id = COALESCE(company_id, ${companyId}),
               updated_at = NOW()
         WHERE id = ${contactId}
      `;

      // Build deal.
      const dealId = makeId('deal');
      const dealTitle =
        trimOrNull(loaded.row.company)
        || trimOrNull(loaded.row.name)
        || loaded.row.email
        || 'Quote request';
      const dealValue = parseBudgetLower(loaded.row.budget);
      const notesParts = [];
      if (loaded.row.project_details) notesParts.push(loaded.row.project_details);
      if (loaded.row.timeline) notesParts.push(`Timeline: ${loaded.row.timeline}`);
      if (loaded.row.budget) notesParts.push(`Budget: ${loaded.row.budget}`);
      if (loaded.row.company) notesParts.push(`Company: ${loaded.row.company}`);
      const dealNotes = notesParts.join('\n\n') || null;

      await sql`
        INSERT INTO deals (id, title, company_id, primary_contact_id, owner_email, stage, value, notes)
        VALUES (
          ${dealId},
          ${dealTitle},
          ${companyId},
          ${contactId},
          ${user.email},
          'lead',
          ${dealValue},
          ${dealNotes}
        )
      `;
      await sql`
        INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
        VALUES (
          ${dealId},
          'deal_created',
          ${JSON.stringify({ title: dealTitle, stage: 'lead', source: 'quote_request', quoteRequestId: id })},
          ${user.email || null}
        )
      `;

      await sql`
        UPDATE quote_requests
           SET status = 'qualified',
               contact_id = ${contactId},
               deal_id = ${dealId},
               reviewed_at = COALESCE(reviewed_at, NOW())
         WHERE id = ${id}
      `;

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
    return res.status(500).json({ error: err.message || 'Request failed' });
  }
}
