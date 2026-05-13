// CRM invoices handler. Surfaces:
//
//  1) Xero invoices we know about (xero_invoice_id stored on payments,
//     partner_invoices, proposal_billing) — read-only, PDFs fetched via
//     the /api/xero/invoice-pdf passthrough.
//  2) manual_invoices uploaded by the team — full CRUD, PDFs stored in
//     Vercel Blob.
//
// Scoped by dealId (the only filter currently supported — contact/company
// rollups stay payment-only per the product spec).

import crypto from 'node:crypto';
import { put, del } from '@vercel/blob';
import sql from '../db.js';
import { makeId, trimOrNull, numberOrNull } from './shared.js';

export async function invoicesRoute(req, res, id, action, user) {
  // --- GET /api/crm/invoices?dealId=...
  if (!id && req.method === 'GET') {
    const dealId = trimOrNull(req.query.dealId);
    if (!dealId) return res.status(400).json({ error: 'dealId required' });

    const proposalRows = await sql`
      SELECT id, data FROM proposals WHERE deal_id = ${dealId}
    `;
    const proposalIds = proposalRows.map(r => r.id);
    const proposalMap = new Map(proposalRows.map(r => [r.id, r.data || {}]));

    const out = [];

    if (proposalIds.length) {
      const [stripeRows, partnerRows, billingRows] = await Promise.all([
        sql`SELECT proposal_id, amount, paid_at, xero_invoice_id, xero_payment_id
              FROM payments
              WHERE proposal_id = ANY(${proposalIds}) AND xero_invoice_id IS NOT NULL`,
        sql`SELECT id, proposal_id, amount, paid_at, xero_invoice_id, xero_payment_id
              FROM partner_invoices
              WHERE proposal_id = ANY(${proposalIds}) AND xero_invoice_id IS NOT NULL
              ORDER BY paid_at ASC`,
        sql`SELECT proposal_id, xero_invoice_id, created_at
              FROM proposal_billing
              WHERE proposal_id = ANY(${proposalIds}) AND xero_invoice_id IS NOT NULL`,
      ]);

      const proposalTitle = (pid) => proposalMap.get(pid)?.proposalTitle
        || proposalMap.get(pid)?.clientName
        || pid;

      for (const r of stripeRows) {
        out.push({
          id: 'xero:' + r.xero_invoice_id,
          source: 'xero',
          xeroInvoiceId: r.xero_invoice_id,
          proposalId: r.proposal_id,
          proposalTitle: proposalTitle(r.proposal_id),
          amount: r.amount != null ? Number(r.amount) : null,
          status: r.xero_payment_id ? 'paid' : 'authorised',
          issuedAt: r.paid_at,
          pdfUrl: '/api/xero/invoice-pdf?invoiceId=' + encodeURIComponent(r.xero_invoice_id),
        });
      }
      // Deduplicate any (proposal, xero_invoice_id) that also showed up via payments.
      const seen = new Set(stripeRows.map(r => r.xero_invoice_id));
      for (const r of partnerRows) {
        if (seen.has(r.xero_invoice_id)) continue;
        seen.add(r.xero_invoice_id);
        out.push({
          id: 'xero:' + r.xero_invoice_id,
          source: 'xero-partner',
          xeroInvoiceId: r.xero_invoice_id,
          proposalId: r.proposal_id,
          proposalTitle: proposalTitle(r.proposal_id),
          amount: r.amount != null ? Number(r.amount) : null,
          status: r.xero_payment_id ? 'paid' : 'authorised',
          issuedAt: r.paid_at,
          pdfUrl: '/api/xero/invoice-pdf?invoiceId=' + encodeURIComponent(r.xero_invoice_id),
        });
      }
      for (const r of billingRows) {
        if (seen.has(r.xero_invoice_id)) continue;
        seen.add(r.xero_invoice_id);
        out.push({
          id: 'xero:' + r.xero_invoice_id,
          source: 'xero-issued',
          xeroInvoiceId: r.xero_invoice_id,
          proposalId: r.proposal_id,
          proposalTitle: proposalTitle(r.proposal_id),
          amount: null,
          status: 'authorised',
          issuedAt: r.created_at,
          pdfUrl: '/api/xero/invoice-pdf?invoiceId=' + encodeURIComponent(r.xero_invoice_id),
        });
      }
    }

    const manualRows = await sql`
      SELECT id, proposal_id, deal_id, invoice_number, amount, issued_at, due_at,
             status, blob_url, filename, notes, uploaded_by, created_at
        FROM manual_invoices
        WHERE deal_id = ${dealId} OR proposal_id = ANY(${proposalIds.length ? proposalIds : ['__none__']})
        ORDER BY issued_at DESC NULLS LAST, created_at DESC
    `;
    for (const r of manualRows) {
      out.push({
        id: 'manual:' + r.id,
        source: 'manual',
        xeroInvoiceId: null,
        proposalId: r.proposal_id || null,
        proposalTitle: r.proposal_id ? (proposalMap.get(r.proposal_id)?.proposalTitle || proposalMap.get(r.proposal_id)?.clientName || r.proposal_id) : null,
        invoiceNumber: r.invoice_number || null,
        amount: r.amount != null ? Number(r.amount) : null,
        status: r.status,
        issuedAt: r.issued_at,
        dueAt: r.due_at,
        notes: r.notes || null,
        filename: r.filename || null,
        uploadedBy: r.uploaded_by || null,
        pdfUrl: r.blob_url,
      });
    }

    out.sort((a, b) => new Date(b.issuedAt || 0) - new Date(a.issuedAt || 0));
    return res.status(200).json(out);
  }

  // --- POST /api/crm/invoices — upload a manual invoice.
  // Multipart isn't used; we follow the deal_files pattern: raw bytes in the
  // body, metadata via headers. JSON fallback via ?meta= for callers that
  // can't set headers cleanly.
  if (!id && req.method === 'POST') {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(503).json({ error: 'File storage not configured' });
    }

    // Metadata comes via headers or query string (Content-Type is the file's
    // mime type so we can't put JSON in the body alongside the bytes).
    const filename = decodeURIComponent(req.headers['x-filename'] || 'invoice.pdf');
    const mimeType = req.headers['content-type'] || 'application/pdf';
    const meta = parseInvoiceMeta(req);
    const dealId = trimOrNull(meta.dealId);
    const proposalId = trimOrNull(meta.proposalId);
    if (!dealId && !proposalId) {
      return res.status(400).json({ error: 'dealId or proposalId required' });
    }

    let fileBuffer = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : null;
    if (!fileBuffer) {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      fileBuffer = Buffer.concat(chunks);
    }
    if (!fileBuffer || fileBuffer.length === 0) {
      return res.status(400).json({ error: 'No file data received' });
    }
    if (fileBuffer.length > 20 * 1024 * 1024) {
      return res.status(413).json({ error: 'File too large (max 20 MB)' });
    }

    // If only proposalId was supplied, look up its deal so the row still
    // joins back to the deal view by dealId.
    let resolvedDealId = dealId;
    if (!resolvedDealId && proposalId) {
      const [pr] = await sql`SELECT deal_id FROM proposals WHERE id = ${proposalId}`;
      resolvedDealId = pr?.deal_id || null;
    }

    const newId = makeId('inv');
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await put(`manual-invoices/${resolvedDealId || 'orphan'}/${newId}/${safeName}`, fileBuffer, {
      access: 'public', contentType: mimeType,
    });

    const status = ['issued', 'paid', 'void'].includes(meta.status) ? meta.status : 'issued';

    await sql`
      INSERT INTO manual_invoices (
        id, proposal_id, deal_id, invoice_number, amount, issued_at, due_at,
        status, blob_url, blob_pathname, filename, mime_type, size_bytes, notes,
        uploaded_by
      ) VALUES (
        ${newId},
        ${proposalId},
        ${resolvedDealId},
        ${trimOrNull(meta.invoiceNumber)},
        ${numberOrNull(meta.amount)},
        ${trimOrNull(meta.issuedAt) || new Date().toISOString().slice(0, 10)},
        ${trimOrNull(meta.dueAt)},
        ${status},
        ${blob.url},
        ${blob.pathname},
        ${filename},
        ${mimeType},
        ${fileBuffer.length},
        ${trimOrNull(meta.notes)},
        ${user.email || null}
      )
    `;

    const [row] = await sql`
      SELECT id, proposal_id, deal_id, invoice_number, amount, issued_at, due_at,
             status, blob_url, filename, notes, uploaded_by, created_at
        FROM manual_invoices WHERE id = ${newId}
    `;
    return res.status(201).json({
      id: 'manual:' + row.id,
      source: 'manual',
      xeroInvoiceId: null,
      proposalId: row.proposal_id,
      invoiceNumber: row.invoice_number || null,
      amount: row.amount != null ? Number(row.amount) : null,
      status: row.status,
      issuedAt: row.issued_at,
      dueAt: row.due_at,
      notes: row.notes,
      filename: row.filename || null,
      uploadedBy: row.uploaded_by || null,
      pdfUrl: row.blob_url,
    });
  }

  // --- PATCH /api/crm/invoices/:id — edit metadata (status, notes, etc.)
  if (id && req.method === 'PATCH') {
    const manualId = stripManualPrefix(id);
    const body = req.body || {};
    const cur = (await sql`SELECT * FROM manual_invoices WHERE id = ${manualId}`)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    if (user.role !== 'admin' && cur.uploaded_by !== user.email) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const next = {
      invoice_number: 'invoiceNumber' in body ? trimOrNull(body.invoiceNumber) : cur.invoice_number,
      amount:         'amount'        in body ? numberOrNull(body.amount)      : cur.amount,
      issued_at:      'issuedAt'      in body ? trimOrNull(body.issuedAt)      : cur.issued_at,
      due_at:         'dueAt'         in body ? trimOrNull(body.dueAt)         : cur.due_at,
      status:         'status'        in body && ['issued', 'paid', 'void'].includes(body.status) ? body.status : cur.status,
      notes:          'notes'         in body ? trimOrNull(body.notes)         : cur.notes,
    };
    await sql`
      UPDATE manual_invoices
         SET invoice_number = ${next.invoice_number},
             amount = ${next.amount},
             issued_at = ${next.issued_at},
             due_at = ${next.due_at},
             status = ${next.status},
             notes = ${next.notes},
             updated_at = NOW()
       WHERE id = ${manualId}
    `;
    return res.status(200).json({ ok: true });
  }

  // --- DELETE /api/crm/invoices/:id — remove DB row + Blob
  if (id && req.method === 'DELETE') {
    const manualId = stripManualPrefix(id);
    const cur = (await sql`SELECT blob_url, uploaded_by FROM manual_invoices WHERE id = ${manualId}`)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    if (user.role !== 'admin' && cur.uploaded_by !== user.email) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    try { await del(cur.blob_url); } catch (err) {
      console.error('[invoices] blob delete failed', err.message);
    }
    await sql`DELETE FROM manual_invoices WHERE id = ${manualId}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}

function parseInvoiceMeta(req) {
  const raw = req.headers['x-invoice-meta'] || req.query.meta || null;
  if (!raw) {
    return {
      dealId: req.query.dealId,
      proposalId: req.query.proposalId,
      invoiceNumber: req.query.invoiceNumber,
      amount: req.query.amount,
      issuedAt: req.query.issuedAt,
      dueAt: req.query.dueAt,
      status: req.query.status,
      notes: req.query.notes,
    };
  }
  try {
    const decoded = typeof raw === 'string'
      ? JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'))
      : raw;
    return decoded || {};
  } catch (err) {
    console.warn('[invoices] failed to parse x-invoice-meta header', err.message);
    return {};
  }
}

function stripManualPrefix(id) {
  return id.startsWith('manual:') ? id.slice('manual:'.length) : id;
}
