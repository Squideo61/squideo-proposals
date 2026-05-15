// Find-or-create resolver for the proposal builder's "Link or create
// contact + company" panel. Single round-trip from the SPA: takes a typed
// client name + business name (and optionally the proposal id whose
// auto-deal should be linked), returns the resolved ids plus flags
// describing what just happened.
//
// Matching mirrors api/quote-requests-admin.js:283-340 — case-insensitive
// exact-name match on non-provisional contacts and on companies. We don't
// take an email here because the proposal builder doesn't collect one;
// when the user later signs, the signature carries their email but that's
// after the fact.

import sql from '../db.js';
import { makeId, trimOrNull } from './shared.js';
import { serialiseContact } from './contacts.js';
import { serialiseCompany } from './companies.js';

async function findContactByExactName(name) {
  if (!name) return null;
  const rows = await sql`
    SELECT id, email, name, phone, title, company_id, notes, provisional, source, created_at, updated_at
      FROM contacts
     WHERE LOWER(TRIM(name)) = LOWER(${name})
       AND provisional = FALSE
     ORDER BY created_at ASC
     LIMIT 1
  `;
  return rows[0] || null;
}

async function findCompanyByExactName(name) {
  if (!name) return null;
  const rows = await sql`
    SELECT id, name, domain, notes, created_at, updated_at
      FROM companies
     WHERE LOWER(TRIM(name)) = LOWER(${name})
     ORDER BY created_at ASC
     LIMIT 1
  `;
  return rows[0] || null;
}

// Public route handler — wired from api/crm/[...slug].js as resource
// 'resolve-client'. POST only.
export async function resolveClientRoute(req, res, _id, _action, user) {
  if (req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};
  const clientName = trimOrNull(body.clientName);
  const businessName = trimOrNull(body.businessName);
  const proposalId = trimOrNull(body.proposalId);
  if (!clientName && !businessName) {
    return res.status(400).json({ error: 'clientName or businessName is required' });
  }

  let contactRow = await findContactByExactName(clientName);
  let companyRow = await findCompanyByExactName(businessName);
  const matched = { contact: !!contactRow, company: !!companyRow };

  // If the matched contact already has a company, surface a conflict when
  // it doesn't agree with the typed business name. The SPA renders the
  // orange "linked to X, not Y" banner and lets the user choose.
  let conflict = null;
  if (contactRow && contactRow.company_id && businessName) {
    const linkedRows = await sql`
      SELECT id, name, domain, notes, created_at, updated_at
        FROM companies WHERE id = ${contactRow.company_id} LIMIT 1
    `;
    const linkedCompany = linkedRows[0] || null;
    const sameAsTyped = linkedCompany
      && linkedCompany.name
      && linkedCompany.name.trim().toLowerCase() === businessName.trim().toLowerCase();
    if (linkedCompany && !sameAsTyped) {
      conflict = {
        kind: 'contact_linked_to_different_company',
        contactId: contactRow.id,
        linkedCompany: serialiseCompany(linkedCompany),
        typedBusinessName: businessName,
      };
    } else if (sameAsTyped) {
      // Treat the linked company as the match even if the standalone
      // findCompanyByExactName already returned the same row.
      companyRow = linkedCompany;
      matched.company = true;
    }
  }

  // Create whichever record is missing.
  let createdContact = false;
  let createdCompany = false;

  if (!companyRow && businessName) {
    const newCompanyId = makeId('co');
    await sql`
      INSERT INTO companies (id, name)
      VALUES (${newCompanyId}, ${businessName})
    `;
    const inserted = await sql`
      SELECT id, name, domain, notes, created_at, updated_at
        FROM companies WHERE id = ${newCompanyId}
    `;
    companyRow = inserted[0];
    createdCompany = true;
  }

  if (!contactRow && clientName) {
    const newContactId = makeId('ct');
    await sql`
      INSERT INTO contacts (id, email, name, phone, title, company_id, notes, provisional, source)
      VALUES (${newContactId}, NULL, ${clientName}, NULL, NULL, ${companyRow?.id || null}, NULL, FALSE, 'proposal_builder')
    `;
    const inserted = await sql`
      SELECT id, email, name, phone, title, company_id, notes, provisional, source, created_at, updated_at
        FROM contacts WHERE id = ${newContactId}
    `;
    contactRow = inserted[0];
    createdContact = true;
  } else if (contactRow && companyRow && !contactRow.company_id) {
    // Existing contact, no company yet — attach the resolved company.
    await sql`
      UPDATE contacts
         SET company_id = ${companyRow.id}, updated_at = NOW()
       WHERE id = ${contactRow.id}
    `;
    contactRow.company_id = companyRow.id;
  }

  // Sync the proposal's auto-deal if we have one. We only touch the
  // deterministic `deal_<proposalId>` so a manually-relinked deal stays
  // untouched. COALESCE preserves a hand-set value on the deal.
  let updatedDeal = null;
  if (proposalId) {
    const autoDealId = 'deal_' + proposalId;
    const dealRows = await sql`SELECT id, primary_contact_id, company_id FROM deals WHERE id = ${autoDealId} LIMIT 1`;
    if (dealRows[0]) {
      await sql`
        UPDATE deals
           SET primary_contact_id = COALESCE(primary_contact_id, ${contactRow?.id || null}),
               company_id         = COALESCE(company_id,         ${companyRow?.id || null}),
               updated_at         = NOW()
         WHERE id = ${autoDealId}
      `;
      updatedDeal = autoDealId;
      // Also stamp the proposal's data.json with _contactId / _companyId so
      // future GET /api/proposals/:id rehydrates the link on every device.
      // We patch the JSONB in place; missing keys are inserted by jsonb_set.
      await sql`
        UPDATE proposals
           SET data = jsonb_set(
                       jsonb_set(data, '{_contactId}', to_jsonb(${contactRow?.id || null}::text), true),
                       '{_companyId}', to_jsonb(${companyRow?.id || null}::text), true)
         WHERE id = ${proposalId}
      `;
    }
  }

  return res.status(200).json({
    contact: contactRow ? serialiseContact(contactRow) : null,
    company: companyRow ? serialiseCompany(companyRow) : null,
    matched,
    created: { contact: createdContact, company: createdCompany },
    conflict,
    dealUpdated: updatedDeal,
  });
}
