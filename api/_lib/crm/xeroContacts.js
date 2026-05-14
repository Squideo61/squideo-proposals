// Local mirror of Xero contacts. The CRM typeahead reads from `xero_contacts`
// instead of querying Xero on every keystroke. Operators refresh on demand
// via POST /api/crm/xero-contacts/sync (admin only).

import sql from '../db.js';
import { listAllContacts } from '../xero.js';

export async function xeroContactsRoute(req, res, id, action, user) {
  // POST /api/crm/xero-contacts/sync — pull every contact from Xero and
  // upsert into the mirror. Admin only because it can run for several
  // seconds and burns Xero API quota.
  if (id === 'sync' && req.method === 'POST') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
      const contacts = await listAllContacts();
      // Parallelise the upserts — each sql\`...\` is one HTTP call to Neon
      // (~75ms), so sequential is painfully slow for hundreds of contacts.
      // 25 in flight keeps Neon happy and well inside Vercel's 60s timeout.
      const CONCURRENCY = 25;
      let upserts = 0;
      for (let i = 0; i < contacts.length; i += CONCURRENCY) {
        const chunk = contacts.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map(c => upsertContact(c).then(() => { upserts += 1; })));
      }
      return res.status(200).json({ total: contacts.length, upserts });
    } catch (err) {
      console.error('[xero-contacts] sync failed', err);
      return res.status(500).json({ error: err.message || 'Sync failed' });
    }
  }

  // GET /api/crm/xero-contacts/duplicates — clusters of likely-duplicate
  // contacts grouped by a normalized name (strip Ltd/Limited/Inc + punctuation).
  if (id === 'duplicates' && req.method === 'GET') {
    const rows = await sql`
      SELECT id, name, email, status, default_currency, xero_updated_at,
             LOWER(REGEXP_REPLACE(REGEXP_REPLACE(name, '\\s*\\(?(ltd|limited|inc|llc|plc|the)\\)?\\.?$', '', 'gi'), '[^a-z0-9]', '', 'gi')) AS norm
        FROM xero_contacts
       WHERE status != 'ARCHIVED'
       ORDER BY name
    `;
    const groups = new Map();
    for (const r of rows) {
      if (!r.norm) continue;
      if (!groups.has(r.norm)) groups.set(r.norm, []);
      groups.get(r.norm).push({
        id: r.id, name: r.name, email: r.email, status: r.status,
        defaultCurrency: r.default_currency, xeroUpdatedAt: r.xero_updated_at,
      });
    }
    const clusters = [...groups.values()].filter(g => g.length > 1);
    return res.status(200).json({ clusters });
  }

  // GET /api/crm/xero-contacts/search?q=... — typeahead.
  if (!id && req.method === 'GET' && req.query.q != null) {
    const q = String(req.query.q || '').trim();
    const includeArchived = req.query.includeArchived === '1';
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    if (!q) return res.status(200).json([]);
    const like = q.toLowerCase() + '%';
    const contains = '%' + q.toLowerCase() + '%';
    const rows = includeArchived
      ? await sql`
          SELECT id, name, email, vat_number, default_currency, status, country
            FROM xero_contacts
           WHERE LOWER(name) LIKE ${like}
              OR LOWER(name) LIKE ${contains}
              OR LOWER(email) LIKE ${contains}
           ORDER BY (LOWER(name) LIKE ${like}) DESC, name ASC
           LIMIT ${limit}
        `
      : await sql`
          SELECT id, name, email, vat_number, default_currency, status, country
            FROM xero_contacts
           WHERE status != 'ARCHIVED'
             AND (LOWER(name) LIKE ${like}
                  OR LOWER(name) LIKE ${contains}
                  OR LOWER(email) LIKE ${contains})
           ORDER BY (LOWER(name) LIKE ${like}) DESC, name ASC
           LIMIT ${limit}
        `;
    return res.status(200).json(rows.map(serialise));
  }

  // GET /api/crm/xero-contacts — full list (capped). For an admin overview.
  if (!id && req.method === 'GET') {
    const rows = await sql`
      SELECT id, name, email, vat_number, default_currency, status, country
        FROM xero_contacts
       WHERE status != 'ARCHIVED'
       ORDER BY name ASC
       LIMIT 500
    `;
    return res.status(200).json(rows.map(serialise));
  }

  // GET /api/crm/xero-contacts/:id — single row.
  if (id && req.method === 'GET' && !action) {
    const [row] = await sql`
      SELECT id, name, email, vat_number, default_currency, status,
             address_line1, address_line2, city, postcode, country, phone,
             xero_updated_at, last_synced_at
        FROM xero_contacts WHERE id = ${id}
    `;
    if (!row) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json(serialise(row));
  }

  return res.status(405).end();
}

function serialise(r) {
  return {
    id: r.id,
    name: r.name,
    email: r.email || null,
    vatNumber: r.vat_number || null,
    defaultCurrency: r.default_currency || null,
    status: r.status || 'ACTIVE',
    addressLine1: r.address_line1 || null,
    addressLine2: r.address_line2 || null,
    city: r.city || null,
    postcode: r.postcode || null,
    country: r.country || null,
    phone: r.phone || null,
    xeroUpdatedAt: r.xero_updated_at || null,
    lastSyncedAt: r.last_synced_at || null,
  };
}

// Upserts a single Xero contact into the mirror.
async function upsertContact(c) {
  const addr = (c.Addresses || []).find(a => a.AddressType === 'STREET')
    || (c.Addresses || [])[0]
    || {};
  const phone = (c.Phones || [])
    .map(p => [p.PhoneCountryCode, p.PhoneAreaCode, p.PhoneNumber].filter(Boolean).join(' ').trim())
    .filter(Boolean)[0] || null;
  await sql`
    INSERT INTO xero_contacts (
      id, name, email, vat_number, default_currency, status,
      address_line1, address_line2, city, postcode, country, phone,
      is_supplier, is_customer, xero_updated_at, last_synced_at
    ) VALUES (
      ${c.ContactID},
      ${c.Name || ''},
      ${c.EmailAddress || null},
      ${c.TaxNumber || null},
      ${c.DefaultCurrency || null},
      ${c.ContactStatus || 'ACTIVE'},
      ${addr.AddressLine1 || null},
      ${addr.AddressLine2 || null},
      ${addr.City || null},
      ${addr.PostalCode || null},
      ${addr.Country || null},
      ${phone},
      ${!!c.IsSupplier},
      ${!!c.IsCustomer},
      ${parseXeroUpdated(c.UpdatedDateUTC)},
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      name             = EXCLUDED.name,
      email            = EXCLUDED.email,
      vat_number       = EXCLUDED.vat_number,
      default_currency = EXCLUDED.default_currency,
      status           = EXCLUDED.status,
      address_line1    = EXCLUDED.address_line1,
      address_line2    = EXCLUDED.address_line2,
      city             = EXCLUDED.city,
      postcode         = EXCLUDED.postcode,
      country          = EXCLUDED.country,
      phone            = EXCLUDED.phone,
      is_supplier      = EXCLUDED.is_supplier,
      is_customer      = EXCLUDED.is_customer,
      xero_updated_at  = EXCLUDED.xero_updated_at,
      last_synced_at   = NOW()
  `;
}

// Xero serialises UpdatedDateUTC as /Date(1736899200000+0000)/.
function parseXeroUpdated(value) {
  if (!value) return null;
  const m = String(value).match(/\/Date\((\d+)/);
  const d = m ? new Date(Number(m[1])) : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
