// CRM invoices handler. Surfaces:
//
//  1) Xero invoices we know about (xero_invoice_id stored on payments,
//     partner_invoices, proposal_billing) — read-only, PDFs fetched via
//     the /api/xero/invoice-pdf passthrough.
//  2) manual_invoices created by the team — full CRUD, optional PDF in
//     Vercel Blob, optional Stripe Payment Link.
//
// Scoped by dealId (the only filter currently supported — contact/company
// rollups stay payment-only per the product spec).

import { put, del, get as blobGet } from '@vercel/blob';
import sql from '../db.js';
import { advanceStage } from '../dealStage.js';
import { sendMail, invoicePaidHtml, APP_URL, adminEmailsExcluding } from '../email.js';
import { makeId, trimOrNull, numberOrNull } from './shared.js';
import { getOrCreateContact, createInvoice, createPayment, voidInvoice, getInvoiceByNumber, getInvoicesByIds } from '../xero.js';

export async function invoicesRoute(req, res, id, action, user) {
  // --- GET /api/crm/invoices/:id/pdf — streams a private Blob PDF back through
  // the API. Blob store is configured private; raw blob URLs aren't directly
  // accessible without auth, so we proxy via @vercel/blob's get().
  if (id && action === 'pdf' && req.method === 'GET') {
    const manualId = stripManualPrefix(id);
    const [row] = await sql`
      SELECT blob_url, blob_pathname, filename, mime_type
        FROM manual_invoices WHERE id = ${manualId}
    `;
    if (!row || (!row.blob_url && !row.blob_pathname)) {
      return res.status(404).json({ error: 'No PDF for this invoice' });
    }
    try {
      const result = await blobGet(row.blob_url || row.blob_pathname, { access: 'private' });
      if (!result || !result.stream) return res.status(404).json({ error: 'PDF not found' });
      res.setHeader('Content-Type', row.mime_type || result.blob?.contentType || 'application/pdf');
      const fname = (row.filename || 'invoice.pdf').replace(/"/g, '');
      res.setHeader('Content-Disposition', `inline; filename="${fname}"`);
      if (result.blob?.size) res.setHeader('Content-Length', String(result.blob.size));
      const reader = result.stream.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    } catch (err) {
      console.error('[invoices] blob get failed', err);
      return res.status(500).json({ error: 'Failed to fetch PDF' });
    }
  }

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
        sql`SELECT stripe_invoice_id, proposal_id, amount, paid_at, xero_invoice_id, xero_payment_id
              FROM partner_invoices
              WHERE proposal_id = ANY(${proposalIds}) AND xero_invoice_id IS NOT NULL
              ORDER BY paid_at ASC`,
        sql`SELECT proposal_id, xero_invoice_id, updated_at
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
          issuedAt: r.updated_at,
          pdfUrl: '/api/xero/invoice-pdf?invoiceId=' + encodeURIComponent(r.xero_invoice_id),
        });
      }
    }

    let manualRows = await sql`
      SELECT id, proposal_id, deal_id, invoice_number, amount, issued_at, due_at,
             status, blob_url, filename, notes, uploaded_by, created_at,
             stripe_payment_link_url, paid_at, payment_method, xero_invoice_id,
             currency, currency_rate
        FROM manual_invoices
        WHERE deal_id = ${dealId} OR proposal_id = ANY(${proposalIds.length ? proposalIds : ['__none__']})
        ORDER BY issued_at DESC NULLS LAST, created_at DESC
    `;

    // Sync status from Xero for any still-issued invoice we've linked. Xero's
    // Stripe integration pays invoices with no webhook to us, so this is how
    // we discover payments made via the embedded Xero "Pay now" button.
    const toSync = manualRows.filter(r => r.status === 'issued' && r.xero_invoice_id);
    if (toSync.length) {
      const updates = await syncFromXero(toSync, user);
      if (updates.size) {
        manualRows = manualRows.map(r => updates.has(r.id) ? { ...r, ...updates.get(r.id) } : r);
      }
    }

    for (const r of manualRows) {
      const xeroInvoiceId = r.xero_invoice_id || null;
      const xeroPdfUrl = xeroInvoiceId
        ? '/api/xero/invoice-pdf?invoiceId=' + encodeURIComponent(xeroInvoiceId)
        : null;
      // Blob store is private — serve PDFs through the authenticated proxy route.
      const blobPdfUrl = r.blob_url ? `/api/crm/invoices/${r.id}/pdf` : null;
      const currency = r.currency || 'GBP';
      const rate = r.currency_rate != null ? Number(r.currency_rate) : null;
      const amount = r.amount != null ? Number(r.amount) : null;
      // Xero's CurrencyRate is base-per-invoice-currency (e.g. 1 GBP = 1.1518
      // EUR), so to convert an invoice in EUR to GBP we divide by the rate.
      const gbpAmount = (currency !== 'GBP' && amount != null && rate)
        ? Number((amount / rate).toFixed(2))
        : null;
      out.push({
        id: 'manual:' + r.id,
        source: 'manual',
        xeroInvoiceId,
        proposalId: r.proposal_id || null,
        proposalTitle: r.proposal_id ? (proposalMap.get(r.proposal_id)?.proposalTitle || proposalMap.get(r.proposal_id)?.clientName || r.proposal_id) : null,
        invoiceNumber: r.invoice_number || null,
        amount,
        currency,
        gbpAmount,
        status: r.status,
        issuedAt: r.issued_at,
        dueAt: r.due_at,
        notes: r.notes || null,
        filename: r.filename || null,
        uploadedBy: r.uploaded_by || null,
        pdfUrl: blobPdfUrl || xeroPdfUrl,
        stripePaymentLinkUrl: r.stripe_payment_link_url || null,
        paidAt: r.paid_at || null,
        paymentMethod: r.payment_method || null,
      });
    }

    out.sort((a, b) => new Date(b.issuedAt || 0) - new Date(a.issuedAt || 0));
    return res.status(200).json(out);
  }

  // --- POST /api/crm/invoices (JSON) — create a Xero invoice with full line
  // items and store the resulting xero_invoice_id in manual_invoices.
  // This path is triggered when Content-Type is application/json, which the
  // CRM body parser will have already parsed into req.body.
  if (!id && req.method === 'POST' && (req.headers['content-type'] || '').startsWith('application/json')) {
    const body = req.body || {};
    const { dealId, proposalId, contactName, lineItems, invoiceNumber, issuedAt, dueAt } = body;

    if (!Array.isArray(lineItems) || !lineItems.length) {
      return res.status(400).json({ error: 'At least one line item required' });
    }
    if (!dealId && !proposalId) {
      return res.status(400).json({ error: 'dealId or proposalId required' });
    }

    let resolvedDealId = dealId || null;
    if (!resolvedDealId && proposalId) {
      const [pr] = await sql`SELECT deal_id FROM proposals WHERE id = ${proposalId}`;
      resolvedDealId = pr?.deal_id || null;
    }

    // Resolve Xero contact — prefer the explicit name sent from the UI.
    let xeroContactInfo = contactName?.trim()
      ? { name: contactName.trim(), email: null }
      : await resolveXeroContactInfo(resolvedDealId, proposalId);
    if (!xeroContactInfo?.name) {
      return res.status(400).json({ error: 'Could not determine client name for Xero invoice' });
    }
    const xeroContactId = await getOrCreateContact({
      name: xeroContactInfo.name,
      email: xeroContactInfo.email || undefined,
    });

    const xeroLineItems = lineItems.map(li => {
      const vat = Number(li.vatRate) || 0;
      return {
        description: String(li.description || '').trim(),
        quantity: Number(li.quantity) || 1,
        unitAmount: Number(Number(li.unitAmount || 0).toFixed(2)),
        taxType: vat > 0 ? 'OUTPUT2' : 'NONE',
        accountCode: '200',
        discountRate: li.discountRate ? Number(li.discountRate) : undefined,
      };
    });

    const { invoiceId: xeroInvoiceId, invoiceNumber: xeroInvoiceNumber } = await createInvoice({
      contactId: xeroContactId,
      lineItems: xeroLineItems,
      invoiceNumber: invoiceNumber?.trim() || undefined,
      issueDate: issuedAt || undefined,
      dueDate: dueAt || undefined,
    });
    // Use the number Xero assigned (covers auto-assign when field was left blank)
    const storedInvoiceNumber = xeroInvoiceNumber || trimOrNull(invoiceNumber);

    // Calculate inc-VAT total for our own record.
    const totalAmount = lineItems.reduce((sum, li) => {
      const qty = Number(li.quantity) || 1;
      const price = Number(li.unitAmount || 0);
      const disc = Number(li.discountRate || 0);
      const vat = Number(li.vatRate || 0);
      return sum + qty * price * (1 - disc / 100) * (1 + vat / 100);
    }, 0);

    const newId = makeId('inv');
    await sql`
      INSERT INTO manual_invoices (
        id, deal_id, proposal_id, invoice_number, amount,
        issued_at, due_at, status, notes, uploaded_by, xero_invoice_id
      ) VALUES (
        ${newId},
        ${resolvedDealId},
        ${trimOrNull(proposalId)},
        ${storedInvoiceNumber},
        ${Number(totalAmount.toFixed(2))},
        ${trimOrNull(issuedAt) || new Date().toISOString().slice(0, 10)},
        ${trimOrNull(dueAt)},
        'issued',
        ${lineItems.map(li => li.description).filter(Boolean).join(', ') || null},
        ${user.email || null},
        ${xeroInvoiceId}
      )
    `;

    const pdfUrl = '/api/xero/invoice-pdf?invoiceId=' + encodeURIComponent(xeroInvoiceId);
    return res.status(201).json({
      id: 'manual:' + newId,
      source: 'manual',
      xeroInvoiceId,
      invoiceNumber: trimOrNull(invoiceNumber),
      amount: Number(totalAmount.toFixed(2)),
      status: 'issued',
      pdfUrl,
    });
  }

  // --- POST /api/crm/invoices — create a manual invoice.
  // PDF is optional. If a file body is present, it is stored in Vercel Blob.
  // If no file is provided, a metadata-only invoice is created (blob_url = null).
  // Metadata comes via X-Invoice-Meta header (base64url JSON).
  if (!id && req.method === 'POST') {
    const filename = req.headers['x-filename']
      ? decodeURIComponent(req.headers['x-filename'])
      : null;
    const mimeType = req.headers['content-type'] || 'application/pdf';
    const meta = parseInvoiceMeta(req);
    const dealId = trimOrNull(meta.dealId);
    const proposalId = trimOrNull(meta.proposalId);
    if (!dealId && !proposalId) {
      return res.status(400).json({ error: 'dealId or proposalId required' });
    }

    // Read the body — may be empty for metadata-only invoices.
    let fileBuffer = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : null;
    if (!fileBuffer) {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      fileBuffer = raw.length > 0 ? raw : null;
    }

    // Must have either a file or an amount.
    if (!fileBuffer && !numberOrNull(meta.amount)) {
      return res.status(400).json({ error: 'Provide a PDF, an amount, or both' });
    }

    if (fileBuffer) {
      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        return res.status(503).json({ error: 'File storage not configured' });
      }
      if (fileBuffer.length > 20 * 1024 * 1024) {
        return res.status(413).json({ error: 'File too large (max 20 MB)' });
      }
    }

    // If only proposalId was supplied, look up its deal.
    let resolvedDealId = dealId;
    if (!resolvedDealId && proposalId) {
      const [pr] = await sql`SELECT deal_id FROM proposals WHERE id = ${proposalId}`;
      resolvedDealId = pr?.deal_id || null;
    }

    // When uploading a Xero invoice PDF, the filename is "Invoice INV-6049.pdf"
    // by default. Extract the invoice number from filename (or form input) and
    // look it up in Xero — it already exists there, so we link rather than push.
    // Uploads MUST contain an INV-NNNN pattern and MUST resolve to a Xero
    // invoice; otherwise it's not a Xero invoice PDF and we reject it.
    const invoiceNumberHint = trimOrNull(meta.invoiceNumber)
      || extractInvoiceNumber(filename);
    let xeroMatch = null;
    if (fileBuffer) {
      if (!invoiceNumberHint) {
        return res.status(400).json({
          error: 'This doesn\'t look like a Xero invoice PDF — no invoice number (INV-NNNN) found in the filename. Rename the file or enter the invoice number manually.',
        });
      }
      xeroMatch = await getInvoiceByNumber(invoiceNumberHint).catch(() => null);
      if (!xeroMatch) {
        return res.status(404).json({
          error: `Invoice ${invoiceNumberHint} was not found in Xero. Check the invoice number and try again.`,
        });
      }
    }

    const newId = makeId('inv');
    let blobUrl = null;
    let blobPathname = null;
    let storedFilename = null;
    let storedMime = null;
    let sizeBytes = null;

    if (fileBuffer) {
      const safeName = (filename || 'invoice.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
      const blob = await put(
        `manual-invoices/${resolvedDealId || 'orphan'}/${newId}/${safeName}`,
        fileBuffer,
        { access: 'private', contentType: mimeType },
      );
      blobUrl = blob.url;
      blobPathname = blob.pathname;
      storedFilename = filename || 'invoice.pdf';
      storedMime = mimeType;
      sizeBytes = fileBuffer.length;
    }

    // Reconcile form metadata with what Xero says — Xero is authoritative for
    // amount, dates, and paid status once we've matched. Form values still
    // take precedence if the user explicitly set them.
    const formStatus = ['issued', 'paid', 'void'].includes(meta.status) ? meta.status : null;
    const xeroDerivedStatus = xeroMatch?.status === 'PAID' ? 'paid'
      : xeroMatch?.status === 'VOIDED' ? 'void'
      : xeroMatch ? 'issued'
      : null;
    const status = formStatus || xeroDerivedStatus || 'issued';

    const formAmount = numberOrNull(meta.amount);
    const amount = formAmount != null ? formAmount : (xeroMatch?.total ?? null);

    const issuedAt = trimOrNull(meta.issuedAt) || xeroMatch?.issueDate || new Date().toISOString().slice(0, 10);
    const dueAt = trimOrNull(meta.dueAt) || xeroMatch?.dueDate || null;
    const storedInvoiceNumber = xeroMatch?.invoiceNumber || invoiceNumberHint || null;
    const linkedXeroInvoiceId = xeroMatch?.invoiceId || null;
    const currency = xeroMatch?.currency || 'GBP';
    const currencyRate = xeroMatch?.currencyRate ?? null;

    await sql`
      INSERT INTO manual_invoices (
        id, proposal_id, deal_id, invoice_number, amount, issued_at, due_at,
        status, blob_url, blob_pathname, filename, mime_type, size_bytes, notes,
        uploaded_by, xero_invoice_id, currency, currency_rate
      ) VALUES (
        ${newId},
        ${proposalId},
        ${resolvedDealId},
        ${storedInvoiceNumber},
        ${amount},
        ${issuedAt},
        ${dueAt},
        ${status},
        ${blobUrl},
        ${blobPathname},
        ${storedFilename},
        ${storedMime},
        ${sizeBytes},
        ${trimOrNull(meta.notes)},
        ${user.email || null},
        ${linkedXeroInvoiceId},
        ${currency},
        ${currencyRate}
      )
    `;

    // Optionally generate a Stripe Payment Link for the new invoice.
    let stripePaymentLinkUrl = null;
    if (meta.generateStripeLink === 'true' && amount > 0) {
      try {
        stripePaymentLinkUrl = await createStripePaymentLink({
          invoiceId: newId,
          invoiceNumber: storedInvoiceNumber,
          amount,
          dealId: resolvedDealId,
        });
      } catch (err) {
        console.error('[invoices] Stripe payment link creation failed', err.message);
      }
    }

    // PDF uploads represent invoices that already exist in Xero — link if we
    // found a match, otherwise log metadata-only without pushing a duplicate.
    // Only the no-file path (creating a brand-new invoice from the dashboard)
    // pushes to Xero.
    if (!fileBuffer) {
      const vatRate = numberOrNull(meta.vatRate) ?? 20;
      await pushInvoiceToXero({
        invoiceId: newId,
        dealId: resolvedDealId,
        proposalId,
        invoiceNumber: storedInvoiceNumber,
        amount,
        notes: trimOrNull(meta.notes),
        dueAt,
        vatRate,
      });
    }

    const [row] = await sql`
      SELECT id, proposal_id, deal_id, invoice_number, amount, issued_at, due_at,
             status, blob_url, filename, notes, uploaded_by, created_at,
             stripe_payment_link_url, paid_at, payment_method, xero_invoice_id,
             currency, currency_rate
        FROM manual_invoices WHERE id = ${newId}
    `;
    const xeroInvoiceId = row.xero_invoice_id || null;
    const xeroPdfUrl = xeroInvoiceId
      ? '/api/xero/invoice-pdf?invoiceId=' + encodeURIComponent(xeroInvoiceId)
      : null;
    const blobPdfUrl = row.blob_url ? `/api/crm/invoices/${row.id}/pdf` : null;
    const rspCurrency = row.currency || 'GBP';
    const rspRate = row.currency_rate != null ? Number(row.currency_rate) : null;
    const rspAmount = row.amount != null ? Number(row.amount) : null;
    const rspGbp = (rspCurrency !== 'GBP' && rspAmount != null && rspRate)
      ? Number((rspAmount / rspRate).toFixed(2))
      : null;
    return res.status(201).json({
      id: 'manual:' + row.id,
      source: 'manual',
      xeroInvoiceId,
      proposalId: row.proposal_id,
      invoiceNumber: row.invoice_number || null,
      amount: rspAmount,
      currency: rspCurrency,
      gbpAmount: rspGbp,
      status: row.status,
      issuedAt: row.issued_at,
      dueAt: row.due_at,
      notes: row.notes,
      filename: row.filename || null,
      uploadedBy: row.uploaded_by || null,
      pdfUrl: blobPdfUrl || xeroPdfUrl,
      stripePaymentLinkUrl: row.stripe_payment_link_url || null,
      paidAt: row.paid_at || null,
      paymentMethod: row.payment_method || null,
      autoLinked: !!linkedXeroInvoiceId,
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
      paid_at:        'paidAt'        in body ? trimOrNull(body.paidAt)        : cur.paid_at,
      payment_method: 'paymentMethod' in body ? trimOrNull(body.paymentMethod) : cur.payment_method,
    };
    await sql`
      UPDATE manual_invoices
         SET invoice_number  = ${next.invoice_number},
             amount          = ${next.amount},
             issued_at       = ${next.issued_at},
             due_at          = ${next.due_at},
             status          = ${next.status},
             notes           = ${next.notes},
             paid_at         = ${next.paid_at},
             payment_method  = ${next.payment_method},
             recorded_by     = COALESCE(recorded_by, ${user.email || null}),
             updated_at      = NOW()
       WHERE id = ${manualId}
    `;

    // First-time mark-paid: advance deal stage + send notification + record in Xero.
    if (next.status === 'paid' && cur.status !== 'paid') {
      const dealId = cur.deal_id;
      if (dealId) {
        try {
          await advanceStage(dealId, 'paid', {
            actorEmail: user.email || null,
            payload: { invoiceId: manualId, amount: next.amount, paymentMethod: next.payment_method, source: 'manual-invoice-paid' },
          });
        } catch (err) {
          console.error('[invoices] advanceStage failed', err);
        }

        try {
          const [dealRow] = await sql`SELECT title, owner_email FROM deals WHERE id = ${dealId}`;
          const ownerEmail = dealRow?.owner_email || null;
          const title = dealRow?.title || cur.invoice_number || manualId;
          const link = `${APP_URL}/crm?deal=${dealId}`;
          const others = await adminEmailsExcluding(ownerEmail);
          const all = [...(ownerEmail ? [ownerEmail] : []), ...others];
          if (all.length) {
            await sendMail({
              to: all,
              subject: `💰 Invoice paid: ${title}`,
              html: invoicePaidHtml({
                title,
                amount: next.amount != null ? Number(next.amount) : null,
                paymentMethod: next.payment_method,
                paidAt: next.paid_at,
                invoiceNumber: cur.invoice_number,
                link,
              }),
              text: `Invoice ${cur.invoice_number || manualId} marked paid via ${next.payment_method || 'manual'} — ${link}`,
            });
          }
        } catch (err) {
          console.error('[invoices] notify failed', err);
        }
      }

      // Record payment in Xero so the invoice transitions to PAID there too.
      if (cur.xero_invoice_id && next.amount) {
        await recordXeroPayment({
          xeroInvoiceId: cur.xero_invoice_id,
          amount: next.amount,
          paymentMethod: next.payment_method,
          paidAt: next.paid_at,
        });
      }
    }

    return res.status(200).json({ ok: true });
  }

  // --- DELETE /api/crm/invoices/:id — remove DB row + Blob + void in Xero
  if (id && req.method === 'DELETE') {
    const manualId = stripManualPrefix(id);
    const cur = (await sql`SELECT blob_url, uploaded_by, xero_invoice_id FROM manual_invoices WHERE id = ${manualId}`)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    if (user.role !== 'admin' && cur.uploaded_by !== user.email) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (cur.blob_url) {
      try { await del(cur.blob_url); } catch (err) {
        console.error('[invoices] blob delete failed', err.message);
      }
    }
    if (cur.xero_invoice_id) {
      try { await voidInvoice(cur.xero_invoice_id); } catch (err) {
        console.error('[invoices] xero void failed', err.message);
      }
    }
    await sql`DELETE FROM manual_invoices WHERE id = ${manualId}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}

// Looks up a Xero-compatible contact name + email from a deal's linked
// company/contact. Falls back to the deal title if nothing else is available.
async function resolveXeroContactInfo(dealId, proposalId) {
  let resolvedDealId = dealId;
  if (!resolvedDealId && proposalId) {
    const [pr] = await sql`SELECT deal_id FROM proposals WHERE id = ${proposalId}`;
    resolvedDealId = pr?.deal_id || null;
  }
  if (!resolvedDealId) return null;

  const [deal] = await sql`
    SELECT title, company_id, primary_contact_id FROM deals WHERE id = ${resolvedDealId}
  `;
  if (!deal) return null;

  let name = null;
  let email = null;
  if (deal.company_id) {
    const [co] = await sql`SELECT name FROM companies WHERE id = ${deal.company_id}`;
    if (co?.name) name = co.name;
  }
  if (deal.primary_contact_id) {
    const [ct] = await sql`SELECT name, email FROM contacts WHERE id = ${deal.primary_contact_id}`;
    if (ct?.email) email = ct.email;
    if (!name && ct?.name) name = ct.name;
  }
  if (!name) name = deal.title;
  return { name, email };
}

// Creates a Xero AUTHORISED invoice for a manual_invoice row and persists the
// resulting xero_invoice_id. Non-blocking — catches and logs on failure.
async function pushInvoiceToXero({ invoiceId, dealId, proposalId, invoiceNumber, amount, notes, dueAt, vatRate }) {
  if (!amount || amount <= 0) return;
  try {
    const contactInfo = await resolveXeroContactInfo(dealId, proposalId);
    if (!contactInfo) {
      console.warn('[invoices] xero: no contact found — skipping push');
      return;
    }
    const contactId = await getOrCreateContact({ name: contactInfo.name, email: contactInfo.email || undefined });
    const vat = Number(vatRate) || 0;
    const isVat = vat > 0;
    // Treat stored amount as inc-VAT; back-calculate ex-VAT for Xero.
    const unitAmount = isVat
      ? Number((amount / (1 + vat / 100)).toFixed(2))
      : Number(Number(amount).toFixed(2));
    const { invoiceId: xeroInvoiceId } = await createInvoice({
      contactId,
      lineItems: [{
        description: notes || (invoiceNumber ? `Invoice ${invoiceNumber}` : 'Squideo Services'),
        quantity: 1,
        unitAmount,
        taxType: isVat ? 'OUTPUT2' : 'NONE',
        accountCode: '200',
      }],
      reference: invoiceNumber || undefined,
      dueDate: dueAt || undefined,
    });
    await sql`UPDATE manual_invoices SET xero_invoice_id = ${xeroInvoiceId} WHERE id = ${invoiceId}`;
  } catch (err) {
    console.error('[invoices] xero push failed', err.message);
  }
}

// Records a payment against an existing Xero invoice, transitioning it to PAID.
// Skips silently if the appropriate account code env var is not configured.
async function recordXeroPayment({ xeroInvoiceId, amount, paymentMethod, paidAt }) {
  const isStripe = paymentMethod === 'stripe-link';
  const accountCode = isStripe
    ? (process.env.XERO_STRIPE_CLEARING_CODE || null)
    : (process.env.XERO_BANK_ACCOUNT_CODE || null);
  if (!accountCode) {
    console.warn('[invoices] xero payment: no account code env var for method', paymentMethod, '— skipping');
    return;
  }
  try {
    const date = paidAt
      ? new Date(paidAt).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    await createPayment({
      invoiceId: xeroInvoiceId,
      accountCode,
      amount: Number(Number(amount).toFixed(2)),
      date,
      reference: paymentMethod || undefined,
    });
  } catch (err) {
    console.error('[invoices] xero payment recording failed', err.message);
  }
}

// Creates a Stripe Payment Link for a manual invoice and persists the URL.
// Returns the payment link URL on success; throws on failure.
async function createStripePaymentLink({ invoiceId, invoiceNumber, amount, dealId }) {
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const label = invoiceNumber ? `Invoice ${invoiceNumber}` : 'Squideo Invoice';
  const link = await stripe.paymentLinks.create({
    line_items: [{
      price_data: {
        currency: 'gbp',
        product_data: { name: label },
        unit_amount: Math.round(amount * 100),
      },
      quantity: 1,
    }],
    metadata: {
      manual_invoice_id: invoiceId,
      deal_id: dealId || '',
    },
  });
  await sql`
    UPDATE manual_invoices
       SET stripe_payment_link_id  = ${link.id},
           stripe_payment_link_url = ${link.url},
           updated_at = NOW()
     WHERE id = ${invoiceId}
  `;
  return link.url;
}

// Polls Xero for the current status of issued+linked manual_invoices and
// applies any transitions to PAID/VOIDED. Returns a Map keyed by manual_invoice
// id with the patched columns so the caller can splice them into its response.
async function syncFromXero(rows, user) {
  const updates = new Map();
  const lookup = await getInvoicesByIds(rows.map(r => r.xero_invoice_id));
  if (!lookup.size) return updates;

  for (const row of rows) {
    const xero = lookup.get(row.xero_invoice_id);
    if (!xero) continue;
    if (xero.status === 'PAID' && row.status !== 'paid') {
      const paidAt = xero.fullyPaidOn || new Date().toISOString().slice(0, 10);
      const amount = xero.total ?? row.amount;
      const currency = xero.currency || row.currency || 'GBP';
      const currencyRate = xero.currencyRate ?? row.currency_rate ?? null;
      // Conditional update so only one concurrent request fires the notification.
      const result = await sql`
        UPDATE manual_invoices
           SET status = 'paid',
               paid_at = ${paidAt},
               payment_method = COALESCE(payment_method, 'xero'),
               amount = COALESCE(amount, ${amount}),
               currency = ${currency},
               currency_rate = COALESCE(${currencyRate}, currency_rate),
               updated_at = NOW()
         WHERE id = ${row.id} AND status = 'issued'
         RETURNING id
      `;
      updates.set(row.id, { status: 'paid', paid_at: paidAt, payment_method: row.payment_method || 'xero', amount: row.amount ?? amount, currency, currency_rate: currencyRate ?? row.currency_rate });
      if (result.length) {
        // We won the race — fire notification + deal-stage advance.
        notifyInvoicePaid({ row, paidAt, amount, user }).catch(err => console.error('[invoices] sync notify failed', err));
      }
    } else if (xero.status === 'VOIDED' && row.status !== 'void') {
      await sql`UPDATE manual_invoices SET status = 'void', updated_at = NOW() WHERE id = ${row.id} AND status != 'void'`;
      updates.set(row.id, { status: 'void' });
    }
  }
  return updates;
}

// Sends the "invoice paid" notification email and advances the deal stage.
// Used by both the PATCH mark-paid path and the GET-time Xero sync.
async function notifyInvoicePaid({ row, paidAt, amount, paymentMethod = 'xero', user = {} }) {
  const dealId = row.deal_id;
  if (!dealId) return;
  try {
    await advanceStage(dealId, 'paid', {
      actorEmail: user?.email || null,
      payload: { invoiceId: row.id, amount, paymentMethod, source: 'xero-sync' },
    });
  } catch (err) {
    console.error('[invoices] advanceStage failed', err);
  }
  try {
    const [dealRow] = await sql`SELECT title, owner_email FROM deals WHERE id = ${dealId}`;
    const ownerEmail = dealRow?.owner_email || null;
    const title = dealRow?.title || row.invoice_number || row.id;
    const link = `${APP_URL}/crm?deal=${dealId}`;
    const others = await adminEmailsExcluding(ownerEmail);
    const all = [...(ownerEmail ? [ownerEmail] : []), ...others];
    if (!all.length) return;
    await sendMail({
      to: all,
      subject: `💰 Invoice paid: ${title}`,
      html: invoicePaidHtml({
        title,
        amount: amount != null ? Number(amount) : null,
        paymentMethod,
        paidAt,
        invoiceNumber: row.invoice_number,
        link,
      }),
      text: `Invoice ${row.invoice_number || row.id} paid via ${paymentMethod} — ${link}`,
    });
  } catch (err) {
    console.error('[invoices] notify failed', err);
  }
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

// Xero's default PDF filename is "Invoice INV-NNNN.pdf". Pull the invoice
// number out so we can match the upload to its Xero record.
function extractInvoiceNumber(filename) {
  if (!filename) return null;
  const m = String(filename).match(/INV-\d{3,}/i);
  return m ? m[0].toUpperCase() : null;
}
