// CRM "extras" handler — ad-hoc charges added to a deal/project during
// production (extra video, human VO, additional revisions…). They sit on top
// of the signed proposal total and show as their own line in Pending Payments
// under the same deal/project number.
//
// Stage 1 is record-only: an extra is saved against the deal and collected
// later. Stage 2 will let "invoice now" raise a Xero invoice (xero_invoice_id /
// invoice_number are already on the row for that).

import sql from '../db.js';
import { makeId, trimOrNull, numberOrNull } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';

// Self-heal for db/migrations/20260604_deal_extras.sql so the table exists even
// where the migration hasn't been run by hand.
let dealExtrasEnsured = null;
export function ensureDealExtrasTable() {
  if (dealExtrasEnsured) return dealExtrasEnsured;
  dealExtrasEnsured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS deal_extras (
        id              TEXT        PRIMARY KEY,
        deal_id         TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        description     TEXT        NOT NULL,
        amount          NUMERIC     NOT NULL,
        vat_rate        NUMERIC,
        status          TEXT        NOT NULL DEFAULT 'pending',
        xero_invoice_id TEXT,
        invoice_number  TEXT,
        created_by      TEXT        REFERENCES users(email) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS deal_extras_deal_idx ON deal_extras(deal_id)`;
  })().catch((err) => { dealExtrasEnsured = null; throw err; });
  return dealExtrasEnsured;
}

function serialiseExtra(r) {
  return {
    id: r.id,
    dealId: r.deal_id,
    description: r.description,
    amount: r.amount == null ? null : Number(r.amount),
    vatRate: r.vat_rate == null ? null : Number(r.vat_rate),
    status: r.status,
    xeroInvoiceId: r.xero_invoice_id || null,
    invoiceNumber: r.invoice_number || null,
    createdBy: r.created_by || null,
    createdAt: r.created_at,
  };
}

// Not-yet-invoiced extras for one deal, shaped for billing as invoice line
// items on the final invoice ("Add extra to final"). Only 'pending' rows —
// once an extra has ridden onto an invoice ('invoiced') we don't re-suggest it,
// so it can't be billed twice. vatRate is the stored fraction (e.g. 0.2) or
// null to inherit the proposal's rate.
export async function pendingExtrasForDeal(dealId) {
  await ensureDealExtrasTable();
  const rows = await sql`
    SELECT id, description, amount, vat_rate
      FROM deal_extras
     WHERE deal_id = ${dealId} AND status = 'pending'
     ORDER BY created_at ASC`;
  return rows.map((r) => ({
    id: r.id,
    description: r.description,
    amount: Number(r.amount) || 0,
    vatRate: r.vat_rate == null ? null : Number(r.vat_rate),
  }));
}

// Link extras to the final invoice they were billed on. Flips 'pending' →
// 'invoiced' and stores the Xero id/number so payment can later settle them.
// Only touches still-pending rows, so re-running is a no-op. Returns count.
export async function markExtrasInvoiced(extraIds, xeroInvoiceId, invoiceNumber) {
  const ids = (extraIds || []).filter(Boolean);
  if (!ids.length) return 0;
  await ensureDealExtrasTable();
  const rows = await sql`
    UPDATE deal_extras
       SET status = 'invoiced',
           xero_invoice_id = ${xeroInvoiceId || null},
           invoice_number = ${invoiceNumber || null},
           updated_at = NOW()
     WHERE id = ANY(${ids}) AND status = 'pending'
    RETURNING id`;
  return rows.length;
}

// When an invoice settles, the extras billed on it are paid too — drop them
// from outstanding. Idempotent (only flips non-paid rows). Returns count.
export async function markExtrasPaidForXeroInvoice(xeroInvoiceId) {
  if (!xeroInvoiceId) return 0;
  await ensureDealExtrasTable();
  const rows = await sql`
    UPDATE deal_extras
       SET status = 'paid', updated_at = NOW()
     WHERE xero_invoice_id = ${xeroInvoiceId} AND status <> 'paid'
    RETURNING id`;
  return rows.length;
}

// If the invoice an extra rode on is voided, release the extra back to
// 'pending' (clearing the link) so it can be billed on a fresh invoice. Never
// touches already-paid rows. Returns count.
export async function releaseExtrasForVoidedInvoice(xeroInvoiceId) {
  if (!xeroInvoiceId) return 0;
  await ensureDealExtrasTable();
  const rows = await sql`
    UPDATE deal_extras
       SET status = 'pending', xero_invoice_id = NULL, invoice_number = NULL, updated_at = NOW()
     WHERE xero_invoice_id = ${xeroInvoiceId} AND status = 'invoiced'
    RETURNING id`;
  return rows.length;
}

// For the Pending Payments report: unpaid extras grouped by deal, as net £.
export async function outstandingExtrasByDeal() {
  await ensureDealExtrasTable();
  const rows = await sql`
    SELECT id, deal_id, description, amount, status
      FROM deal_extras
     WHERE status <> 'paid'
     ORDER BY created_at ASC`;
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.deal_id)) map.set(r.deal_id, []);
    map.get(r.deal_id).push({
      id: r.id,
      description: r.description,
      amount: Number(r.amount) || 0,
      status: r.status,
    });
  }
  return map;
}

export async function extrasRoute(req, res, id, action, user) {
  await ensureDealExtrasTable();

  // GET /api/crm/extras?dealId=... — list a deal's extras.
  if (req.method === 'GET' && !id) {
    const dealId = trimOrNull(req.query.dealId);
    if (!dealId) return res.status(400).json({ error: 'dealId required' });
    const rows = await sql`
      SELECT * FROM deal_extras WHERE deal_id = ${dealId} ORDER BY created_at DESC`;
    return res.status(200).json(rows.map(serialiseExtra));
  }

  // Everything below mutates money state — gate on invoice management.
  const canManage = hasPermission(await getRole(user.role), 'invoices.manage');

  // POST /api/crm/extras — create a pending extra on a deal.
  if (req.method === 'POST' && !id) {
    if (!canManage) return res.status(403).json({ error: 'Forbidden' });
    const body = req.body || {};
    const dealId = trimOrNull(body.dealId);
    const description = trimOrNull(body.description);
    const amount = numberOrNull(body.amount);
    const vatRate = body.vatRate == null || body.vatRate === '' ? null : numberOrNull(body.vatRate);
    if (!dealId) return res.status(400).json({ error: 'dealId required' });
    if (!description) return res.status(400).json({ error: 'description required' });
    if (amount == null || amount <= 0) return res.status(400).json({ error: 'A positive amount is required' });

    const [dealRow] = await sql`SELECT id FROM deals WHERE id = ${dealId}`;
    if (!dealRow) return res.status(404).json({ error: 'Deal not found' });

    const newId = makeId('xtr');
    const [row] = await sql`
      INSERT INTO deal_extras (id, deal_id, description, amount, vat_rate, status, created_by)
      VALUES (${newId}, ${dealId}, ${description}, ${amount}, ${vatRate}, 'pending', ${user.email || null})
      RETURNING *`;
    return res.status(201).json(serialiseExtra(row));
  }

  // PATCH /api/crm/extras/:id — edit fields or change status.
  if ((req.method === 'PATCH' || req.method === 'PUT') && id) {
    if (!canManage) return res.status(403).json({ error: 'Forbidden' });
    const [cur] = await sql`SELECT * FROM deal_extras WHERE id = ${id}`;
    if (!cur) return res.status(404).json({ error: 'Extra not found' });
    const body = req.body || {};
    const description = 'description' in body ? trimOrNull(body.description) : cur.description;
    const amount = 'amount' in body ? numberOrNull(body.amount) : cur.amount;
    const status = 'status' in body ? trimOrNull(body.status) : cur.status;
    if (!description) return res.status(400).json({ error: 'description required' });
    if (amount == null || amount <= 0) return res.status(400).json({ error: 'A positive amount is required' });
    if (!['pending', 'invoiced', 'paid'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const [row] = await sql`
      UPDATE deal_extras
         SET description = ${description}, amount = ${amount}, status = ${status}, updated_at = NOW()
       WHERE id = ${id}
      RETURNING *`;
    return res.status(200).json(serialiseExtra(row));
  }

  // DELETE /api/crm/extras/:id — only a 'pending' extra can be deleted. Once it's
  // on an invoice (invoiced/paid) it must be removed by voiding/deleting that
  // invoice, which releases the extra back to pending — so we never orphan a
  // Xero line or silently drop billed work.
  if (req.method === 'DELETE' && id) {
    if (!canManage) return res.status(403).json({ error: 'Forbidden' });
    const [cur] = await sql`SELECT status FROM deal_extras WHERE id = ${id}`;
    if (!cur) return res.status(200).json({ ok: true }); // already gone — idempotent
    if (cur.status !== 'pending') {
      return res.status(409).json({ error: 'This extra is on an invoice — void or delete that invoice first to remove it.' });
    }
    await sql`DELETE FROM deal_extras WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
