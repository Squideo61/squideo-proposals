// Shared qualify/disqualify logic for quote requests. Used by the authenticated
// admin route (api/quote-requests-admin.js) and the one-click email-link route
// (api/quote-requests.js?action=action-link). Both entry points end up running
// the same SQL — only the auth wrapper and response shape differ.

import { del } from '@vercel/blob';
import sql from './db.js';
import { makeId, trimOrNull, lowerOrNull } from './crm/shared.js';

// Domains we never treat as company identifiers. Matching a CRM company by
// "gmail.com" would lump every Gmail-using requester into one org.
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'protonmail.com', 'proton.me', 'tutanota.com',
  'yandex.com', 'yandex.ru', 'mail.com', 'gmx.com', 'gmx.co.uk',
  'fastmail.com', 'zoho.com', 'mail.ru', 'qq.com', '163.com',
]);

function workEmailDomain(email) {
  const e = (email || '').toLowerCase().trim();
  if (!e.includes('@')) return null;
  const d = e.split('@')[1];
  if (!d) return null;
  if (FREE_EMAIL_DOMAINS.has(d)) return null;
  return d;
}

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

export async function loadQuoteRequestForAction(id) {
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

// Qualifies a quote request: ensures a contact exists, resolves/creates the
// company, creates the deal, and flips status to 'qualified'. Idempotent at
// the status check — repeat clicks return { status: 'already_qualified' }.
export async function qualifyQuoteRequest(id, { actorEmail } = {}) {
  const loaded = await loadQuoteRequestForAction(id);
  if (!loaded) return { status: 'not_found' };
  if (loaded.row.status === 'qualified') {
    return { status: 'already_qualified', dealId: loaded.row.deal_id };
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

  // Resolve the company to link the deal + contact to. We try, in order:
  //   1. Case-insensitive match on the form's company name.
  //   2. Match by the requester's work-email domain (skipping free-email
  //      domains like gmail.com so we don't lump strangers together).
  //   3. Create a new company if we have either a name or a usable domain.
  // The third step also populates the new company's `domain` column so
  // the next requester from the same work domain auto-matches.
  let companyId = null;
  const companyName = trimOrNull(loaded.row.company);
  const emailDomain = workEmailDomain(loaded.row.email);

  if (companyName) {
    const byName = await sql`
      SELECT id FROM companies
      WHERE LOWER(name) = LOWER(${companyName})
      LIMIT 1
    `;
    if (byName[0]) companyId = byName[0].id;
  }

  if (!companyId && emailDomain) {
    const byDomain = await sql`
      SELECT id FROM companies
      WHERE LOWER(domain) = ${emailDomain}
      LIMIT 1
    `;
    if (byDomain[0]) companyId = byDomain[0].id;
  }

  if (!companyId && (companyName || emailDomain)) {
    companyId = makeId('co');
    await sql`
      INSERT INTO companies (id, name, domain)
      VALUES (
        ${companyId},
        ${companyName || emailDomain},
        ${emailDomain}
      )
    `;
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
      ${actorEmail || null},
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
      ${actorEmail || null}
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

  return { status: 'ok', contactId, dealId, companyId };
}

// Disqualifies a quote request: removes the row, files, blobs, and any
// provisional contact we created. Returns 'already_qualified' if the request
// has already been promoted to a deal — that'd lose work, so we refuse.
export async function disqualifyQuoteRequest(id) {
  const loaded = await loadQuoteRequestForAction(id);
  if (!loaded) return { status: 'not_found' };
  if (loaded.row.status === 'qualified') {
    return { status: 'already_qualified', dealId: loaded.row.deal_id };
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
  return { status: 'ok' };
}
