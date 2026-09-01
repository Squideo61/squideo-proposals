// CRM "extras" handler — ad-hoc charges added to a deal/project during
// production (extra video, human VO, additional revisions…). They sit on top
// of the signed proposal total and show as their own line in Pending Payments
// under the same deal/project number.
//
// Stage 1 is record-only: an extra is saved against the deal and collected
// later. Stage 2 will let "invoice now" raise a Xero invoice (xero_invoice_id /
// invoice_number are already on the row for that).

import sql, { batchWrite } from '../db.js';
import { makeId, trimOrNull, numberOrNull } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { sendNotification, ensureExtraAddedNotificationDefault } from '../notifications.js';
import { getOrCreateContact, createQuote, voidQuote, addLineToInvoice } from '../xero.js';
// Imported lazily-at-call (circular: invoices.js imports markExtrasInvoiced from
// here). ESM live bindings make this safe as long as we only call inside handlers.
import { createXeroInvoiceForDeal, resolveXeroContactInfo } from './invoices.js';

// How an extra is billed:
//   'final'            — sits on the deal as a pending line, rides the final invoice
//   'invoice_now'      — its own Xero invoice raised immediately
//   'po'               — a Xero quote ("Pending PO") is raised; later turned into
//                        an invoice from the Purchase Orders section
//   'po_awaited'       — sold against a purchase order the client hasn't raised
//                        yet: nothing goes to Xero, the charge sits pending in
//                        Purchase Orders until there's a PO number to invoice
//                        against. (Unlike 'po', which parks it as a 'quoted' row
//                        — and quoted rows are not receivables, so they'd drop
//                        out of Pending Payments entirely.)
//   'existing_invoice' — appended as a line to one of the deal's still-open Xero
//                        invoices (requires `xeroInvoiceId`)
const PAYMENT_TYPES = ['final', 'invoice_now', 'po', 'po_awaited', 'existing_invoice'];

// The deal's effective VAT rate as a percent (deal_extras.vat_rate is a fraction
// or null = inherit; deals.vat_rate is a fraction, default 20% when unset).
function dealVatPercent(dealVatRate) {
  const frac = dealVatRate != null ? Number(dealVatRate) : 0.2;
  return (Number.isFinite(frac) ? frac : 0.2) * 100;
}

// Alert Admins + Directors that an ad-hoc extra was logged on a deal (in-app
// bell + desktop push; no email — these are frequent production-floor actions).
// The creator is excluded. Best-effort; never fails the write.
//
// On a deal with no signed proposal the same record is the SALE, not an addition
// to one, and that's the more newsworthy of the two: money just came in on a job
// finance has no proposal for. So it's announced as a sale, off the same key —
// the audience and the "who needs to know about unbilled money" question are
// identical, and splitting it would mean a second switch to keep in step.
async function notifyExtraAdded({ dealId, dealTitle, description, amount, author, paymentType, invoiceNumber, isSale, saleContext = ' (no proposal)' }) {
  try {
    await ensureExtraAddedNotificationDefault();
    const amountStr = '£' + (Number(amount) || 0).toFixed(2);
    const who = author?.name || author?.email || 'A production manager';
    const title = dealTitle || 'a deal';
    const route = paymentType === 'invoice_now'
        ? (invoiceNumber ? `invoiced now (${invoiceNumber})` : 'invoiced now')
      : paymentType === 'po' ? 'raised as a PO quote'
      : paymentType === 'po_awaited' ? 'awaiting a purchase order'
      : paymentType === 'existing_invoice' ? `added to invoice ${invoiceNumber || ''}`.trim()
      : isSale ? 'to invoice later'
      : 'added to the final invoice';
    await sendNotification('extra.added', {
      excludeEmails: author?.email ? [author.email] : null,
      subject: isSale ? `Sale recorded — ${title}` : `Extra charge added — ${title}`,
      text: isSale
        ? `${who} recorded a sale on ${title}${saleContext}: ${description} (${amountStr} ex-VAT) — ${route}.`
        : `${who} added an extra charge to ${title}: ${description} (${amountStr} ex-VAT) — ${route}.`,
      inApp: {
        title: isSale ? `Sale recorded: ${amountStr} ex-VAT` : `Extra charge: ${amountStr} ex-VAT`,
        body: `${who} · ${title} · ${description} · ${route}`,
        link: `#/deal/${dealId}`,
      },
      inAppOnly: true,
    });
  } catch (err) {
    console.error('[extras] notify failed', err);
  }
}

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
    // How the extra is billed + the Xero quote raised for PO-route extras.
    // (See db/migrations/20260624_deal_extras_payment_type.sql.)
    await sql`ALTER TABLE deal_extras ADD COLUMN IF NOT EXISTS payment_type TEXT NOT NULL DEFAULT 'final'`;
    await sql`ALTER TABLE deal_extras ADD COLUMN IF NOT EXISTS xero_quote_id TEXT`;
    await sql`ALTER TABLE deal_extras ADD COLUMN IF NOT EXISTS quote_number TEXT`;
    // Durable paid-date for Staff Commission (see 20260710_deal_extras_paid_at.sql).
    await sql`ALTER TABLE deal_extras ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`;
    await sql`UPDATE deal_extras SET paid_at = updated_at WHERE status = 'paid' AND paid_at IS NULL`;
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
    paymentType: r.payment_type || 'final',
    xeroInvoiceId: r.xero_invoice_id || null,
    invoiceNumber: r.invoice_number || null,
    xeroQuoteId: r.xero_quote_id || null,
    quoteNumber: r.quote_number || null,
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
     WHERE id = ANY(${ids}) AND status IN ('pending', 'quoted')
    RETURNING id`;
  return rows.length;
}

// Record a Xero invoice raised from the "Create invoice" modal as a new sale.
//
// Invoicing and selling aren't the same act — most invoices bill money the CRM
// already knows about (a signed proposal's deposit or balance, an extra someone
// logged). But an invoice raised for work sold off-proposal IS the sale, and
// with nothing recorded against it the money is invisible to the sales figures,
// to commission, and to everyone who isn't the person who raised it. That's the
// gap "Add extra" filled, if you knew it was there. Here the modal asks, and a
// yes lands the same deal_extras rows — one per billed line, already 'invoiced'
// against this Xero invoice — plus the alert Admins and Directors would have got.
//
// Best-effort by design: the invoice is real in Xero by the time we get here, so
// a failure to record it must not fail the request. Returns the ids created.
export async function recordSaleFromInvoice({ dealId, lineItems, xeroInvoiceId, invoiceNumber, author }) {
  if (!dealId) return [];
  await ensureDealExtrasTable();

  // One row per billed line, net of VAT and of any line discount, so the
  // recorded sale totals exactly what the invoice bills. Zero-value lines (the
  // 100%-off free subtitles, say) aren't sales and are skipped.
  const rows = [];
  for (const li of lineItems || []) {
    const description = trimOrNull(li?.description);
    const qty = Number(li?.quantity) || 1;
    const price = Number(li?.unitAmount) || 0;
    const disc = Number(li?.discountRate) || 0;
    const net = Number((qty * price * (1 - disc / 100)).toFixed(2));
    if (!description || net <= 0) continue;
    rows.push({ id: makeId('xtr'), description, net, vatRate: (Number(li?.vatRate) || 0) / 100 });
  }
  if (!rows.length) return [];

  const [dealRow] = await sql`SELECT title FROM deals WHERE id = ${dealId}`;
  try {
    await batchWrite(rows.map((r) => sql`
      INSERT INTO deal_extras (
        id, deal_id, description, amount, vat_rate, status, payment_type,
        xero_invoice_id, invoice_number, created_by
      ) VALUES (
        ${r.id}, ${dealId}, ${r.description}, ${r.net}, ${r.vatRate}, 'invoiced', 'invoice_now',
        ${xeroInvoiceId || null}, ${invoiceNumber || null}, ${author?.email || null}
      )`));
  } catch (err) {
    console.error('[extras] recordSaleFromInvoice insert failed', err);
    return [];
  }

  await notifyExtraAdded({
    dealId,
    dealTitle: dealRow?.title,
    description: rows.map((r) => r.description).join(', '),
    amount: rows.reduce((sum, r) => sum + r.net, 0),
    author,
    paymentType: 'invoice_now',
    invoiceNumber,
    isSale: true,
    saleContext: '', // unlike the no-proposal case, this deal may well have one
  });
  return rows.map((r) => r.id);
}

// When an invoice settles, the extras billed on it are paid too — drop them
// from outstanding. Idempotent (only flips non-paid rows). Returns count.
export async function markExtrasPaidForXeroInvoice(xeroInvoiceId) {
  if (!xeroInvoiceId) return 0;
  await ensureDealExtrasTable();
  const rows = await sql`
    UPDATE deal_extras
       SET status = 'paid', paid_at = NOW(), updated_at = NOW()
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
// 'quoted' (PO-route) extras are excluded — a quote isn't a receivable yet; it
// lives in the Purchase Orders section until it's turned into an invoice.
export async function outstandingExtrasByDeal() {
  await ensureDealExtrasTable();
  const rows = await sql`
    SELECT id, deal_id, description, amount, status, vat_rate, payment_type
      FROM deal_extras
     WHERE status NOT IN ('paid', 'quoted')
     ORDER BY created_at ASC`;
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.deal_id)) map.set(r.deal_id, []);
    map.get(r.deal_id).push({
      id: r.id,
      description: r.description,
      amount: Number(r.amount) || 0,
      status: r.status,
      // Both drive the report: its own VAT rate grosses the line, and the
      // payment type is what tells a proposal-less deal apart as PO-route.
      vatRate: r.vat_rate == null ? null : Number(r.vat_rate),
      paymentType: r.payment_type || 'final',
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

  // Permissions: anyone who works production (production.access) can LOG an
  // extra during a shoot/edit — the management team is alerted and it lands in
  // Pending Payments for review. Editing amounts/status and billing still
  // require invoices.manage (money state); the creator may delete their own
  // not-yet-invoiced extra to fix a mistake.
  const role = await getRole(user.role);
  const canManage = hasPermission(role, 'invoices.manage');
  const canAddExtra = canManage || hasPermission(role, 'production.access');

  // POST /api/crm/extras — create an extra on a deal, billed one of three ways
  // (paymentType: 'final' | 'invoice_now' | 'po').
  if (req.method === 'POST' && !id) {
    if (!canAddExtra) return res.status(403).json({ error: 'Forbidden' });
    const body = req.body || {};
    const dealId = trimOrNull(body.dealId);
    const description = trimOrNull(body.description);
    const amount = numberOrNull(body.amount);
    const vatRate = body.vatRate == null || body.vatRate === '' ? null : numberOrNull(body.vatRate);
    const paymentType = PAYMENT_TYPES.includes(body.paymentType) ? body.paymentType : 'final';
    if (!dealId) return res.status(400).json({ error: 'dealId required' });
    if (!description) return res.status(400).json({ error: 'description required' });
    if (amount == null || amount <= 0) return res.status(400).json({ error: 'A positive amount is required' });

    const [dealRow] = await sql`
      SELECT d.id, d.title, d.vat_rate, d.po_number, c.name AS company_name,
             EXISTS (
               SELECT 1 FROM signatures s
                 JOIN proposals p ON p.id = s.proposal_id
                WHERE p.deal_id = d.id
             ) AS has_signature
        FROM deals d LEFT JOIN companies c ON c.id = d.company_id
       WHERE d.id = ${dealId}`;
    if (!dealRow) return res.status(404).json({ error: 'Deal not found' });
    // Derived here rather than taken from the caller: it decides what the alert
    // tells Admins and Directors happened, and the client shouldn't get a vote.
    const isSale = !dealRow.has_signature;
    const vatPct = dealVatPercent(dealRow.vat_rate);

    // Always record the extra first (pending), then run the chosen billing
    // action. If that Xero step fails we roll the row back so nothing is orphaned.
    const newId = makeId('xtr');
    let invoiceNumber = null; // set by the existing_invoice branch, for the notification
    await sql`
      INSERT INTO deal_extras (id, deal_id, description, amount, vat_rate, status, payment_type, created_by)
      VALUES (${newId}, ${dealId}, ${description}, ${amount}, ${vatRate}, 'pending', ${paymentType}, ${user.email || null})`;

    if (paymentType === 'invoice_now') {
      try {
        await createXeroInvoiceForDeal({
          dealId,
          contactName: dealRow.company_name,
          lineItems: [{ description, quantity: 1, unitAmount: amount, vatRate: vatPct }],
          reference: dealRow.po_number || undefined,
          extraIds: [newId], // flips the extra to 'invoiced' + links the Xero id
        }, user);
      } catch (err) {
        await sql`DELETE FROM deal_extras WHERE id = ${newId}`;
        console.error('[extras] invoice_now failed', err);
        return res.status(err.status || 502).json({ error: 'Could not create invoice: ' + (err.message || 'unknown') });
      }
    } else if (paymentType === 'po') {
      try {
        const info = await resolveXeroContactInfo(dealId, null);
        const contactId = await getOrCreateContact({
          xeroContactId: info?.xeroContactId || undefined,
          name: info?.name || dealRow.company_name || dealRow.title,
          email: info?.email || undefined,
        });
        const ref = `${dealRow.title || dealId} — Pending PO`.slice(0, 80);
        const { quoteId, quoteNumber } = await createQuote({
          contactId,
          lineItems: [{ description, quantity: 1, unitAmount: amount, taxType: vatPct > 0 ? 'OUTPUT2' : 'NONE', accountCode: '200' }],
          reference: ref,
          status: 'SENT',
        });
        await sql`
          UPDATE deal_extras
             SET xero_quote_id = ${quoteId}, quote_number = ${quoteNumber}, status = 'quoted', updated_at = NOW()
           WHERE id = ${newId}`;
      } catch (err) {
        await sql`DELETE FROM deal_extras WHERE id = ${newId}`;
        console.error('[extras] po quote failed', err);
        return res.status(502).json({ error: 'Could not create PO quote: ' + (err.message || 'unknown') });
      }
    } else if (paymentType === 'existing_invoice') {
      // Append this extra as a line on one of the deal's own still-open Xero
      // invoices. Guard against cross-deal linking (must be this deal's invoice)
      // and against paid/void targets (Xero can't edit those — raise a new
      // invoice instead). On any failure the pending row is rolled back.
      const xeroInvoiceId = trimOrNull(body.xeroInvoiceId);
      if (!xeroInvoiceId) {
        await sql`DELETE FROM deal_extras WHERE id = ${newId}`;
        return res.status(400).json({ error: 'Pick an invoice to add this extra to.' });
      }
      const [mi] = await sql`
        SELECT id, invoice_number, status FROM manual_invoices
         WHERE xero_invoice_id = ${xeroInvoiceId} AND deal_id = ${dealId}`;
      if (!mi) {
        await sql`DELETE FROM deal_extras WHERE id = ${newId}`;
        return res.status(404).json({ error: "That invoice isn't on this deal." });
      }
      if (mi.status !== 'issued') {
        await sql`DELETE FROM deal_extras WHERE id = ${newId}`;
        return res.status(409).json({ error: 'That invoice is already paid or voided — use “Create invoice now” for a new one.' });
      }
      try {
        const upd = await addLineToInvoice(xeroInvoiceId, {
          description, quantity: 1, unitAmount: amount,
          taxType: vatPct > 0 ? 'OUTPUT2' : 'NONE', accountCode: '200',
        });
        invoiceNumber = mi.invoice_number || upd.invoiceNumber || null;
        await markExtrasInvoiced([newId], xeroInvoiceId, invoiceNumber);
        // Keep the stored invoice totals in step (the card also live-enriches
        // from Xero on load, but Pending Payments reads the stored amount).
        if (upd.total != null) {
          await sql`
            UPDATE manual_invoices
               SET amount = ${upd.total}, subtotal_ex_vat = ${upd.subTotal}, tax_amount = ${upd.totalTax}, updated_at = NOW()
             WHERE id = ${mi.id}`;
        }
      } catch (err) {
        await sql`DELETE FROM deal_extras WHERE id = ${newId}`;
        console.error('[extras] existing_invoice failed', err);
        return res.status(err.status || 502).json({ error: 'Could not add to invoice: ' + (err.message || 'unknown') });
      }
    }
    // 'final' leaves the extra pending to ride the final invoice; 'po_awaited'
    // likewise stays pending, but shows in Purchase Orders until the client's PO
    // number arrives and it can be invoiced.

    await notifyExtraAdded({ dealId, dealTitle: dealRow.title, description, amount, author: user, paymentType, invoiceNumber, isSale });
    const [row] = await sql`SELECT * FROM deal_extras WHERE id = ${newId}`;
    return res.status(201).json(serialiseExtra(row));
  }

  // POST /api/crm/extras/:id/invoice — turn a PO-route extra's quote into an
  // invoice (and void the quote, Xero-style). Mirrors "create invoice from
  // quote" in Xero. Allowed to anyone who can log extras.
  if (req.method === 'POST' && id && action === 'invoice') {
    if (!canAddExtra) return res.status(403).json({ error: 'Forbidden' });
    const [cur] = await sql`
      SELECT e.*, d.title AS deal_title, d.po_number, c.name AS company_name
        FROM deal_extras e
        JOIN deals d ON d.id = e.deal_id
        LEFT JOIN companies c ON c.id = d.company_id
       WHERE e.id = ${id}`;
    if (!cur) return res.status(404).json({ error: 'Extra not found' });
    if (cur.payment_type !== 'po' || cur.status !== 'quoted') {
      return res.status(409).json({ error: 'This extra has no pending PO quote to invoice.' });
    }
    try {
      await createXeroInvoiceForDeal({
        dealId: cur.deal_id,
        contactName: cur.company_name,
        lineItems: [{ description: cur.description, quantity: 1, unitAmount: Number(cur.amount), vatRate: dealVatPercent(cur.vat_rate) }],
        reference: cur.po_number || undefined,
        extraIds: [cur.id], // flips 'quoted' → 'invoiced' + links the Xero id
      }, user);
    } catch (err) {
      console.error('[extras] invoice-from-quote failed', err);
      return res.status(err.status || 502).json({ error: 'Could not create invoice: ' + (err.message || 'unknown') });
    }
    // Best-effort: remove the now-superseded quote from Xero's active list.
    try { await voidQuote(cur.xero_quote_id); } catch (err) { console.warn('[extras] voidQuote failed', err.message); }
    const [row] = await sql`SELECT * FROM deal_extras WHERE id = ${id}`;
    return res.status(200).json(serialiseExtra(row));
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
    if (!['pending', 'quoted', 'invoiced', 'paid'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    // Stamp paid_at the first time it becomes 'paid' (keep an existing one); clear
    // it if moved back off 'paid'. Feeds Staff Commission's paid-extra bucketing.
    const paidAt = status === 'paid' ? (cur.paid_at || new Date().toISOString()) : null;
    const [row] = await sql`
      UPDATE deal_extras
         SET description = ${description}, amount = ${amount}, status = ${status},
             paid_at = ${paidAt}, updated_at = NOW()
       WHERE id = ${id}
      RETURNING *`;
    return res.status(200).json(serialiseExtra(row));
  }

  // DELETE /api/crm/extras/:id — a 'pending' extra, or a 'quoted' PO extra (whose
  // Xero quote is voided first), can be deleted. Once it's on an invoice
  // (invoiced/paid) it must be removed by voiding/deleting that invoice, which
  // releases the extra back to pending — so we never orphan a Xero line or
  // silently drop billed work.
  if (req.method === 'DELETE' && id) {
    const [cur] = await sql`SELECT status, created_by, xero_quote_id FROM deal_extras WHERE id = ${id}`;
    if (!cur) return res.status(200).json({ ok: true }); // already gone — idempotent
    // Finance can delete; whoever logged it can delete their own (to fix a
    // mistake) — but only while it's still pending/quoted (not yet invoiced).
    if (!canManage && cur.created_by !== user.email) return res.status(403).json({ error: 'Forbidden' });
    if (cur.status !== 'pending' && cur.status !== 'quoted') {
      return res.status(409).json({ error: 'This extra is on an invoice — void or delete that invoice first to remove it.' });
    }
    // Void the PO quote in Xero before dropping the row (best-effort).
    if (cur.status === 'quoted' && cur.xero_quote_id) {
      try { await voidQuote(cur.xero_quote_id); } catch (err) { console.warn('[extras] voidQuote on delete failed', err.message); }
    }
    await sql`DELETE FROM deal_extras WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
