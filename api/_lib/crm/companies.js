import sql from '../db.js';
import { makeId, trimOrNull, lowerOrNull } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { updateContactAddress, getOrCreateContact } from '../xero.js';
import { reconcileProposalBillingPaid } from './invoices.js';

// Self-heal for db/migrations/20260603_company_address.sql. Called at the top of
// every companies code path so a workspace that skipped the manual Neon apply
// still works — without it, a missing column (e.g. address_line1) makes company
// reads/writes 500. Module-level cache so it only runs once per cold start.
let companyAddressColumnsEnsured = null;
function ensureCompanyAddressColumns() {
  if (companyAddressColumnsEnsured) return companyAddressColumnsEnsured;
  companyAddressColumnsEnsured = (async () => {
    await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS address_line1 TEXT`;
    await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS address_line2 TEXT`;
    await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS city TEXT`;
    await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS postcode TEXT`;
    await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS country TEXT`;
  })().catch((err) => {
    // Reset so a transient failure (e.g. cold DB) retries on the next request
    // instead of being cached as "done".
    companyAddressColumnsEnsured = null;
    throw err;
  });
  return companyAddressColumnsEnsured;
}

// Self-heal for db/migrations/20260603_proposal_billing_paid.sql. The company
// balance reads proposal_billing.paid_amount, so the columns must exist before
// computeCompanyBalance / allCompanyBalances run.
let proposalBillingPaidColumnsEnsured = null;
function ensureProposalBillingPaidColumns() {
  if (proposalBillingPaidColumnsEnsured) return proposalBillingPaidColumnsEnsured;
  proposalBillingPaidColumnsEnsured = (async () => {
    await sql`ALTER TABLE proposal_billing ADD COLUMN IF NOT EXISTS paid_amount NUMERIC`;
    await sql`ALTER TABLE proposal_billing ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`;
  })().catch((err) => { proposalBillingPaidColumnsEnsured = null; throw err; });
  return proposalBillingPaidColumnsEnsured;
}

export async function companiesRoute(req, res, id, action, user) {
  await Promise.all([ensureCompanyAddressColumns(), ensureProposalBillingPaidColumns()]);
  // POST /companies/from-xero-contact — find or create a local company linked
  // to a given Xero contact ID. Used by the contact picker so deals/proposals
  // always resolve to a local company with a stable xero_contact_id link.
  if (id === 'from-xero-contact' && req.method === 'POST') {
    const body = req.body || {};
    const xeroContactId = trimOrNull(body.xeroContactId);
    if (!xeroContactId) return res.status(400).json({ error: 'xeroContactId required' });

    // Already linked? Return existing.
    const existing = await sql`
      SELECT id, name, domain, notes, xero_contact_id,
             address_line1, address_line2, city, postcode, country,
             created_at, updated_at
        FROM companies WHERE xero_contact_id = ${xeroContactId} LIMIT 1
    `;
    if (existing.length) return res.status(200).json(serialiseCompany(existing[0]));

    // Look up the Xero contact in the mirror so we can copy its name.
    const [xc] = await sql`
      SELECT id, name, email, country FROM xero_contacts WHERE id = ${xeroContactId}
    `;
    if (!xc) return res.status(404).json({ error: 'Xero contact not found in mirror — run sync' });

    // Try matching an unlinked local company by name (case-insensitive) first.
    const byName = await sql`
      SELECT id, name, domain, notes, xero_contact_id, created_at, updated_at
        FROM companies
       WHERE xero_contact_id IS NULL
         AND LOWER(name) = LOWER(${xc.name})
       LIMIT 1
    `;
    if (byName.length) {
      await sql`UPDATE companies SET xero_contact_id = ${xeroContactId}, updated_at = NOW() WHERE id = ${byName[0].id}`;
      const refreshed = await sql`
        SELECT id, name, domain, notes, xero_contact_id,
               address_line1, address_line2, city, postcode, country,
               created_at, updated_at
          FROM companies WHERE id = ${byName[0].id}
      `;
      return res.status(200).json(serialiseCompany(refreshed[0]));
    }

    // Otherwise, create a fresh local company linked to the Xero contact.
    const newId = makeId('co');
    const domain = xc.email && xc.email.includes('@') ? xc.email.split('@')[1].toLowerCase() : null;
    await sql`
      INSERT INTO companies (id, name, domain, xero_contact_id)
      VALUES (${newId}, ${xc.name}, ${domain}, ${xeroContactId})
    `;
    const rows = await sql`
      SELECT id, name, domain, notes, xero_contact_id,
             address_line1, address_line2, city, postcode, country,
             created_at, updated_at
        FROM companies WHERE id = ${newId}
    `;
    return res.status(201).json(serialiseCompany(rows[0]));
  }

  // GET /companies/balances — { [companyId]: { committed, paid, outstanding } }
  // for every company with signed work. Kept off the main list endpoint so the
  // frequently-loaded companies list stays fast.
  if (id === 'balances' && req.method === 'GET') {
    return res.status(200).json(await allCompanyBalances());
  }

  if (!id) {
    if (req.method === 'GET') {
      // EXISTS subquery joins signatures → proposals → deals → companies in
      // one shot, so the Customers view can flag every company that has had a
      // signed proposal land against it without a per-row round-trip.
      const rows = await sql`
        SELECT c.id, c.name, c.domain, c.notes, c.xero_contact_id,
               c.customer_verified_at, c.customer_verified_by,
               c.address_line1, c.address_line2, c.city, c.postcode, c.country,
               c.created_at, c.updated_at,
               xc.address_line1 AS xero_address_line1,
               xc.address_line2 AS xero_address_line2,
               xc.city          AS xero_city,
               xc.postcode      AS xero_postcode,
               xc.country       AS xero_country,
               EXISTS(
                 SELECT 1
                   FROM signatures s
                   JOIN proposals p ON p.id = s.proposal_id
                   JOIN deals d ON d.id = p.deal_id
                  WHERE d.company_id = c.id
               ) AS has_signed_proposal
          FROM companies c
          LEFT JOIN xero_contacts xc ON xc.id = c.xero_contact_id
         ORDER BY c.name ASC
      `;
      return res.status(200).json(rows.map(serialiseCompany));
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const name = trimOrNull(body.name);
      if (!name) return res.status(400).json({ error: 'name is required' });
      const newId = body.id || makeId('co');
      const a = body.address || {};
      await sql`
        INSERT INTO companies (id, name, domain, notes, xero_contact_id,
                               address_line1, address_line2, city, postcode, country)
        VALUES (${newId}, ${name}, ${lowerOrNull(body.domain)}, ${trimOrNull(body.notes)}, ${trimOrNull(body.xeroContactId)},
                ${trimOrNull(a.line1)}, ${trimOrNull(a.line2)}, ${trimOrNull(a.city)}, ${trimOrNull(a.postcode)}, ${trimOrNull(a.country)})
      `;
      const rows = await sql`
        SELECT id, name, domain, notes, xero_contact_id,
               address_line1, address_line2, city, postcode, country,
               created_at, updated_at
        FROM companies WHERE id = ${newId}
      `;
      return res.status(201).json(serialiseCompany(rows[0]));
    }
    return res.status(405).end();
  }

  // /companies/:id/detail — company + member contacts + deals at the company
  if (action === 'detail' && req.method === 'GET') {
    const [companyRow] = await sql`
      SELECT c.id, c.name, c.domain, c.notes, c.xero_contact_id,
             c.customer_verified_at, c.customer_verified_by,
             c.address_line1, c.address_line2, c.city, c.postcode, c.country,
             c.created_at, c.updated_at,
             xc.name AS xero_contact_name,
             xc.address_line1 AS xero_address_line1,
             xc.address_line2 AS xero_address_line2,
             xc.city          AS xero_city,
             xc.postcode      AS xero_postcode,
             xc.country       AS xero_country,
             EXISTS(
               SELECT 1
                 FROM signatures s
                 JOIN proposals p ON p.id = s.proposal_id
                 JOIN deals d ON d.id = p.deal_id
                WHERE d.company_id = c.id
             ) AS has_signed_proposal
        FROM companies c
        LEFT JOIN xero_contacts xc ON xc.id = c.xero_contact_id
       WHERE c.id = ${id}
    `;
    if (!companyRow) return res.status(404).json({ error: 'Not found' });

    const [contactRows, dealRows] = await Promise.all([
      sql`
        SELECT id, email, name, phone, title, company_id, notes, created_at, updated_at
        FROM contacts WHERE company_id = ${id}
        ORDER BY name ASC NULLS LAST, email ASC
      `,
      sql`
        SELECT d.id, d.title, d.company_id, d.primary_contact_id, d.owner_email,
               d.stage, d.value, d.expected_close_at, d.stage_changed_at,
               d.last_activity_at, d.created_at, d.updated_at,
               (SELECT COUNT(*)::int FROM proposals p WHERE p.deal_id = d.id) AS proposal_count
          FROM deals d
          WHERE d.company_id = ${id}
          ORDER BY d.stage_changed_at DESC
      `,
    ]);

    const balance = await computeCompanyBalance(id);

    return res.status(200).json({
      ...serialiseCompany(companyRow),
      balance,
      contacts: contactRows.map(c => ({
        id: c.id,
        email: c.email || null,
        name: c.name || null,
        phone: c.phone || null,
        title: c.title || null,
        companyId: c.company_id || null,
        notes: c.notes || null,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      })),
      deals: dealRows.map(d => ({
        id: d.id,
        title: d.title,
        companyId: d.company_id || null,
        primaryContactId: d.primary_contact_id || null,
        ownerEmail: d.owner_email || null,
        stage: d.stage,
        value: d.value != null ? Number(d.value) : null,
        expectedCloseAt: d.expected_close_at || null,
        stageChangedAt: d.stage_changed_at,
        lastActivityAt: d.last_activity_at,
        createdAt: d.created_at,
        updatedAt: d.updated_at,
        proposalCount: d.proposal_count || 0,
      })),
    });
  }

  // POST /companies/:id/create-xero-contact — create a brand-new Xero contact
  // from this company's details and link it. The UI only offers this when no
  // same/similar contact was found to link to; getOrCreateContact still does a
  // live exact-name search as a server-side safety net against duplicates.
  if (action === 'create-xero-contact' && req.method === 'POST') {
    const [co] = await sql`
      SELECT id, name, xero_contact_id,
             address_line1, address_line2, city, postcode, country
        FROM companies WHERE id = ${id}
    `;
    if (!co) return res.status(404).json({ error: 'Not found' });
    if (co.xero_contact_id) return res.status(409).json({ error: 'Company is already linked to a Xero contact' });

    // Best-effort email from one of the company's contacts.
    const [contact] = await sql`
      SELECT email FROM contacts
       WHERE company_id = ${id} AND email IS NOT NULL
       ORDER BY created_at ASC LIMIT 1
    `;
    const hasAddr = co.address_line1 || co.address_line2 || co.city || co.postcode || co.country;
    const address = hasAddr ? {
      line1: co.address_line1, line2: co.address_line2,
      city: co.city, postcode: co.postcode, country: co.country,
    } : null;

    let contactId;
    try {
      contactId = await getOrCreateContact({ name: co.name, email: contact?.email || null, address });
    } catch (err) {
      console.error('[companies] create xero contact failed', err);
      return res.status(502).json({ error: err.message || 'Could not create the Xero contact' });
    }

    await sql`UPDATE companies SET xero_contact_id = ${contactId}, updated_at = NOW() WHERE id = ${id}`;
    // Mirror it so the link shows a name immediately, without a full re-sync.
    await sql`
      INSERT INTO xero_contacts (id, name, email, status, address_line1, address_line2, city, postcode, country, last_synced_at)
      VALUES (${contactId}, ${co.name}, ${contact?.email || null}, 'ACTIVE',
              ${co.address_line1 || null}, ${co.address_line2 || null}, ${co.city || null}, ${co.postcode || null}, ${co.country || null}, NOW())
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, last_synced_at = NOW()
    `;

    const [row] = await sql`
      SELECT c.id, c.name, c.domain, c.notes, c.xero_contact_id,
             c.customer_verified_at, c.customer_verified_by,
             c.address_line1, c.address_line2, c.city, c.postcode, c.country,
             c.created_at, c.updated_at,
             xc.name AS xero_contact_name
        FROM companies c
        LEFT JOIN xero_contacts xc ON xc.id = c.xero_contact_id
       WHERE c.id = ${id}
    `;
    return res.status(201).json(serialiseCompany(row));
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const cur = (await sql`
      SELECT id, name, domain, notes, xero_contact_id,
             customer_verified_at, customer_verified_by,
             address_line1, address_line2, city, postcode, country,
             created_at, updated_at
      FROM companies WHERE id = ${id}
    `)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    // Address is a nested object on the patch ({ address: { line1, line2, city,
    // postcode, country } }). Sending `address` replaces the whole address.
    const addr = 'address' in body ? (body.address || {}) : null;
    const next = {
      name:   'name'   in body ? (trimOrNull(body.name) || cur.name) : cur.name,
      domain: 'domain' in body ? lowerOrNull(body.domain) : cur.domain,
      notes:  'notes'  in body ? trimOrNull(body.notes) : cur.notes,
      xero_contact_id: 'xeroContactId' in body ? trimOrNull(body.xeroContactId) : cur.xero_contact_id,
      address_line1: addr ? trimOrNull(addr.line1) : cur.address_line1,
      address_line2: addr ? trimOrNull(addr.line2) : cur.address_line2,
      city:          addr ? trimOrNull(addr.city) : cur.city,
      postcode:      addr ? trimOrNull(addr.postcode) : cur.postcode,
      country:       addr ? trimOrNull(addr.country) : cur.country,
    };
    // Customer-verified is a toggle. Truthy → stamp now + caller; falsy → clear both.
    let verifiedAt = cur.customer_verified_at;
    let verifiedBy = cur.customer_verified_by;
    if ('customerVerified' in body) {
      if (body.customerVerified) {
        verifiedAt = new Date();
        verifiedBy = user.email || null;
      } else {
        verifiedAt = null;
        verifiedBy = null;
      }
    }
    await sql`
      UPDATE companies
         SET name = ${next.name},
             domain = ${next.domain},
             notes = ${next.notes},
             xero_contact_id = ${next.xero_contact_id},
             address_line1 = ${next.address_line1},
             address_line2 = ${next.address_line2},
             city = ${next.city},
             postcode = ${next.postcode},
             country = ${next.country},
             customer_verified_at = ${verifiedAt},
             customer_verified_by = ${verifiedBy},
             updated_at = NOW()
       WHERE id = ${id}
    `;

    // Two-way sync: when the address changed and the company is linked to a Xero
    // contact, push it onto that contact's STREET address. Non-fatal — the local
    // save has already succeeded, so a Xero hiccup just surfaces a flag.
    let xeroAddressSyncError = false;
    if (addr && next.xero_contact_id) {
      const hasAny = next.address_line1 || next.address_line2 || next.city || next.postcode || next.country;
      if (hasAny) {
        try {
          await updateContactAddress(next.xero_contact_id, {
            line1: next.address_line1,
            line2: next.address_line2,
            city: next.city,
            postcode: next.postcode,
            country: next.country,
          });
        } catch (err) {
          console.warn('[companies] failed to push address to Xero contact', next.xero_contact_id, err.message);
          xeroAddressSyncError = true;
        }
      }
    }

    const rows = await sql`
      SELECT c.id, c.name, c.domain, c.notes, c.xero_contact_id,
             c.customer_verified_at, c.customer_verified_by,
             c.address_line1, c.address_line2, c.city, c.postcode, c.country,
             c.created_at, c.updated_at,
             xc.address_line1 AS xero_address_line1,
             xc.address_line2 AS xero_address_line2,
             xc.city          AS xero_city,
             xc.postcode      AS xero_postcode,
             xc.country       AS xero_country,
             EXISTS(
               SELECT 1
                 FROM signatures s
                 JOIN proposals p ON p.id = s.proposal_id
                 JOIN deals d ON d.id = p.deal_id
                WHERE d.company_id = c.id
             ) AS has_signed_proposal
        FROM companies c
        LEFT JOIN xero_contacts xc ON xc.id = c.xero_contact_id
       WHERE c.id = ${id}
    `;
    return res.status(200).json({ ...serialiseCompany(rows[0]), xeroAddressSyncError });
  }
  if (req.method === 'DELETE') {
    if (!hasPermission(await getRole(user.role), 'companies.manage_all')) {
      return res.status(403).json({ error: 'You do not have permission to delete companies' });
    }
    await sql`DELETE FROM companies WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }
  return res.status(405).end();
}

// What a company owes on signed work: the gross (inc-VAT) total of every signed
// proposal at the company, minus everything paid against those proposals
// (Stripe, Partner, standalone manual payments, and paid manual invoices).
// All figures are inc-VAT so they reconcile. `outstanding` can read negative
// for Partner clients whose ongoing subscription has been paid beyond the
// committed first month — the UI clamps the headline "owed" at zero.
async function computeCompanyBalance(companyId) {
  const propRows = await sql`
    SELECT p.id FROM proposals p JOIN deals d ON d.id = p.deal_id WHERE d.company_id = ${companyId}
  `;
  const propIds = propRows.map(r => r.id);
  const dealRows = await sql`SELECT id FROM deals WHERE company_id = ${companyId}`;
  const dealIds = dealRows.map(r => r.id);

  const [committedRow] = await sql`
    SELECT COALESCE(SUM((s.data->>'total')::numeric), 0) AS committed
      FROM signatures s
      JOIN proposals p ON p.id = s.proposal_id
      JOIN deals d ON d.id = p.deal_id
     WHERE d.company_id = ${companyId}
       AND (s.data->>'total') ~ '^[0-9]+(\\.[0-9]+)?$'
  `;

  let paid = 0;
  if (propIds.length) {
    // Each tagged query returns an array of rows, so destructure the first row
    // out of each — `stripeRows.s` would be undefined → NaN → poisons `paid`.
    const [[stripeRow], [partnerRow], [manualPayRow]] = await Promise.all([
      sql`SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE proposal_id = ANY(${propIds})`,
      sql`SELECT COALESCE(SUM(amount), 0) AS s FROM partner_invoices WHERE proposal_id = ANY(${propIds})`,
      sql`SELECT COALESCE(SUM(amount), 0) AS s FROM manual_payments WHERE proposal_id = ANY(${propIds}) AND manual_invoice_id IS NULL`,
    ]);
    paid += Number(stripeRow.s) + Number(partnerRow.s) + Number(manualPayRow.s);
  }
  const [invPaidRow] = await sql`
    SELECT COALESCE(SUM(amount), 0) AS s FROM manual_invoices
     WHERE status = 'paid'
       AND (company_id = ${companyId}
            OR deal_id = ANY(${dealIds.length ? dealIds : ['__none__']})
            OR proposal_id = ANY(${propIds.length ? propIds : ['__none__']}))
  `;
  paid += Number(invPaidRow.s);

  // Money paid against a proposal-billing Xero invoice (the "email me an
  // invoice" / PO flows). Reconcile from live Xero first so the headline is
  // correct on load (not only after the invoices list has been opened), then
  // read the stamped figures. Best-effort — a Xero hiccup just uses last-known.
  let pbPaid = 0;
  if (propIds.length) {
    try {
      await reconcileProposalBillingPaid(propIds);
    } catch (err) {
      console.warn('[companies] proposal-billing paid reconcile failed', err.message);
    }
    const [pbPaidRow] = await sql`
      SELECT COALESCE(SUM(paid_amount), 0) AS s FROM proposal_billing
       WHERE proposal_id = ANY(${propIds}) AND paid_amount IS NOT NULL
    `;
    pbPaid = Number(pbPaidRow.s);
    paid += pbPaid;
  }

  // A deal whose proposal was signed >1h ago with no invoice raised and nothing
  // paid → it needs an invoice generating. The 1h gate matches the reminder cron.
  const [needsRow] = await sql`
    SELECT p.deal_id
      FROM signatures s
      JOIN proposals p ON p.id = s.proposal_id
      JOIN deals d ON d.id = p.deal_id
     WHERE d.company_id = ${companyId}
       AND s.signed_at < NOW() - INTERVAL '1 hour'
       AND NOT EXISTS (SELECT 1 FROM manual_invoices mi WHERE mi.proposal_id = s.proposal_id OR mi.deal_id = p.deal_id)
       AND NOT EXISTS (SELECT 1 FROM proposal_billing pb WHERE pb.proposal_id = s.proposal_id AND pb.xero_invoice_id IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM payments pay WHERE pay.proposal_id = s.proposal_id)
       AND NOT EXISTS (SELECT 1 FROM partner_invoices pi WHERE pi.proposal_id = s.proposal_id)
       AND NOT EXISTS (SELECT 1 FROM manual_payments mp WHERE mp.proposal_id = s.proposal_id)
     ORDER BY s.signed_at ASC
     LIMIT 1
  `;

  const committed = Number(committedRow.committed) || 0;
  return {
    committed: Number(committed.toFixed(2)),
    paid: Number(paid.toFixed(2)),
    // How much of `paid` came from Xero-generated (proposal-billing) invoices —
    // shown in the banner so it's clear these are reconciled from Xero.
    paidViaXeroInvoices: Number(pbPaid.toFixed(2)),
    outstanding: Number((committed - paid).toFixed(2)),
    needsInvoice: !!needsRow,
    needsInvoiceDealId: needsRow?.deal_id || null,
  };
}

// Same maths as computeCompanyBalance but for every company at once, via grouped
// aggregates — so the Organisations list can show "owed" without N round-trips.
async function allCompanyBalances() {
  const [committedRows, stripeRows, partnerRows, manualPayRows, invPaidRows, pbPaidRows] = await Promise.all([
    sql`
      SELECT d.company_id AS cid, COALESCE(SUM((s.data->>'total')::numeric), 0) AS v
        FROM signatures s
        JOIN proposals p ON p.id = s.proposal_id
        JOIN deals d ON d.id = p.deal_id
       WHERE d.company_id IS NOT NULL AND (s.data->>'total') ~ '^[0-9]+(\\.[0-9]+)?$'
       GROUP BY d.company_id
    `,
    sql`SELECT d.company_id AS cid, COALESCE(SUM(pay.amount), 0) AS v
          FROM payments pay JOIN proposals p ON p.id = pay.proposal_id JOIN deals d ON d.id = p.deal_id
         WHERE d.company_id IS NOT NULL GROUP BY d.company_id`,
    sql`SELECT d.company_id AS cid, COALESCE(SUM(pi.amount), 0) AS v
          FROM partner_invoices pi JOIN proposals p ON p.id = pi.proposal_id JOIN deals d ON d.id = p.deal_id
         WHERE d.company_id IS NOT NULL GROUP BY d.company_id`,
    sql`SELECT d.company_id AS cid, COALESCE(SUM(mp.amount), 0) AS v
          FROM manual_payments mp JOIN proposals p ON p.id = mp.proposal_id JOIN deals d ON d.id = p.deal_id
         WHERE mp.manual_invoice_id IS NULL AND d.company_id IS NOT NULL GROUP BY d.company_id`,
    sql`SELECT COALESCE(mi.company_id, d.company_id, dp.company_id) AS cid, COALESCE(SUM(mi.amount), 0) AS v
          FROM manual_invoices mi
          LEFT JOIN deals d ON d.id = mi.deal_id
          LEFT JOIN proposals pr ON pr.id = mi.proposal_id
          LEFT JOIN deals dp ON dp.id = pr.deal_id
         WHERE mi.status = 'paid'
         GROUP BY COALESCE(mi.company_id, d.company_id, dp.company_id)`,
    sql`SELECT d.company_id AS cid, COALESCE(SUM(pb.paid_amount), 0) AS v
          FROM proposal_billing pb JOIN proposals p ON p.id = pb.proposal_id JOIN deals d ON d.id = p.deal_id
         WHERE pb.paid_amount IS NOT NULL AND d.company_id IS NOT NULL GROUP BY d.company_id`,
  ]);

  const committed = new Map(committedRows.map(r => [r.cid, Number(r.v) || 0]));
  const paid = new Map();
  for (const rows of [stripeRows, partnerRows, manualPayRows, invPaidRows, pbPaidRows]) {
    for (const r of rows) {
      if (!r.cid) continue;
      paid.set(r.cid, (paid.get(r.cid) || 0) + (Number(r.v) || 0));
    }
  }

  const out = {};
  for (const [cid, c] of committed) {
    const p = paid.get(cid) || 0;
    out[cid] = { committed: Number(c.toFixed(2)), paid: Number(p.toFixed(2)), outstanding: Number((c - p).toFixed(2)) };
  }
  return out;
}

export function serialiseCompany(r) {
  const verifiedAt = r.customer_verified_at || null;
  const hasSigned = !!r.has_signed_proposal;
  // The Xero address columns only come back from queries that LEFT JOIN
  // xero_contacts (list / detail / PATCH return). Absent elsewhere → null,
  // so the SPA falls back to the company's own stored address.
  const hasXeroAddr = r.xero_address_line1 !== undefined
    || r.xero_address_line2 !== undefined
    || r.xero_city !== undefined
    || r.xero_postcode !== undefined
    || r.xero_country !== undefined;
  return {
    id: r.id,
    name: r.name,
    domain: r.domain || null,
    notes: r.notes || null,
    xeroContactId: r.xero_contact_id || null,
    address: {
      line1: r.address_line1 || null,
      line2: r.address_line2 || null,
      city: r.city || null,
      postcode: r.postcode || null,
      country: r.country || null,
    },
    // The linked Xero contact's address, used to prefill the form when the
    // company has no address of its own yet (two-way sync).
    xeroAddress: hasXeroAddr ? {
      line1: r.xero_address_line1 || null,
      line2: r.xero_address_line2 || null,
      city: r.xero_city || null,
      postcode: r.xero_postcode || null,
      country: r.xero_country || null,
    } : null,
    // Name comes from the LEFT JOIN on xero_contacts in the detail query.
    // Null when the company isn't linked, or when the Xero mirror hasn't
    // been synced yet (sync runs on-demand via POST /api/crm/xero-contacts/sync).
    xeroContactName: r.xero_contact_name || null,
    customerVerifiedAt: verifiedAt,
    customerVerifiedBy: r.customer_verified_by || null,
    // hasSignedProposal is only present on rows that came from a list/detail
    // SELECT — older serialise call-sites (e.g. quote-request qualify) just
    // get `undefined` here, which the SPA treats as `false`. That's fine
    // because the SPA refreshes companies on the next interaction anyway.
    hasSignedProposal: r.has_signed_proposal !== undefined ? hasSigned : null,
    isCustomer: !!verifiedAt || hasSigned,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
